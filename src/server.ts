import type { Database } from "bun:sqlite"
import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import { config } from "./config"
import { verifyAccessJwt } from "./access"
import type { FilamentRow, JobRow } from "./db"
import { loadSettings, saveSettings, type Settings } from "./cost"
import { groupId, jobWindow, recalculateAll } from "./jobs"
import { estimateWatts } from "./power"
import { BAND_LABEL, bandAt, validTou } from "./tou"
import { cameraSnapshot, liveStream, logPlayerError } from "./camera"
import type { Collector } from "./collector"

// ---- auth: LAN is open; requests through the cloudflared tunnel need a password session ----

const SESSION_DAYS = 30
const secret = () => config.sessionSecret || crypto.createHash("sha256").update(`print-stats:${config.password}`).digest("hex")
const sign = (exp: number) => crypto.createHmac("sha256", secret()).update(String(exp)).digest("hex")

function hasSession(req: Request): boolean {
  const m = /(?:^|;\s*)ps_session=(\d+)\.([0-9a-f]{64})/.exec(req.headers.get("cookie") ?? "")
  if (!m || Number(m[1]) < Date.now() / 1000) return false
  return crypto.timingSafeEqual(Buffer.from(m[2]), Buffer.from(sign(Number(m[1]))))
}

const viaTunnel = (req: Request) => req.headers.has("cf-connecting-ip")

function checkPassword(given: string): boolean {
  if (!config.password) return false
  const a = crypto.createHash("sha256").update(given).digest()
  const b = crypto.createHash("sha256").update(config.password).digest()
  return crypto.timingSafeEqual(a, b)
}

