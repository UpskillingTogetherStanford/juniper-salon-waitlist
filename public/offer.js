// Client view: shows only this client's own offer, looked up by the secret token in the link.
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const params = new URLSearchParams(location.search);
const api = `/api/offers/${encodeURIComponent(params.get("opening") ?? "")}/${encodeURIComponent(params.get("token") ?? "")}`;

let view;
let reply; // message returned after the client taps a button
let busy = false;

const fmtWhen = (iso) =>
  new Date(iso).toLocaleString([], { weekday: "long", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
const fmtTime = (iso) => new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
function timeLeft(iso) {
  const total = Math.ceil(Math.max(0, Date.parse(iso) - Date.now()) / 1000);
  const m = Math.floor(total / 60);
  return m >= 1 ? `${m} min ${String(total % 60).padStart(2, "0")} s` : `${total} s`;
}

function renderState() {
  if (reply) return `<p class="status-msg">${esc(reply)}</p>`;
  switch (view.status) {
    case "pending":
      return `<p class="status-msg">Getting your offer ready…</p>`;
    case "open":
      return `<p>This spot <strong>isn't booked yet</strong>. Let us know by ${fmtTime(view.expiresAt)}
        (<span class="countdown" id="countdown">${timeLeft(view.expiresAt)}</span> left).</p>
        <div class="choice">
          <button class="accept" data-choice="accept" ${busy ? "disabled" : ""}>Accept</button>
          <button class="decline" data-choice="decline" ${busy ? "disabled" : ""}>No thanks</button>
        </div>`;
    case "accepted":
      return `<p class="status-msg"><strong>You're booked!</strong> We look forward to seeing you.</p>`;
    case "declined":
      return `<p class="status-msg">No problem, thanks for letting us know. You're still on our waitlist for future openings.</p>`;
    default:
      return `<p class="status-msg">Sorry, this opening is no longer available. You're still on our waitlist and we'll reach out about the next one.</p>`;
  }
}

function render() {
  $("#messages").innerHTML = view.messages
    .map((m) => `<div class="bubble"><span class="sim-label">Simulated text · ${new Date(m.at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}</span>${esc(m.body)}</div>`)
    .join("");
  $("#offer").hidden = false;
  $("#greeting").textContent = `Hi ${view.firstName}, a spot just opened up`;
  $("#service").textContent = view.service;
  $("#stylist").textContent = view.stylist;
  $("#when").textContent = fmtWhen(view.startsAt);
  $("#state").innerHTML = renderState();
}

async function refresh() {
  const response = await fetch(api);
  if (!response.ok) {
    $("#error").textContent = "We couldn't find this offer. Please check the link from your text.";
    return;
  }
  view = await response.json();
  if (reply && view.status !== "open") reply = undefined; // the live status now says the same thing
  render();
}

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-choice]");
  if (!button || busy) return;
  busy = true;
  render();
  try {
    const response = await fetch(`${api}/respond`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ choice: button.dataset.choice }),
    });
    const body = await response.json();
    reply = body.message ?? body.error;
  } finally {
    busy = false;
    await refresh();
  }
});

setInterval(() => {
  const el = $("#countdown");
  if (el && view?.expiresAt) el.textContent = timeLeft(view.expiresAt);
}, 1000);
refresh().catch(() => ($("#error").textContent = "Couldn't load your offer. Please try again."));
setInterval(() => refresh().catch(() => {}), 2000);
