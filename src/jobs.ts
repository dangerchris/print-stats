import type { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { config } from "./config"
import { getJob, updateJob, type JobRow } from "./db"
import { extractThumbnail, parseGcode, type SlicerInfo } from "./gcode"
import { fetchGcode, type HistoryJob } from "./moonraker"
import { loadSettings, priceJob, type CfsState, type Settings } from "./cost"
import { estimateWatts, integrateKwh, type DutySample } from "./power"

export const TERMINAL = (status: string) => status !== "in_progress"

export const groupId = (j: Pick<JobRow, "job_id" | "merged_into">) => j.merged_into ?? j.job_id

export function mediaDir(id: string): string {
  return path.join(config.mediaDir, id)
}

// Insert a Moonraker history entry, or refresh its timing/filament fields. Returns the stored row
// and whether this call moved it from in_progress to a terminal status.
export function upsertHistoryJob(db: Database, h: HistoryJob): { job: JobRow; ended: boolean; isNew: boolean } {
  const before = getJob(db, h.job_id)
  db.query(`
    INSERT INTO jobs (job_id, filename, status, start, end, print_duration, total_duration, filament_mm, updated_at)
    VALUES ($id, $filename, $status, $start, $end, $pd, $td, $mm, $now)
    ON CONFLICT(job_id) DO UPDATE SET
      filename = excluded.filename, status = excluded.status, end = excluded.end,
      print_duration = excluded.print_duration, total_duration = excluded.total_duration,
      filament_mm = CASE WHEN excluded.filament_mm > 0 OR excluded.status != 'in_progress'
                         THEN excluded.filament_mm ELSE jobs.filament_mm END,
      updated_at = excluded.updated_at
    WHERE jobs.status != excluded.status OR jobs.end IS NOT excluded.end
       OR jobs.print_duration != excluded.print_duration OR jobs.filament_mm != excluded.filament_mm
  `).run({
    $id: h.job_id,
    $filename: h.filename,
    $status: h.status,
    $start: h.start_time,
    $end: h.end_time,
    $pd: h.print_duration ?? 0,
    $td: h.total_duration ?? 0,
    $mm: h.filament_used ?? 0,
    $now: Date.now() / 1000,
  })
  const job = getJob(db, h.job_id)!
  const ended = !!before && !TERMINAL(before.status) && TERMINAL(job.status)
  return { job, ended, isNew: !before }
}

// Slicer per-filament estimates and thumbnail, parsed once from the gcode file
export async function ensureSlicer(db: Database, job: JobRow, liveFallback?: SlicerInfo | null): Promise<SlicerInfo | null> {
  if (job.slicer_json) return JSON.parse(job.slicer_json)
  let info: SlicerInfo | null = null
  try {
    const text = await fetchGcode(job.filename)
    info = parseGcode(text)
    const png = extractThumbnail(text)
    if (png && !job.thumb) {
      const dir = mediaDir(groupId(job))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, `slicer-${job.job_id}.png`), png)
      updateJob(db, job.job_id, { thumb: `slicer-${job.job_id}.png` })
    }
  } catch (err) {
    console.warn(`[slicer] ${job.job_id} ${job.filename}: ${(err as Error).message}`)
    info = liveFallback ?? null
  }
  if (info && !info.filaments.length) info = liveFallback ?? null
  if (info) updateJob(db, job.job_id, { slicer_json: JSON.stringify(info) })
  return info
}

// Older rows stored a bare slot array; jobs priced from the current CFS after the fact carry no map
export function parseCfs(text: string | null): CfsState {
  if (!text) return { slots: [], map: null }
  const v = JSON.parse(text)
  return Array.isArray(v) ? { slots: v, map: null } : v
}

export function jobWindow(job: JobRow): [number, number] {
  const from = job.creality_start && job.creality_start < job.start ? job.creality_start : job.start - 600
  return [from, job.end ?? Date.now() / 1000]
}

export type EnergySource = "measured" | "estimated" | "estimated-duration" | "none"

// Typical draw for jobs recorded before samples existed: the mean of sample-estimated jobs, or failing
// that a PLA-ish steady state (nozzle ~12% and bed ~16% duty, as seen on the K2 at 220/50 C)
function fallbackWatts(db: Database, s: Settings): number {
  const row = db.query<{ w: number | null }, []>(`SELECT AVG(energy_kwh * 3600000.0 / total_duration) AS w FROM jobs
    WHERE energy_source = 'estimated' AND total_duration > 600 AND merged_into IS NULL`).get()
  const e = s.energyEstimate
  return row?.w ?? e.baseWatts + 0.12 * e.nozzleWatts + 0.16 * e.bedWatts
}

