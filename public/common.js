// Shared helpers for the dashboard pages

export async function api(path, opts) {
  const res = await fetch(path, opts)
  if (res.status === 401) {
    location.href = "/login"
    throw new Error("login required")
  }
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`)
  return res.json()
}

export let currency = "$"
export const setCurrency = (c) => (currency = c || "$")

export const money = (v) => (v == null ? "–" : `${currency}${v.toFixed(2)}`)
export const grams = (g) => (g == null ? "–" : g >= 1000 ? `${(g / 1000).toFixed(2)} kg` : `${g.toFixed(1)} g`)
// Electricity: estimates are prefixed with ~ and say how they were made
export const ENERGY_NOTE = {
  measured: "measured by the power meter",
  estimated: "estimated from heater duty",
  "estimated-duration": "estimated from print time (no temperature samples)",
}
export function energyMoney(cost, source) {
  if (cost == null) return `<span class="muted">–</span>`
  return source?.startsWith("estimated")
    ? `<span title="${ENERGY_NOTE[source]}">~${money(cost)}</span>`
    : money(cost)
}

export const temp = (t) => (t == null ? "–" : `${t.toFixed(0)}°`)

export function duration(s) {
  if (s == null) return "–"
  s = Math.round(s)
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m ${String(s % 60).padStart(2, "0")}s`
}

export const date = (t) =>
  new Date(t * 1000).toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })

export const STATUS_LABEL = {
  completed: "Completed", cancelled: "Cancelled", error: "Failed", in_progress: "Printing",
  klippy_shutdown: "Shutdown", klippy_disconnect: "Disconnected", interrupted: "Interrupted", server_exit: "Interrupted",
}
export const statusHtml = (s) => `<span class="status ${esc(s)}">${esc(STATUS_LABEL[s] ?? s)}</span>`

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

export function swatches(filaments) {
  return (filaments ?? [])
    .filter((f) => f.actual_g > 0.05)
    .map((f) => `<span class="swatch" style="background:${esc(f.colour ?? "transparent")}" title="${esc([f.slot, f.material, grams(f.actual_g)].filter(Boolean).join(" · "))}"></span>`)
    .join(" ")
}

export const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim()

// One floating tooltip shared by hover targets
let tipEl
export function tip(ev, html) {
  tipEl ??= Object.assign(document.body.appendChild(document.createElement("div")), { className: "tip" })
  if (!html) {
    tipEl.style.display = "none"
    return
  }
  tipEl.innerHTML = html
  tipEl.style.display = "block"
  const r = tipEl.getBoundingClientRect()
  const x = Math.min(ev.clientX + 12, innerWidth - r.width - 8)
  const y = ev.clientY - r.height - 10 < 0 ? ev.clientY + 14 : ev.clientY - r.height - 10
  tipEl.style.left = `${x}px`
  tipEl.style.top = `${y}px`
}

export function nav(active) {
  return `<header class="top"><h1>Print Stats</h1><nav>
    <a href="/" class="${active === "jobs" ? "active" : ""}">Jobs</a>
    <a href="/settings" class="${active === "settings" ? "active" : ""}">Settings</a></nav></header>`
}
