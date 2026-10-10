const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString([], { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

function timeLeft(iso) {
  const ms = Math.max(0, Date.parse(iso) - Date.now());
  const total = Math.ceil(ms / 1000);
  const m = Math.floor(total / 60);
  const s = String(total % 60).padStart(2, "0");
  return `${m}:${s}`;
}

const PHASE_LABEL = {
  matching: "Finding matches",
  offering: "Offering",
  filled: "Filled",
  not_filled: "Not filled",
  cancelled: "Stopped",
};
const OUTCOME = {
  sending: ["Sending offer…", ""],
  waiting: ["Has the offer now", "good"],
  accepted: ["Accepted", "good"],
  declined: ["Said no thanks", ""],
  timed_out: ["No reply in time", "warn"],
  withdrawn: ["Offer withdrawn", "warn"],
};

let openings = [];

function offerLink(view, attempt) {
  return `/offer.html?opening=${encodeURIComponent(view.opening.openingId)}&token=${attempt.token}`;
}

function renderNow(view) {
  const offer = view.currentOffer;
  if (view.phase === "matching") {
    return `<div class="now"><strong>Checking the waitlist…</strong></div>`;
  }
  if (view.phase === "offering" && offer) {
    if (offer.outcome === "sending" || !offer.offeredAt) {
      return `<div class="now"><strong>Sending the offer to ${esc(offer.name)}…</strong></div>`;
    }
    const total = Date.parse(offer.expiresAt) - Date.parse(offer.offeredAt);
    const left = Math.max(0, Date.parse(offer.expiresAt) - Date.now());
    const pct = total > 0 ? Math.round((left / total) * 100) : 0;
    return `<div class="now">
      <strong>${esc(offer.name)} has the offer</strong>
      <div class="sub">Expires at ${fmtTime(offer.expiresAt)} · <span data-countdown="${esc(offer.expiresAt)}">${timeLeft(offer.expiresAt)}</span> left</div>
      <div class="bar"><span style="width:${pct}%" data-bar="${esc(offer.offeredAt)}|${esc(offer.expiresAt)}"></span></div>
    </div>`;
  }
  if (view.phase === "filled" && view.filledBy) {
    const notice = view.frontDeskMessages[0];
    return `<div class="now"><strong>Filled by ${esc(view.filledBy.name)}</strong>
      <div class="sub">Confirmation sent. Next step: add it to Square.</div>
      ${notice ? `<div class="sim"><span class="sim-label">Simulated front-desk notice · not actually sent</span>${esc(notice.body)}</div>` : ""}
    </div>`;
  }
  if (view.phase === "cancelled") {
    return `<div class="now done"><strong>Stopped by staff</strong><div class="sub">${esc(view.cancelReason)}. Nobody else can claim this opening.</div></div>`;
  }
  return `<div class="now done"><strong>Not filled</strong><div class="sub">${esc(view.outcomeReason)}</div></div>`;
}

function renderOpening(view) {
  const live = view.phase === "offering" || view.phase === "matching";
  const attempts = view.attempts
    .map((a) => {
      const [label, tone] = OUTCOME[a.outcome] ?? [a.outcome, ""];
      return `<li><span>${esc(a.name)} <a href="${offerLink(view, a)}" target="_blank" rel="noopener" title="Open the simulated text this client received">phone view ↗</a></span><span class="tag ${tone}">${label}</span></li>`;
    })
    .join("");
  const upNext = view.upNext.length
    ? view.upNext.map((p, i) => `<li><span>${i + 1}. ${esc(p.name)}</span><span class="tag">Waiting their turn</span></li>`).join("")
    : "";
  return `<section class="card">
    <div class="opening-head">
      <div>
        <h3>${esc(view.opening.service)} with ${esc(view.opening.stylist)}</h3>
        <p class="when">${fmtWhen(view.opening.startsAt)}</p>
      </div>
      <span class="chip ${view.phase}">${PHASE_LABEL[view.phase] ?? view.phase}</span>
    </div>
    ${renderNow(view)}
    ${attempts ? `<div class="section-label">Offered so far</div><ul class="plain">${attempts}</ul>` : ""}
    ${live && upNext ? `<div class="section-label">Up next if it falls through</div><ul class="plain">${upNext}</ul>` : ""}
    ${
      live
        ? `<div class="actions"><span class="tag">Stop offering:</span>
            <button class="ghost" data-cancel="${esc(view.opening.openingId)}" data-reason="Spot was taken">Spot was taken</button>
            <button class="ghost" data-cancel="${esc(view.opening.openingId)}" data-reason="Stylist unavailable">Stylist unavailable</button>
          </div>`
        : ""
    }
    <div class="meta">Workflow ID: <a href="http://localhost:8233/namespaces/default/workflows/${encodeURIComponent(view.opening.openingId)}" target="_blank" rel="noopener">${esc(view.opening.openingId)}</a></div>
  </section>`;
}

function render() {
  const container = $("#openings");
  container.innerHTML = openings.length
    ? `<div class="section-label">Openings</div>${openings.map(renderOpening).join("")}`
    : `<section class="card"><p class="empty">No openings yet. When someone cancels, add the slot above.</p></section>`;
}

function tick() {
  document.querySelectorAll("[data-countdown]").forEach((el) => (el.textContent = timeLeft(el.dataset.countdown)));
  document.querySelectorAll("[data-bar]").forEach((el) => {
    const [from, to] = el.dataset.bar.split("|").map(Date.parse);
    el.style.width = `${Math.max(0, Math.round(((to - Date.now()) / (to - from)) * 100))}%`;
  });
}

async function refresh() {
  try {
    const response = await fetch("/api/openings");
    if (!response.ok) throw new Error();
    openings = await response.json();
    render();
  } catch {
    /* Temporal or the Worker may be restarting; keep showing the last view. */
  }
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-cancel]");
  if (!button) return;
  if (!confirm(`Stop offering this opening? (${button.dataset.reason}) Nobody else will be able to claim it.`)) return;
  button.disabled = true;
  await fetch(`/api/openings/${encodeURIComponent(button.dataset.cancel)}/cancel`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ reason: button.dataset.reason }),
  });
  await refresh();
});