export function jobEnergy(db: Database, job: JobRow, settings: Settings): { kwh: number | null; source: EnergySource } {
  const [from, to] = jobWindow(job)
  const measured = integrateKwh(db.query<{ ts: number; watts: number | null }, [number, number]>(
    "SELECT ts, watts FROM samples WHERE ts BETWEEN ? AND ? AND watts IS NOT NULL ORDER BY ts",
  ).all(from, to))
  if (measured != null) return { kwh: measured, source: "measured" }
  if (!settings.energyEstimate.enabled) return { kwh: null, source: "none" }
  const duty = db.query<DutySample, [number, number]>(
    "SELECT ts, nozzle_power, bed_power FROM samples WHERE ts BETWEEN ? AND ? ORDER BY ts",
  ).all(from, to)
  const est = integrateKwh(duty.map((d) => ({ ts: d.ts, watts: estimateWatts(d, settings.energyEstimate) })))
  const span = Math.max(job.total_duration, (job.end ?? to) - job.start)
  if (est != null) {
    // Time the samples don't cover (service started mid-job, or was down) is filled at the average
    const covered = Math.min(span, duty[duty.length - 1].ts - Math.max(duty[0].ts, job.start))
    const gap = Math.max(0, span - covered)
    const kwh = est + (fallbackWatts(db, settings) * gap) / 3600 / 1000
    return { kwh, source: gap <= 0.2 * span ? "estimated" : "estimated-duration" }
  }
  if (!span) return { kwh: null, source: "none" }
  return { kwh: (fallbackWatts(db, settings) * span) / 3600 / 1000, source: "estimated-duration" }
}

export function priceAndStore(db: Database, jobId: string): void {
  const job = getJob(db, jobId)
  if (!job) return
  const settings = loadSettings(db)
  const { kwh: energy_kwh, source: energy_source } = jobEnergy(db, job, settings)
  const priced = priceJob({
    filament_mm: job.filament_mm,
    total_duration: job.total_duration,
    energy_kwh,
    slicer: job.slicer_json ? JSON.parse(job.slicer_json) : null,
    cfs: parseCfs(job.cfs_json),
  }, settings)
  db.transaction(() => {
    db.query("DELETE FROM job_filament WHERE job_id = ?").run(jobId)
    const ins = db.query(`INSERT INTO job_filament (job_id, idx, slot, material, colour, name, est_g, actual_g, price_per_kg, cost, match)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    for (const f of priced.filaments) {
      ins.run(jobId, f.idx, f.slot, f.material, f.colour, f.name, f.est_g, f.actual_g, f.price_per_kg, f.cost, f.match)
    }
    updateJob(db, jobId, {
      filament_g: priced.filament_g,
      material_cost: priced.material_cost,
      energy_kwh,
      energy_source,
      energy_cost: priced.energy_cost,
      machine_cost: priced.machine_cost,
      total_cost: priced.total_cost,
      cost_inputs_json: JSON.stringify(priced.inputs),
    })
  })()
}

// A Creality-screen pause ends the virtual_sdcard print; the resume may be logged as a new
// Moonraker job. Fragments sharing the printer's own job clock are merged under the first one.
export function linkFragment(db: Database, job: JobRow): void {
  if (!job.creality_start || job.merged_into) return
  const prev = db.query<JobRow, [string, string, number]>(`
    SELECT * FROM jobs WHERE job_id != ? AND filename = ? AND ABS(creality_start - ?) < 2
    ORDER BY start LIMIT 1`).get(job.job_id, job.filename, job.creality_start)
  if (!prev || prev.start > job.start) return
  const root = groupId(prev)
  console.log(`[collector] job ${job.job_id} is a resumed fragment of ${root}`)
  updateJob(db, job.job_id, { merged_into: root })
}

export async function finalizeJob(db: Database, jobId: string, currentCfs: CfsState): Promise<void> {
  let job = getJob(db, jobId)
  if (!job) return
  await ensureSlicer(db, job)
  job = getJob(db, jobId)!
  // Jobs that finished before the service saw them get the CFS as loaded now (best effort; the
  // tool map is only meaningful for the job it was set for, so it is dropped)
  if (!job.cfs_json && currentCfs.slots.length) updateJob(db, jobId, { cfs_json: JSON.stringify({ slots: currentCfs.slots, map: null }) })
  priceAndStore(db, jobId)
  updateJob(db, jobId, { finalized: 1, media_state: job.media_state ?? "pending" })
  const j = getJob(db, jobId)!
  console.log(`[job] ${jobId} ${j.status} ${j.filename}: ${j.filament_g?.toFixed(1)} g, ${j.total_cost?.toFixed(2)}`)
}

export function recalculateAll(db: Database): number {
  // Sample-based jobs first, so duration-only estimates use their average
  const ids = db.query<{ job_id: string }, []>(`SELECT job_id FROM jobs WHERE finalized = 1
    ORDER BY (SELECT COUNT(*) FROM samples WHERE samples.ts BETWEEN jobs.start AND COALESCE(jobs.end, 1e12)) > 0 DESC, start`).all()
  for (const { job_id } of ids) priceAndStore(db, job_id)
  return ids.length
}