const LOGIN_HTML = (error = "") => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Print Stats</title><link rel="stylesheet" href="/static/app.css"></head><body>
<main class="login"><h1>Print Stats</h1><form method="post" action="/login">
<label>Password <input type="password" name="password" autofocus required></label>
${error ? `<p class="error">${error}</p>` : ""}<button type="submit">Sign in</button></form></main></body></html>`

// ---- helpers ----

const json = (data: unknown, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } })

export function prettyName(filename: string): string {
  return path.basename(filename)
    .replace(/\.gcode$/i, "")
    .replace(/\.(stl|3mf|step|obj)_.*$/i, "")
    .replace(/_plate_\d+$/i, "")
    .replace(/_\d{8}$/, "")
    .replace(/_/g, " ")
}

function mediaUrl(group: string, file: string | null): string | null {
  return file ? `/media/${encodeURIComponent(group)}/${encodeURIComponent(file)}` : null
}

interface JobGroup {
  id: string
  name: string
  filename: string
  status: string
  start: number
  end: number | null
  prep_start: number | null
  print_duration: number
  total_duration: number
  filament_g: number
  material_cost: number
  energy_kwh: number | null
  energy_cost: number | null
  energy_source: string
  machine_cost: number
  total_cost: number
  thumb: string | null
  snapshot: string | null
  video: string | null
  video_source: string | null
  media_state: string | null
  fragments: string[]
  filaments: FilamentRow[]
}

function groups(db: Database, where = "1=1", params: any[] = []): JobGroup[] {
  const rows = db.query<JobRow, any[]>(`SELECT * FROM jobs WHERE ${where} ORDER BY start`).all(...params)
  const fil = db.query<FilamentRow, []>("SELECT * FROM job_filament ORDER BY job_id, idx").all()
  const filBy = new Map<string, FilamentRow[]>()
  for (const f of fil) filBy.set(f.job_id, [...(filBy.get(f.job_id) ?? []), f])
  const out = new Map<string, JobGroup>()
  for (const r of rows) {
    const id = groupId(r)
    let g = out.get(id)
    if (!g) {
      const root = r.job_id === id ? r : rows.find((x) => x.job_id === id) ?? r
      const thumb = root.snapshot ?? root.cover ?? root.thumb
      g = {
        id, name: prettyName(r.filename), filename: r.filename, status: r.status, start: r.start, end: r.end,
        prep_start: root.prep_start, print_duration: 0, total_duration: 0, filament_g: 0, material_cost: 0, energy_kwh: null, energy_cost: null,
        energy_source: "none", machine_cost: 0, total_cost: 0,
        thumb: mediaUrl(id, thumb), snapshot: mediaUrl(id, root.snapshot), video: mediaUrl(id, root.video),
        video_source: root.video_source, media_state: root.media_state, fragments: [], filaments: [],
      }
      out.set(id, g)
    }
    g.fragments.push(r.job_id)
    g.status = r.status
    g.end = r.end
    g.print_duration += r.print_duration
    g.total_duration += r.total_duration
    g.filament_g += r.filament_g ?? 0
    g.material_cost += r.material_cost ?? 0
    g.machine_cost += r.machine_cost ?? 0
    g.total_cost += r.total_cost ?? 0
    if (r.energy_kwh != null) g.energy_kwh = (g.energy_kwh ?? 0) + r.energy_kwh
    if (r.energy_cost != null) g.energy_cost = (g.energy_cost ?? 0) + r.energy_cost
    // A group is only "measured" if every part was
    const rank = ["none", "measured", "estimated", "estimated-duration"]
    const src = r.energy_source ?? "none"
    if (rank.indexOf(src) > rank.indexOf(g.energy_source)) g.energy_source = src
    for (const f of filBy.get(r.job_id) ?? []) {
      const same = g.filaments.find((x) => x.idx === f.idx && x.slot === f.slot)
      if (same) {
        same.actual_g += f.actual_g
        same.cost += f.cost
      } else g.filaments.push({ ...f })
    }
  }
  return [...out.values()]
}

function summary(db: Database) {
  const all = groups(db).filter((g) => g.status !== "in_progress")
  const totals = {
    jobs: all.length,
    completed: all.filter((g) => g.status === "completed").length,
    print_hours: all.reduce((a, g) => a + g.print_duration, 0) / 3600,
    filament_g: all.reduce((a, g) => a + g.filament_g, 0),
    material_cost: all.reduce((a, g) => a + g.material_cost, 0),
    energy_kwh: all.some((g) => g.energy_kwh != null) ? all.reduce((a, g) => a + (g.energy_kwh ?? 0), 0) : null,
    energy_cost: all.some((g) => g.energy_cost != null) ? all.reduce((a, g) => a + (g.energy_cost ?? 0), 0) : null,
    energy_estimated: all.some((g) => g.energy_source.startsWith("estimated")),
    total_cost: all.reduce((a, g) => a + g.total_cost, 0),
    wasted_g: all.filter((g) => g.status !== "completed").reduce((a, g) => a + g.filament_g, 0),
  }
  // Weeks start on Monday, local time
  const weekStart = (t: number) => {
    const d = new Date(t * 1000)
    d.setHours(0, 0, 0, 0)
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
    return d.getTime() / 1000
  }
  const weeks = new Map<number, { week: number; cost: number; grams: number; jobs: number }>()
  for (const g of all) {
    const w = weekStart(g.start)
    const e = weeks.get(w) ?? { week: w, cost: 0, grams: 0, jobs: 0 }
    e.cost += g.total_cost
    e.grams += g.filament_g
    e.jobs++
    weeks.set(w, e)
  }
  return { totals, weeks: [...weeks.values()].sort((a, b) => a.week - b.week), colours: colourTotals(db) }
}

// Filament used per colour and material across finished jobs, heaviest first
function colourTotals(db: Database) {
  const rows = db.query<{ colour: string | null; material: string; slot: string | null; name: string | null; grams: number;
    cost: number; jobs: number; last_used: number }, []>(`
    SELECT LOWER(f.colour) AS colour, f.material, SUM(f.actual_g) AS grams, SUM(f.cost) AS cost,
      COUNT(DISTINCT COALESCE(j.merged_into, j.job_id)) AS jobs, MAX(j.start) AS last_used,
      (SELECT f2.slot FROM job_filament f2 JOIN jobs j2 ON j2.job_id = f2.job_id
        WHERE LOWER(f2.colour) IS LOWER(f.colour) AND f2.material = f.material AND f2.actual_g > 0.05
        ORDER BY j2.start DESC LIMIT 1) AS slot,
      (SELECT f3.name FROM job_filament f3 JOIN jobs j3 ON j3.job_id = f3.job_id
        WHERE LOWER(f3.colour) IS LOWER(f.colour) AND f3.material = f.material AND f3.actual_g > 0.05
        ORDER BY j3.start DESC LIMIT 1) AS name
    FROM job_filament f JOIN jobs j ON j.job_id = f.job_id
    WHERE j.status != 'in_progress' AND f.actual_g > 0.05
    GROUP BY LOWER(f.colour), f.material
    ORDER BY grams DESC`).all()
  return rows
}

function samplesFor(db: Database, id: string) {
  const rows = db.query<JobRow, [string, string]>("SELECT * FROM jobs WHERE job_id = ? OR merged_into = ?").all(id, id)
  if (!rows.length) return null
  const windows = rows.map(jobWindow)
  const from = Math.min(...windows.map((w) => w[0]))
  const to = Math.max(...windows.map((w) => w[1]))
  const raw = db.query<any, [number, number]>(`SELECT ts, nozzle, nozzle_target, nozzle_power, bed, bed_target, bed_power,
    chamber, chamber_target, watts, state FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts`).all(from, to)
  // Bucket to at most ~1500 points; a gap > 60 s (service down, printer off) becomes a null break
  const step = Math.max(1, Math.ceil(raw.length / 1500))
  const est = loadSettings(db).energyEstimate
  for (const r of raw) r.est_watts = est.enabled ? estimateWatts(r, est) : null
  const cols = ["nozzle", "nozzle_target", "nozzle_power", "bed", "bed_target", "bed_power", "chamber", "chamber_target", "watts", "est_watts"]
  const out: Record<string, (number | null)[]> = { ts: [] }
  for (const c of cols) out[c] = []
  out.paused = []
  let prevTs = 0
  for (let i = 0; i < raw.length; i += step) {
    const bucket = raw.slice(i, i + step)
    const ts = bucket[0].ts
    if (prevTs && ts - prevTs > 60 * step) {
      out.ts.push(prevTs + 1)
      for (const c of cols) out[c].push(null)
      out.paused.push(null)
    }
    out.ts.push(ts)
    for (const c of cols) {
      const vals = bucket.map((b) => b[c]).filter((v) => v != null)
      out[c].push(vals.length ? vals.reduce((a, v) => a + v, 0) / vals.length : null)
    }
    out.paused.push(bucket.some((b) => b.state === "paused" || b.state === "standby") ? 1 : 0)
    prevTs = bucket[bucket.length - 1].ts
  }
  return { from, to, starts: rows.map((r) => r.start), ends: rows.map((r) => r.end), ...out }
}

function validSettings(s: any): s is Settings {
  return s && typeof s === "object" && typeof s.currency === "string" && s.diameter > 0 && s.kwhRate >= 0 &&
    s.machinePerHour >= 0 && s.materials && typeof s.materials === "object" &&
    Object.values(s.materials).every((m: any) => m.pricePerKg >= 0 && m.density > 0) &&
    Array.isArray(s.slotOverrides) && s.slotOverrides.every((o: any) => typeof o.slot === "string" && o.pricePerKg >= 0) &&
    s.energyEstimate && typeof s.energyEstimate.enabled === "boolean" &&
    ["baseWatts", "nozzleWatts", "bedWatts"].every((k) => s.energyEstimate[k] >= 0) && validTou(s.tou)
}

// The electricity rate in force now, for the dashboard
function rateNow(s: Settings) {
  const now = Date.now() / 1000
  if (!s.tou.enabled) return { tou: false, band: null, label: "Flat rate", rate: s.kwhRate }
  const band = bandAt(now, s.tou)
  // When the band next changes (bands move on whole hours)
  let until = (Math.floor(now / 3600) + 1) * 3600
  while (bandAt(until, s.tou) === band && until - now < 7 * 86400) until += 3600
  return { tou: true, band, label: BAND_LABEL[band], rate: s.tou.rates[band], until }
}

function serveFile(req: Request, file: string): Response {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) return new Response("Not found", { status: 404 })
  const f = Bun.file(file)
  const size = f.size
  const range = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") ?? "")
  const headers: Record<string, string> = { "Accept-Ranges": "bytes", "Content-Type": f.type, "Cache-Control": "max-age=300" }
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : size - Number(range[2])
    let end = range[1] && range[2] ? Number(range[2]) : size - 1
    start = Math.max(0, start)
    end = Math.min(size - 1, end)
    if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${size}` } })
    return new Response(f.slice(start, end + 1), {
      status: 206,
      headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${size}`, "Content-Length": String(end - start + 1) },
    })
  }
  return new Response(f, { headers })
}

const PAGES: Record<string, string> = { "/": "index.html", "/job": "job.html", "/settings": "settings.html" }

export function startServer(db: Database, collector: Collector) {
  return Bun.serve({
    port: config.port,
    idleTimeout: 60,
    async fetch(req) {
      const url = new URL(req.url)
      const p = url.pathname

      if (p === "/login" && req.method === "POST") {
        const form = await req.formData()
        if (!checkPassword(String(form.get("password") ?? ""))) {
          return new Response(LOGIN_HTML(config.password ? "Wrong password" : "No password configured"), { status: 401, headers: { "Content-Type": "text/html" } })
        }
        const exp = Math.floor(Date.now() / 1000) + SESSION_DAYS * 86400
        return new Response(null, {
          status: 303,
          headers: { Location: "/", "Set-Cookie": `ps_session=${exp}.${sign(exp)}; Path=/; Max-Age=${SESSION_DAYS * 86400}; HttpOnly; Secure; SameSite=Lax` },
        })
      }
      if (p === "/login") return new Response(LOGIN_HTML(), { headers: { "Content-Type": "text/html" } })
      if (p.startsWith("/static/")) {
        const file = path.join(config.publicDir, path.normalize(p.slice("/static/".length)).replace(/^(\.\.[/\\])+/, ""))
        if (!file.startsWith(config.publicDir)) return new Response("Not found", { status: 404 })
        return serveFile(req, file)
      }

      if (viaTunnel(req) && !hasSession(req) &&
          !(await verifyAccessJwt(req.headers.get("cf-access-jwt-assertion"), config.accessTeam, config.accessAud))) {
        return p.startsWith("/api/") ? json({ error: "login required" }, 401) : Response.redirect("/login", 303)
      }

      if (PAGES[p]) return serveFile(req, path.join(config.publicDir, PAGES[p]))

      if (p.startsWith("/media/")) {
        const [, , group, file] = p.split("/").map(decodeURIComponent)
        if (!group || !file || /[/\\]|\.\./.test(group + file)) return new Response("Not found", { status: 404 })
        return serveFile(req, path.join(config.mediaDir, group, file))
      }

      if (p === "/api/live") {
        const s = loadSettings(db)
        return json({ ...collector.live, currency: s.currency, rate: rateNow(s) })
      }
      if (p === "/api/camera/live.ts") return liveStream(req)
      if (p === "/api/camera/snapshot") return cameraSnapshot()
      if (p === "/api/camera/error" && req.method === "POST") {
        logPlayerError(await req.json().catch(() => null))
        return json({ ok: true })
      }
      if (p === "/api/summary") return json({ ...summary(db), currency: loadSettings(db).currency })
      if (p === "/api/jobs") return json(groups(db).reverse())

      let m = /^\/api\/jobs\/([^/]+)$/.exec(p)
      if (m) {
        const g = groups(db, "job_id = ? OR merged_into = ?", [m[1], m[1]])[0]
        if (!g) return json({ error: "not found" }, 404)
        const rows = db.query<JobRow, [string, string]>("SELECT * FROM jobs WHERE job_id = ? OR merged_into = ? ORDER BY start").all(m[1], m[1])
        return json({
          ...g,
          slicer: rows[0].slicer_json ? JSON.parse(rows[0].slicer_json) : null,
          cfs: rows[0].cfs_json ? JSON.parse(rows[0].cfs_json) : null,
          cost_inputs: rows[0].cost_inputs_json ? JSON.parse(rows[0].cost_inputs_json) : null,
          parts: rows.map((r) => ({ job_id: r.job_id, status: r.status, start: r.start, end: r.end, print_duration: r.print_duration, filament_mm: r.filament_mm })),
          currency: loadSettings(db).currency,
        })
      }
      m = /^\/api\/jobs\/([^/]+)\/samples$/.exec(p)
      if (m) {
        const s = samplesFor(db, m[1])
        return s ? json(s) : json({ error: "not found" }, 404)
      }

      if (p === "/api/settings" && req.method === "GET") return json({ settings: loadSettings(db), cfs: collector.live.cfs })
      if (p === "/api/settings" && req.method === "PUT") {
        const body = await req.json().catch(() => null)
        if (!validSettings(body)) return json({ error: "invalid settings" }, 400)
        saveSettings(db, body)
        return json({ ok: true })
      }
      if (p === "/api/recalculate" && req.method === "POST") return json({ repriced: recalculateAll(db) })
      if (p === "/api/power" && req.method === "POST") {
        // JSON only, so a cross-site form post can't flip the switch
        if (!req.headers.get("content-type")?.includes("application/json")) return json({ error: "expected JSON" }, 415)
        const body = (await req.json().catch(() => null)) as { on?: unknown; force?: unknown } | null
        if (typeof body?.on !== "boolean") return json({ error: "on must be true or false" }, 400)
        const l = collector.live
        if (!body.on && body.force !== true && l.online && (l.state === "printing" || l.state === "paused")) {
          return json({ error: `the printer is ${l.state}` }, 409)
        }
        try {
          return json(await collector.setPower(body.on))
        } catch (err) {
          return json({ error: (err as Error).message }, 502)
        }
      }

      return new Response("Not found", { status: 404 })
    },
  })
}