function defaultStart() {
  const d = new Date(Date.now() + 2 * 3600_000);
  d.setMinutes(d.getMinutes() < 30 ? 30 : 60, 0, 0);
  if (d.getHours() < 9 || d.getHours() >= 19) {
    if (d.getHours() >= 19) d.setDate(d.getDate() + 1);
    d.setHours(10, 0, 0, 0);
  }
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function loadSalon() {
  const salon = await (await fetch("/api/salon")).json();
  $("#service").innerHTML = salon.services.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#stylist").innerHTML = salon.stylists.map((s) => `<option>${esc(s)}</option>`).join("");
  $("#startsAt").value = defaultStart();
  $("#waitlist").innerHTML = salon.waitlist
    .map(
      (w, i) =>
        `<li><span>${i + 1}. ${esc(w.name)} · ${esc(w.service)}${w.stylistPreference !== "Any" ? ` with ${esc(w.stylistPreference)}` : ""}</span><span class="tag">${esc(w.days.length === 7 ? "Any day" : w.days.join(", "))} ${esc(w.earliest)}–${esc(w.latest)}</span></li>`,
    )
    .join("");
}

$("#new-opening").addEventListener("submit", async (event) => {
  event.preventDefault();
  $("#form-error").textContent = "";
  $("#start").disabled = true;
  try {
    const response = await fetch("/api/openings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        service: $("#service").value,
        stylist: $("#stylist").value,
        startsAt: new Date($("#startsAt").value).toISOString(),
        replyWindowSeconds: Number($("#window").value),
      }),
    });
    const body = await response.json();
    if (!response.ok) throw new Error(body.error);
    await refresh();
  } catch (error) {
    $("#form-error").textContent = error.message || "Couldn't start. Is the app still running?";
  } finally {
    $("#start").disabled = false;
  }
});

loadSalon().catch(() => ($("#form-error").textContent = "Couldn't load the salon settings."));
refresh();
setInterval(refresh, 1500);
setInterval(tick, 1000);
