// Activities are the steps that touch the outside world. Temporal retries them
// automatically if they fail, so a flaky text provider never loses an offer.
import { appendFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { ApplicationFailure } from "@temporalio/activity";
import { SALON_NAME, firstName, formatTime, formatWhen, matchWaitlist } from "./salon";
import type { Candidate, ClientTextInput, Opening, WaitlistEntry } from "./types";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const OUTBOX_DIR = process.env.OUTBOX_DIR ?? path.join(process.cwd(), ".data");
const OUTBOX_FILE = path.join(OUTBOX_DIR, "simulated-outbox.jsonl");
const APP_URL = process.env.APP_URL ?? `http://localhost:${process.env.PORT ?? 3000}`;
const FAILURE_RATE = Number(process.env.SIMULATED_TEXT_FAILURE_RATE ?? 0);

/** Reads the waitlist (a local stand-in for the salon's Google Sheet) and applies Lena's rules. */
export async function findEligibleClients(opening: Opening): Promise<Candidate[]> {
  const raw = await readFile(path.join(DATA_DIR, "waitlist.json"), "utf8");
  const entries = JSON.parse(raw) as WaitlistEntry[];
  return matchWaitlist(entries, opening);
}

function composeClientText(input: ClientTextInput): string {
  const { opening, client } = input;
  const name = firstName(client.name);
  const when = formatWhen(opening.startsAt);
  switch (input.kind) {
    case "offer":
      return (
        `Hi ${name}, it's ${SALON_NAME}. A ${opening.service} spot just opened with ` +
        `${opening.stylist} on ${when}. It isn't booked yet. Tap to accept or decline ` +
        `by ${formatTime(input.expiresAt ?? opening.startsAt)}: ` +
        `${APP_URL}/offer.html?opening=${encodeURIComponent(opening.openingId)}&token=${input.offerToken}`
      );
    case "confirmed":
      return (
        `You're all set, ${name}! ${opening.service} with ${opening.stylist} on ${when} ` +
        `is yours. We look forward to seeing you. – ${SALON_NAME}`
      );
    case "decline_ack":
      return (
        `No problem, ${name}. Thanks for letting us know. You're still on our waitlist ` +
        `and we'll reach out when another spot opens. – ${SALON_NAME}`
      );
    case "no_longer_available":
      return (
        `Thanks, ${name}. Sorry, the ${when} opening is no longer available. You're ` +
        `still on our waitlist and we'll be in touch about the next one. – ${SALON_NAME}`
      );
  }
}

async function alreadySent(idempotencyKey: string): Promise<boolean> {
  try {
    const lines = (await readFile(OUTBOX_FILE, "utf8")).split("\n");
    return lines.some((line) => line.includes(`"idempotencyKey":"${idempotencyKey}"`));
  } catch {
    return false;
  }
}

async function recordInOutbox(record: Record<string, unknown>): Promise<void> {
  await mkdir(OUTBOX_DIR, { recursive: true });
  await appendFile(OUTBOX_FILE, `${JSON.stringify(record)}\n`);
}

/**
 * SIMULATED: stands in for an SMS provider. It writes the text to a local outbox
 * file instead of sending it. Set SIMULATED_TEXT_FAILURE_RATE=0.5 to watch
 * Temporal retry failed sends in the Web UI.
 */
export async function sendClientText(input: ClientTextInput): Promise<{ body: string; sentAt: string }> {
  const body = composeClientText(input);
  if (!(await alreadySent(input.idempotencyKey))) {
    if (Math.random() < FAILURE_RATE) {
      throw ApplicationFailure.retryable("Simulated text provider outage");
    }
    await recordInOutbox({
      simulated: true,
      idempotencyKey: input.idempotencyKey,
      to: input.client.phone,
      body,
      at: new Date().toISOString(),
    });
    console.log(`[SIMULATED TEXT → ${input.client.name}] ${body}`);
  }
  return { body, sentAt: new Date().toISOString() };
}

/** SIMULATED: stands in for a message to the front desk (for example, a shared tablet or group chat). */
export async function notifyFrontDesk(input: {
  idempotencyKey: string;
  opening: Opening;
  clientName: string;
}): Promise<{ body: string; sentAt: string }> {
  const { opening } = input;
  const body =
    `Opening filled: ${input.clientName} accepted ${opening.service} with ${opening.stylist} ` +
    `on ${formatWhen(opening.startsAt)}. Please add it to Square.`;
  if (!(await alreadySent(input.idempotencyKey))) {
    await recordInOutbox({ simulated: true, idempotencyKey: input.idempotencyKey, to: "front desk", body, at: new Date().toISOString() });
    console.log(`[SIMULATED FRONT DESK NOTICE] ${body}`);
  }
  return { body, sentAt: new Date().toISOString() };
}
