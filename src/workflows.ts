import {
  allHandlersFinished,
  condition,
  defineQuery,
  defineUpdate,
  proxyActivities,
  setHandler,
  uuid4,
} from "@temporalio/workflow";
import type * as activities from "./activities";
import type {
  CancelInput,
  Candidate,
  ClientTextKind,
  ClientView,
  OfferAttempt,
  Opening,
  OpeningResult,
  Phase,
  RespondInput,
  RespondResult,
  SimulatedMessage,
  StaffView,
  TimelineEntry,
} from "./types";

// Texts and lookups are retried automatically. A failed send never skips a client
// or loses the opening; the Workflow simply waits until the step succeeds.
const { findEligibleClients, sendClientText, notifyFrontDesk } = proxyActivities<typeof activities>({
  startToCloseTimeout: "30 seconds",
  retry: { initialInterval: "2 seconds", backoffCoefficient: 2, maximumInterval: "1 minute" },
});

/** Staff screen: who has the offer, when it expires, who declined or timed out, who is next. */
export const getStaffView = defineQuery<StaffView>("getStaffView");
/** Client screen: only that client's own offer, looked up by the secret token in their link. */
export const getClientView = defineQuery<ClientView | null, [string]>("getClientView");
/** A client taps Accept or Decline. Returns right away whether they got the spot. */
export const respondToOffer = defineUpdate<RespondResult, [RespondInput]>("respondToOffer");
/** Staff stop the process (walk-in took the spot, stylist unavailable, ...). */
export const cancelOpening = defineUpdate<StaffView, [CancelInput]>("cancelOpening");

const UNAVAILABLE =
  "Sorry, this opening is no longer available. You're still on our waitlist and we'll reach out about the next one.";

