// Salon rules that don't need Temporal: who fits an opening, and how times read in texts.
import type { Candidate, Opening, WaitlistEntry } from "./types";

export const SALON_NAME = "Juniper Salon";
export const TASK_QUEUE = "juniper-waitlist";
export const SALON_TIME_ZONE = process.env.SALON_TIME_ZONE ?? "America/Los_Angeles";

function salonClock(iso: string, timeZone: string): { weekday: string; hhmm: string } {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  return { weekday: get("weekday"), hhmm: `${get("hour")}:${get("minute")}` };
}

/**
 * Lena's matching rules: same service, can make that day and time, and the stylist
 * fits their preference. Whoever joined the waitlist earliest goes first.
 */
export function matchWaitlist(
  entries: WaitlistEntry[],
  opening: Pick<Opening, "service" | "stylist" | "startsAt">,
  timeZone = SALON_TIME_ZONE,
): Candidate[] {
  const { weekday, hhmm } = salonClock(opening.startsAt, timeZone);
  return entries
    .filter((entry) => entry.service === opening.service)
    .filter((entry) => entry.stylistPreference === "Any" || entry.stylistPreference === opening.stylist)
    .filter((entry) => entry.days.includes(weekday) && entry.earliest <= hhmm && hhmm <= entry.latest)
    .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
    .map(({ clientId, name, phone, joinedAt }) => ({ clientId, name, phone, joinedAt }));
}

export function formatWhen(iso: string, timeZone = SALON_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(iso));
}

export function formatTime(iso: string, timeZone = SALON_TIME_ZONE): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", minute: "2-digit" }).format(
    new Date(iso),
  );
}

export function firstName(name: string): string {
  return name.split(" ")[0] ?? name;
}
