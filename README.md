# Juniper Salon · Waitlist openings

A prototype for Lena at Juniper Salon. When a client cancels at the last minute, staff
add the open slot and the app offers it to **one waitlisted client at a time**, in the
order they joined. Each client gets **15 minutes** to accept or decline before the
offer moves to the next person on its own. Nobody has to babysit it, and a slot can
never be promised to two people.

Built on [Temporal](https://temporal.io): each opening is a durable Workflow, so the
current offer and its deadline survive restarts.

## Run it (one command)

Requirements: Node.js 20+ and Docker Desktop (running).

```bash
npm install && npm run dev
```

- Staff board: <http://localhost:3000>
- Temporal Web UI: <http://localhost:8233>

Stop with `Ctrl+C`, then `npm run stop` to shut down the local Temporal service.

## Two-minute walkthrough

1. Open <http://localhost:3000>. Pick **Haircut** with **Rosa**, keep the suggested time,
   and set the reply window to **30 seconds (demo only)** so you don't wait 15 minutes.
   Click **Start offering**.
2. The card shows who has the offer, when it expires, and who is up next.
   Click **phone view ↗** next to that client to see exactly what they see:
   a clearly labeled *simulated* text and **Accept / No thanks** buttons.
3. Tap **No thanks**. The client gets a kind reply and stays on the waitlist; the
   offer moves to the next person straight away.
4. Do nothing for 30 seconds. The offer times out and moves on automatically.
5. Open the timed-out client's **phone view** and tap **Accept**. They're told
   politely the spot is no longer available and can't claim it.
6. On the current client's phone view, tap **Accept**. The opening shows **Filled**,
   the client gets a confirmation, and a *simulated* front-desk notice says to add it
   to Square.
7. Start another opening and press **Spot was taken** or **Stylist unavailable**.
   Offering stops, the current client is told it's no longer available, and nobody
   can claim it.
8. **Restart test:** while an offer is live, stop the app with `Ctrl+C` and run
   `npm run dev` again. The same client still has the offer with the same deadline,
   and it carries on from there.

Each opening's **Workflow ID** links to its history in the Temporal Web UI.

## What Lena asked for, and how the prototype does it

| Lena said | Prototype |
| --- | --- |
| Texting several people at once led to two clients thinking they got the same slot | Offers go to **one person at a time**. Replies are handled one at a time inside the Workflow, so only one person can ever accept. |
| Match on service, availability and stylist preference, earliest on the waitlist first | `src/salon.ts` applies exactly those rules to the waitlist |
| About 15 minutes to reply, less when pressed for time | Reply window defaults to 15 minutes; staff can pick 10 or 5 |
| A late "yes" should be told politely it's gone and not get the spot | Late accepts get a clear, polite "no longer available" |
| A decline only applies to that opening | Decliners stay on the waitlist; they get a friendly acknowledgement |
| See who has the offer, when it expires, who declined or timed out, who's next | Staff card shows all four at a glance |
| Confirm with the client, tell the front desk; we enter it in Square ourselves | Confirmation text + front-desk notice; Square is untouched |
| If nobody accepts, show it wasn't filled and why, and stop | Card shows **Not filled** with the reason; each person's outcome is listed |
| Staff must be able to cancel; then nobody can claim it | **Spot was taken / Stylist unavailable** buttons stop it immediately |
| After a restart, the offer and deadline should still be there | Temporal durable timers and state; see step 8 above |
| Clients must never see other clients' names, numbers or position | Client links carry a secret token and only return that client's own offer |
| Warm and calm on a phone; label simulated notifications | Phone-first design; every simulated text and notice is labeled |

## How Temporal is used

- **One Workflow per opening** (`openingWorkflow` in `src/workflows.ts`) holds the whole
  process: matching, each offer, the reply window, and the outcome.
- **Durable timer** for each reply window (`condition(..., timeout)`), so deadlines
  survive Worker and server restarts.
- **Updates** for client replies (`respondToOffer`) and staff cancellation
  (`cancelOpening`). They return an answer right away ("You're booked" / "no longer
  available") and run one at a time, which is what rules out double booking.
- **Queries** for the staff view (`getStaffView`) and each client's view
  (`getClientView`, filtered to that client only).
- **Activities with automatic retries** for the outside world: reading the waitlist,
  sending texts, notifying the front desk. Each send has an idempotency key so a retry
  never texts someone twice. Try `SIMULATED_TEXT_FAILURE_RATE=0.5 npm run dev` to watch
  retries in the Web UI.

## Simulated or left out

- **Texts and front-desk notices are simulated.** They're written to
  `.data/simulated-outbox.jsonl` and shown on screen with a "simulated" label. Nothing is sent.
- **The waitlist is sample data** in `data/waitlist.json`, standing in for the Google
  Sheet. Accepting or declining doesn't edit it.
- **Square is not connected.** Staff still enter the booking themselves, as Lena wants.
- **No staff login.** Anyone who can open the staff board can see it. Client links are
  unguessable, but this is a local prototype only.
- A "yes" tapped after an opening has fully closed is answered on screen; it doesn't
  trigger a new text.

## Tests

```bash
npm test          # Workflow tests against a local Temporal dev server (no Docker needed)
npm run typecheck
```

The tests cover: one offer at a time in waitlist order, decline → next person, accept
→ filled with confirmation and front-desk notice, no reply → next person, a late "yes"
can't claim the slot, staff cancellation, no matching clients, and the matching rules.

## Repository map

- `src/workflows.ts`: the opening Workflow, its Updates and Queries
- `src/activities.ts`: waitlist lookup and simulated texts / front-desk notices
- `src/salon.ts`: matching rules and time formatting
- `src/api.ts`: staff and client API, Temporal Client
- `src/worker.ts`: Worker on the `juniper-waitlist` task queue
- `public/index.html`, `public/staff.js`: staff board
- `public/offer.html`, `public/offer.js`: client phone view (simulated text)
- `data/`: sample salon settings and waitlist
- `evidence/`: Temporal Web UI screenshot
