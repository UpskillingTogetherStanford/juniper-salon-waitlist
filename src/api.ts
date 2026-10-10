import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { Client, Connection, WorkflowUpdateFailedError } from "@temporalio/client";
import express, { type NextFunction, type Request, type Response } from "express";
import { SALON_NAME, SALON_TIME_ZONE, TASK_QUEUE } from "./salon";
import type { ClientView, Opening, RespondResult, StaffView, WaitlistEntry } from "./types";
import { cancelOpening, getClientView, getStaffView, openingWorkflow, respondToOffer } from "./workflows";

const app = express();
app.use(express.json());
app.use(express.static(path.join(process.cwd(), "public")));

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");

let clientPromise: Promise<Client> | undefined;
function getClient(): Promise<Client> {
  clientPromise ??= Connection.connect({
    address: process.env.TEMPORAL_ADDRESS ?? "localhost:7233",
  }).then((connection) => new Client({ connection, namespace: "default" }));
  return clientPromise;
}

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(path.join(DATA_DIR, file), "utf8")) as T;
}

function openingIdFor(service: string, startsAt: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: SALON_TIME_ZONE,
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(new Date(startsAt))
      .map((p) => [p.type, p.value]),
  );
  const slug = service.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/(^-|-$)/g, "");
  return `opening-${slug}-${parts.month}${parts.day}-${parts.hour}${parts.minute}-${randomBytes(2).toString("hex")}`;
}

// ---------- Staff endpoints (operational details, client names) ----------

app.get("/api/salon", async (_request, response) => {
  const salon = await readJson<{ services: string[]; stylists: string[] }>("salon.json");
  const waitlist = await readJson<WaitlistEntry[]>("waitlist.json");
  response.json({
    name: SALON_NAME,
    timeZone: SALON_TIME_ZONE,
    ...salon,
    waitlist: waitlist
      .slice()
      .sort((a, b) => Date.parse(a.joinedAt) - Date.parse(b.joinedAt))
      .map(({ phone, ...rest }) => ({ ...rest, phoneLast4: phone.slice(-4) })),
  });
});

app.post("/api/openings", async (request, response) => {
  const { service, stylist, startsAt, replyWindowSeconds } = request.body ?? {};
  const salon = await readJson<{ services: string[]; stylists: string[] }>("salon.json");
  const startsAtMs = Date.parse(startsAt);
  const windowSeconds = Number(replyWindowSeconds);
  if (!salon.services.includes(service) || !salon.stylists.includes(stylist)) {
    response.status(400).json({ error: "Choose a service and stylist from the list." });
    return;
  }
  if (!Number.isFinite(startsAtMs) || startsAtMs <= Date.now()) {
    response.status(400).json({ error: "The appointment time needs to be in the future." });
    return;
  }
  if (!Number.isFinite(windowSeconds) || windowSeconds < 10 || windowSeconds > 4 * 3600) {
    response.status(400).json({ error: "Choose a reply window." });
    return;
  }
  const opening: Opening = {
    openingId: openingIdFor(service, startsAt),
    service,
    stylist,
    startsAt: new Date(startsAtMs).toISOString(),
    replyWindowSeconds: windowSeconds,
    createdAt: new Date().toISOString(),
  };
  const client = await getClient();
  await client.workflow.start(openingWorkflow, {
    workflowId: opening.openingId,
    taskQueue: TASK_QUEUE,
    args: [opening],
  });
  response.status(201).json({ openingId: opening.openingId });
});

app.get("/api/openings", async (_request, response) => {
  const client = await getClient();
  const ids: string[] = [];
  for await (const info of client.workflow.list({ query: "WorkflowType = 'openingWorkflow'" })) {
    ids.push(info.workflowId);
    if (ids.length >= 12) break;
  }
  const views = await Promise.all(
    ids.map((id) =>
      client.workflow
        .getHandle(id)
        .query(getStaffView)
        .catch(() => null),
    ),
  );
  response.json(
    views
      .filter((view): view is StaffView => view !== null)
      .sort((a, b) => Date.parse(b.opening.createdAt) - Date.parse(a.opening.createdAt)),
  );
});

app.get("/api/openings/:openingId", async (request, response) => {
  const client = await getClient();
  response.json(await client.workflow.getHandle(request.params.openingId).query(getStaffView));
});

app.post("/api/openings/:openingId/cancel", async (request, response) => {
  const client = await getClient();
  const reason = String(request.body?.reason ?? "Cancelled by staff").slice(0, 120);
  try {
    const view = await client.workflow
      .getHandle(request.params.openingId)
      .executeUpdate(cancelOpening, { args: [{ reason }] });
    response.json(view);
  } catch (error) {
    response.status(409).json({ error: "This opening is already closed." });
  }
});

// ---------- Client endpoints (only that client's own offer) ----------

app.get("/api/offers/:openingId/:token", async (request, response) => {
  const client = await getClient();
  const view = await client.workflow
    .getHandle(request.params.openingId)
    .query(getClientView, request.params.token)
    .catch(() => null);
  if (!view) {
    response.status(404).json({ error: "We couldn't find this offer." });
    return;
  }
  response.json(view satisfies ClientView);
});

app.post("/api/offers/:openingId/:token/respond", async (request, response) => {
  const { openingId, token } = request.params;
  const choice = request.body?.choice;
  const handle = (await getClient()).workflow.getHandle(openingId);
  try {
    const result = await handle.executeUpdate(respondToOffer, { args: [{ token, choice }] });
    response.json(result);
  } catch (error) {
    if (error instanceof WorkflowUpdateFailedError) {
      response.status(400).json({ error: "This offer link isn't valid." });
      return;
    }
    // The opening already closed (filled, not filled, or stopped by staff).
    const view = await handle.query(getClientView, token).catch(() => null);
    if (!view) {
      response.status(404).json({ error: "We couldn't find this offer." });
      return;
    }
    const result: RespondResult =
      view.status === "accepted"
        ? { status: "accepted", message: "You already have this spot. See you then!" }
        : choice === "decline"
          ? { status: "declined", message: "Thanks for letting us know. You're still on our waitlist." }
          : {
              status: "unavailable",
              message:
                "Sorry, this opening is no longer available. You're still on our waitlist and we'll reach out about the next one.",
            };
    response.json(result);
  }
});

app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
  console.error(error);
  response.status(500).json({
    error: "Something went wrong. If the Worker is restarting, this will catch up in a moment.",
  });
});

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => {
  console.log(`Juniper Salon staff board: http://localhost:${port}`);
});
