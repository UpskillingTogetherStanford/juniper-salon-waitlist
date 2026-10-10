import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { TestWorkflowEnvironment } from "@temporalio/testing";
import { Worker } from "@temporalio/worker";
import { matchWaitlist } from "../src/salon";
import type { Candidate, ClientTextInput, Opening, StaffView, WaitlistEntry } from "../src/types";
import { cancelOpening, getClientView, getStaffView, openingWorkflow, respondToOffer } from "../src/workflows";

// Runs a real local Temporal dev server (downloaded automatically, no Docker needed).
// Set TEMPORAL_CLI_PATH to use a Temporal CLI binary you already have.
let env: TestWorkflowEnvironment;
before(async () => {
  env = await TestWorkflowEnvironment.createLocal(
    process.env.TEMPORAL_CLI_PATH
      ? { server: { executable: { type: "existing-path", path: process.env.TEMPORAL_CLI_PATH } } }
      : undefined,
  );
});
after(async () => {
  await env?.teardown();
});

const people: Candidate[] = [
  { clientId: "a", name: "Ana First", phone: "+15550000001", joinedAt: "2026-09-01T00:00:00Z" },
  { clientId: "b", name: "Ben Second", phone: "+15550000002", joinedAt: "2026-09-02T00:00:00Z" },
  { clientId: "c", name: "Cy Third", phone: "+15550000003", joinedAt: "2026-09-03T00:00:00Z" },
];