function describeWindow(seconds: number): string {
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/**
 * One Workflow per open slot. It offers the slot to one eligible client at a time,
 * in waitlist order, and gives each a fixed reply window. Durable timers mean the
 * offer and its deadline survive restarts; Updates are handled one at a time, so
 * the slot can never be promised to two people.
 */
export async function openingWorkflow(opening: Opening): Promise<OpeningResult> {
  let phase: Phase = "matching";
  let candidates: Candidate[] = [];
  let nextIndex = 0;
  let current: OfferAttempt | undefined;
  let outcomeReason: string | undefined;
  let cancelReason: string | undefined;
  let filledBy: OfferAttempt | undefined;
  const attempts: OfferAttempt[] = [];
  const phones = new Map<string, string>();
  const timeline: TimelineEntry[] = [];
  const messages: SimulatedMessage[] = [];

  const now = () => new Date().toISOString();
  const note = (text: string, tone: TimelineEntry["tone"] = "info") => timeline.push({ at: now(), text, tone });
  const isClosed = () => phase === "filled" || phase === "not_filled" || phase === "cancelled";

  const sentKeys = new Set<string>();
  async function text(attempt: OfferAttempt, kind: ClientTextKind): Promise<void> {
    const idempotencyKey = `${opening.openingId}:${attempt.token}:${kind}`;
    if (sentKeys.has(idempotencyKey)) return; // never text the same thing twice
    sentKeys.add(idempotencyKey);
    const result = await sendClientText({
      kind,
      idempotencyKey,
      client: { clientId: attempt.clientId, name: attempt.name, phone: phones.get(attempt.clientId) ?? "" },
      opening,
      offerToken: kind === "offer" ? attempt.token : undefined,
      expiresAt: attempt.expiresAt,
    });
    messages.push({ at: result.sentAt, audience: "client", clientId: attempt.clientId, body: result.body });
  }

  const staffView = (): StaffView => ({
    opening,
    phase,
    currentOffer: phase === "offering" ? current : undefined,
    attempts,
    upNext: phase === "offering" || phase === "matching" ? candidates.slice(nextIndex).map((c) => ({ name: c.name })) : [],
    matchedCount: candidates.length,
    outcomeReason,
    filledBy: filledBy ? { name: filledBy.name, phoneLast4: filledBy.phoneLast4 } : undefined,
    cancelReason,
    timeline,
    frontDeskMessages: messages.filter((m) => m.audience === "front_desk"),
  });

  setHandler(getStaffView, staffView);

  setHandler(getClientView, (token: string): ClientView | null => {
    const attempt = attempts.find((a) => a.token === token);
    if (!attempt) return null;
    const live = attempt === current && phase === "offering";
    const status: ClientView["status"] =
      attempt.outcome === "accepted"
        ? "accepted"
        : attempt.outcome === "declined"
          ? "declined"
          : live && attempt.outcome === "waiting"
            ? "open"
            : live && attempt.outcome === "sending"
              ? "pending"
              : "unavailable";
    return {
      firstName: attempt.name.split(" ")[0],
      service: opening.service,
      stylist: opening.stylist,
      startsAt: opening.startsAt,
      status,
      expiresAt: status === "open" ? attempt.expiresAt : undefined,
      messages: messages
        .filter((m) => m.audience === "client" && m.clientId === attempt.clientId)
        .map(({ at, body }) => ({ at, body })),
    };
  });

  setHandler(
    respondToOffer,
    async ({ token, choice }: RespondInput): Promise<RespondResult> => {
      const attempt = attempts.find((a) => a.token === token)!;
      const deadlinePassed = !attempt.expiresAt || Date.now() >= Date.parse(attempt.expiresAt);
      const canStillAnswer =
        attempt === current &&
        (attempt.outcome === "waiting" || attempt.outcome === "sending") &&
        phase === "offering" &&
        !deadlinePassed;

      if (attempt.outcome === "accepted") {
        return { status: "accepted", message: "You already have this spot. See you then!" };
      }
      if (canStillAnswer && choice === "accept") {
        // Claimed synchronously inside the Workflow: no second person can get here.
        attempt.outcome = "accepted";
        attempt.respondedAt = now();
        phase = "filled";
        filledBy = attempt;
        note(`${attempt.name} accepted the opening.`, "good");
        return { status: "accepted", message: "You're booked! A confirmation text is on its way." };
      }
      if (canStillAnswer && choice === "decline") {
        attempt.outcome = "declined";
        attempt.respondedAt = now();
        note(`${attempt.name} said no thanks. They stay on the waitlist.`);
        return {
          status: "declined",
          message: "No problem, thanks for letting us know. You're still on our waitlist for future openings.",
        };
      }
      if (choice === "decline") {
        return { status: "declined", message: "Thanks for letting us know. You're still on our waitlist." };
      }
      // A "yes" after the offer moved on, was withdrawn, or the slot was filled.
      note(`${attempt.name} replied "yes" too late and was told politely the spot is gone.`, "warn");
      await text(attempt, "no_longer_available");
      return { status: "unavailable", message: UNAVAILABLE };
    },
    {
      validator: ({ token, choice }: RespondInput) => {
        if (choice !== "accept" && choice !== "decline") throw new Error("Choose accept or decline.");
        if (!attempts.some((a) => a.token === token)) throw new Error("This offer link isn't valid.");
      },
    },
  );

  setHandler(
    cancelOpening,
    ({ reason }: CancelInput): StaffView => {
      cancelReason = reason || "Cancelled by staff";
      phase = "cancelled";
      outcomeReason = `Stopped by staff: ${cancelReason}.`;
      note(`Staff stopped this opening (${cancelReason}). Nobody else can claim it.`, "warn");
      return staffView();
    },
    {
      validator: (_input: CancelInput) => {
        if (isClosed()) throw new Error("This opening is already closed.");
      },
    },
  );

  // 1. Find who fits, in waitlist order.
  note(`Opening added: ${opening.service} with ${opening.stylist}.`);
  candidates = await findEligibleClients(opening);
  for (const c of candidates) phones.set(c.clientId, c.phone);
  if (!isClosed()) {
    note(
      candidates.length
        ? `${candidates.length} waitlisted ${candidates.length === 1 ? "client fits" : "clients fit"} this service, stylist and time.`
        : "Nobody on the waitlist fits this service, stylist and time.",
    );
  }

  // 2. Offer to one person at a time.
  const windowMs = opening.replyWindowSeconds * 1000;
  const startsAtMs = Date.parse(opening.startsAt);

  while (!isClosed() && nextIndex < candidates.length) {
    if (Date.now() >= startsAtMs) {
      phase = "not_filled";
      outcomeReason = "The appointment time arrived before anyone accepted.";
      break;
    }
    const candidate = candidates[nextIndex++];
    const attempt: OfferAttempt = {
      clientId: candidate.clientId,
      name: candidate.name,
      phoneLast4: candidate.phone.slice(-4),
      token: uuid4(),
      outcome: "sending",
    };
    attempts.push(attempt);
    current = attempt;
    phase = "offering";

    // The reply window starts once the text has actually gone out.
    attempt.expiresAt = new Date(Math.min(Date.now() + windowMs, startsAtMs)).toISOString();
    await text(attempt, "offer");
    if (isClosed()) break;
    attempt.offeredAt = now();
    if (attempt.outcome === "sending") {
      attempt.expiresAt = new Date(Math.min(Date.now() + windowMs, startsAtMs)).toISOString();
      attempt.outcome = "waiting";
    }
    note(`Offered to ${attempt.name}. They have ${describeWindow(opening.replyWindowSeconds)} to reply.`);

    // Durable timer: survives Worker restarts, server restarts and closed laptops.
    await condition(
      () => attempt.outcome !== "waiting" || isClosed(),
      Math.max(0, Date.parse(attempt.expiresAt) - Date.now()),
    );

    if (attempt.outcome === "declined") {
      await text(attempt, "decline_ack");
    } else if (attempt.outcome === "waiting" && !isClosed()) {
      attempt.outcome = "timed_out";
      note(`${attempt.name} didn't reply in time. Moving on.`, "warn");
    }
  }

  // 3. Wrap up. (Handlers may have changed the phase while we waited.)
  const ending = phase as Phase;
  if (ending === "filled" && filledBy) {
    await text(filledBy, "confirmed");
    const notice = await notifyFrontDesk({
      idempotencyKey: `${opening.openingId}:front-desk`,
      opening,
      clientName: filledBy.name,
    });
    messages.push({ at: notice.sentAt, audience: "front_desk", body: notice.body });
    note("Confirmation sent and front desk notified. Next step: add it to Square.", "good");
  } else if (ending === "cancelled") {
    if (current && (current.outcome === "waiting" || current.outcome === "sending")) {
      current.outcome = "withdrawn";
      await text(current, "no_longer_available");
    }
  } else {
    if (ending !== "not_filled") {
      phase = "not_filled";
      outcomeReason = candidates.length
        ? "Everyone who fit either declined or didn't reply in time."
        : "Nobody on the waitlist fits this service, stylist and time.";
    }
    note(`Not filled. ${outcomeReason}`, "warn");
  }

  // Let any late replies finish getting their polite answer before closing.
  await condition(allHandlersFinished);
  return { openingId: opening.openingId, phase, filledBy: filledBy?.name, reason: outcomeReason };
}
