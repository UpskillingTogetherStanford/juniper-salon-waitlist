// Shared data shapes for the Juniper Salon waitlist prototype.

/** What staff enter when a last-minute cancellation opens a slot. */
export type OpeningRequest = {
  service: string;
  stylist: string;
  /** Appointment start time, ISO 8601. */
  startsAt: string;
  /** How long each client gets to reply before the offer moves on. */
  replyWindowSeconds: number;
};

export type Opening = OpeningRequest & {
  openingId: string;
  createdAt: string;
};

/** One row of the (simulated) waitlist spreadsheet. */
export type WaitlistEntry = {
  clientId: string;
  name: string;
  phone: string;
  service: string;
  /** A stylist name, or "Any". */
  stylistPreference: string;
  /** Days the client can come in: "Mon".."Sun". */
  days: string[];
  /** Earliest and latest start time the client can make, "HH:MM" in salon time. */
  earliest: string;
  latest: string;
  joinedAt: string;
};

/** A waitlisted client who fits this opening, in the order they will be offered it. */
export type Candidate = {
  clientId: string;
  name: string;
  phone: string;
  joinedAt: string;
};

export type OfferOutcome =
  | "sending"
  | "waiting"
  | "accepted"
  | "declined"
  | "timed_out"
  | "withdrawn";

export type OfferAttempt = {
  clientId: string;
  name: string;
  phoneLast4: string;
  /** Secret that only this client's offer link contains. */
  token: string;
  offeredAt?: string;
  expiresAt?: string;
  outcome: OfferOutcome;
  respondedAt?: string;
};

export type Phase = "matching" | "offering" | "filled" | "not_filled" | "cancelled";

export type TimelineEntry = {
  at: string;
  text: string;
  tone: "info" | "good" | "warn";
};

/** A notification the prototype pretends to send. Nothing leaves this computer. */
export type SimulatedMessage = {
  at: string;
  audience: "client" | "front_desk";
  clientId?: string;
  body: string;
};

/** Everything staff see about one opening. Staff-only: contains client names. */
export type StaffView = {
  opening: Opening;
  phase: Phase;
  currentOffer?: OfferAttempt;
  attempts: OfferAttempt[];
  upNext: { name: string }[];
  matchedCount: number;
  outcomeReason?: string;
  filledBy?: { name: string; phoneLast4: string };
  cancelReason?: string;
  timeline: TimelineEntry[];
  frontDeskMessages: SimulatedMessage[];
};

/** What one client sees through their own offer link. Never contains other clients. */
export type ClientView = {
  firstName: string;
  service: string;
  stylist: string;
  startsAt: string;
  status: "pending" | "open" | "accepted" | "declined" | "unavailable";
  expiresAt?: string;
  messages: { at: string; body: string }[];
};

export type ReplyChoice = "accept" | "decline";

export type RespondInput = { token: string; choice: ReplyChoice };

export type RespondResult = {
  status: "accepted" | "declined" | "unavailable";
  message: string;
};

export type CancelInput = { reason: string };

export type OpeningResult = {
  openingId: string;
  phase: Phase;
  filledBy?: string;
  reason?: string;
};

/** Kinds of client text the prototype can (pretend to) send. */
export type ClientTextKind = "offer" | "confirmed" | "decline_ack" | "no_longer_available";

export type ClientTextInput = {
  kind: ClientTextKind;
  /** Same key on a retry means the same text, so a client is never texted twice. */
  idempotencyKey: string;
  client: { clientId: string; name: string; phone: string };
  opening: Opening;
  /** Secret for this client's offer link (offer texts only). */
  offerToken?: string;
  expiresAt?: string;
};