let counter = 0;
async function runOpening(
  candidates: Candidate[],
  replyWindowSeconds: number,
  scenario: (ctx: {
    handle: Awaited<ReturnType<TestWorkflowEnvironment["client"]["workflow"]["start"]>>;
    texts: ClientTextInput[];
    frontDesk: string[];
    waitFor: (check: (view: StaffView) => boolean) => Promise<StaffView>;
  }) => Promise<void>,
): Promise<void> {
  const taskQueue = `test-${++counter}-${Date.now()}`;
  const texts: ClientTextInput[] = [];
  const frontDesk: string[] = [];
  const worker = await Worker.create({
    connection: env.nativeConnection,
    taskQueue,
    workflowsPath: require.resolve("../src/workflows"),
    activities: {
      findEligibleClients: async () => candidates,
      sendClientText: async (input: ClientTextInput) => {
        texts.push(input);
        return { body: `${input.kind} for ${input.client.name}`, sentAt: new Date().toISOString() };
      },
      notifyFrontDesk: async (input: { clientName: string }) => {
        frontDesk.push(input.clientName);
        return { body: `Filled by ${input.clientName}`, sentAt: new Date().toISOString() };
      },
    },
  });
  const opening: Opening = {
    openingId: taskQueue,
    service: "Haircut",
    stylist: "Rosa",
    startsAt: new Date(Date.now() + 3600_000).toISOString(),
    replyWindowSeconds,
    createdAt: new Date().toISOString(),
  };
  await worker.runUntil(async () => {
    const handle = await env.client.workflow.start(openingWorkflow, {
      workflowId: opening.openingId,
      taskQueue,
      args: [opening],
    });
    const waitFor = async (check: (view: StaffView) => boolean) => {
      for (let i = 0; i < 200; i++) {
        const view = await handle.query(getStaffView);
        if (check(view)) return view;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error("Timed out waiting for the Workflow");
    };
    await scenario({ handle, texts, frontDesk, waitFor });
  });
}

test("offers one client at a time in waitlist order; a decline moves on; an accept fills it", async () => {
  await runOpening(people, 60, async ({ handle, texts, frontDesk, waitFor }) => {
    const first = await waitFor((v) => v.currentOffer?.outcome === "waiting");
    assert.equal(first.currentOffer?.name, "Ana First");
    assert.deepEqual(first.upNext.map((p) => p.name), ["Ben Second", "Cy Third"]);
    assert.equal(texts.filter((t) => t.kind === "offer").length, 1, "only one person is offered at a time");

    const declined = await handle.executeUpdate(respondToOffer, {
      args: [{ token: first.currentOffer!.token, choice: "decline" }],
    });
    assert.equal(declined.status, "declined");

    const second = await waitFor((v) => v.currentOffer?.name === "Ben Second" && v.currentOffer.outcome === "waiting");
    const accepted = await handle.executeUpdate(respondToOffer, {
      args: [{ token: second.currentOffer!.token, choice: "accept" }],
    });
    assert.equal(accepted.status, "accepted");

    const result = await handle.result();
    assert.equal(result.phase, "filled");
    assert.equal(result.filledBy, "Ben Second");
    assert.deepEqual(frontDesk, ["Ben Second"]);
    assert.ok(texts.some((t) => t.kind === "confirmed" && t.client.clientId === "b"));
    assert.ok(texts.some((t) => t.kind === "decline_ack" && t.client.clientId === "a"));
    assert.ok(!texts.some((t) => t.client.clientId === "c"), "Cy was never contacted");
  });
});

test("no reply in time moves to the next person, and a late yes cannot claim the spot", async () => {
  await runOpening(people, 2, async ({ handle, texts, waitFor }) => {
    const first = await waitFor((v) => v.currentOffer?.outcome === "waiting");
    const firstToken = first.currentOffer!.token;
    const moved = await waitFor((v) => v.currentOffer?.name === "Ben Second");
    assert.equal(moved.attempts[0].outcome, "timed_out");

    const late = await handle.executeUpdate(respondToOffer, { args: [{ token: firstToken, choice: "accept" }] });
    assert.equal(late.status, "unavailable");
    assert.ok(texts.some((t) => t.kind === "no_longer_available" && t.client.clientId === "a"));

    const ana = await handle.query(getClientView, firstToken);
    assert.equal(ana?.status, "unavailable");
    assert.ok(ana?.messages.every((m) => !m.body.includes("Ben")), "Ana never sees other clients");

    const result = await handle.result();
    assert.equal(result.phase, "not_filled");
  });
});

test("staff can stop an opening, and nobody can claim it afterwards", async () => {
  await runOpening(people, 60, async ({ handle, texts, waitFor }) => {
    const first = await waitFor((v) => v.currentOffer?.outcome === "waiting");
    await handle.executeUpdate(cancelOpening, { args: [{ reason: "Walk-in took the spot" }] });
    const late = await handle
      .executeUpdate(respondToOffer, { args: [{ token: first.currentOffer!.token, choice: "accept" }] })
      .catch(() => ({ status: "unavailable" }));
    assert.equal(late.status, "unavailable");
    const result = await handle.result();
    assert.equal(result.phase, "cancelled");
    assert.ok(texts.some((t) => t.kind === "no_longer_available" && t.client.clientId === "a"));
    assert.equal(texts.filter((t) => t.kind === "offer").length, 1);
  });
});

test("with nobody on the waitlist who fits, the opening is marked not filled with a reason", async () => {
  await runOpening([], 60, async ({ handle }) => {
    const result = await handle.result();
    assert.equal(result.phase, "not_filled");
    assert.match(result.reason ?? "", /Nobody on the waitlist fits/);
  });
});

test("waitlist matching uses service, stylist preference, day/time, then who joined first", () => {
  const base = { phone: "+1555", days: ["Fri"], earliest: "09:00", latest: "18:00" };
  const entries: WaitlistEntry[] = [
    { ...base, clientId: "late", name: "Joined Later", service: "Haircut", stylistPreference: "Any", joinedAt: "2026-09-05T00:00:00Z" },
    { ...base, clientId: "early", name: "Joined Earlier", service: "Haircut", stylistPreference: "Rosa", joinedAt: "2026-09-01T00:00:00Z" },
    { ...base, clientId: "other-stylist", name: "Wants Ava", service: "Haircut", stylistPreference: "Ava", joinedAt: "2026-08-01T00:00:00Z" },
    { ...base, clientId: "color", name: "Wants Color", service: "Color", stylistPreference: "Any", joinedAt: "2026-08-01T00:00:00Z" },
    { ...base, clientId: "evenings", name: "Evenings Only", service: "Haircut", stylistPreference: "Any", earliest: "17:00", joinedAt: "2026-08-01T00:00:00Z" },
  ];
  // Friday Oct 9, 2026 at 3:30 PM in Los Angeles
  const matched = matchWaitlist(entries, { service: "Haircut", stylist: "Rosa", startsAt: "2026-10-09T22:30:00Z" }, "America/Los_Angeles");
  assert.deepEqual(matched.map((c) => c.clientId), ["early", "late"]);
});
