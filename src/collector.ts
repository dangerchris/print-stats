import type { Database } from "bun:sqlite"
import { config } from "./config"
import { getJob, updateJob, type JobRow } from "./db"
import { cfsFromStatus, cfsStateFromStatus, loadSettings, priceJob, type CfsSlot, type CfsState } from "./cost"
import { slicerFromLive, type SlicerInfo } from "./gcode"
import { finalizeJob, groupId, linkFragment, upsertHistoryJob, ensureSlicer, parseCfs, jobEnergy, ensurePrep, detectPrep, looksLikePrep } from "./jobs"
import { captureFrame, mediaSweep, saveFinalSnapshot } from "./media"
import { historyList, queryObjects } from "./moonraker"
import type { PowerReading, PowerSource } from "./power"

export interface LiveState {
  online: boolean
  updatedAt: number
  state: string | null
  filename: string | null
  jobId: string | null
  progress: number | null
  layer: number | null
  layerCount: number | null
  printDuration: number | null
  estTime: number | null
  filamentMm: number | null
  filamentG: number | null
  cost: number | null
  temps: Record<string, { temp: number | null; target: number | null; power?: number | null }>
  watts: number | null
  energyKwh: number | null
  energyCost: number | null
  energySource: string | null
  cfs: CfsSlot[]
  // The smart plug, read even while the printer is off; null when there is no plug
  // Print preparation in progress (standby, heaters at probing temperatures) and when it began
  preparing: { since: number } | null
  plug: { on: boolean | null; watts: number | null; volts: number | null; at: number; canSwitch: boolean; recent: [number, number][] } | null
}

const num = (v: any): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null)

export class Collector {
  live: LiveState = {
    online: false, updatedAt: 0, state: null, filename: null, jobId: null, progress: null, layer: null,
    layerCount: null, printDuration: null, estTime: null, filamentMm: null, filamentG: null, cost: null,
    temps: {}, watts: null, energyKwh: null, energyCost: null, energySource: null, cfs: [], plug: null, preparing: null,
  }
  private lastState: string | null = null
  private lastFlags = ""
  private lastLayer: number | null = null
  private lastFrameAt = 0
  private lastReconcile = 0
  private reconciling: Promise<void> | null = null
  private backoffUntil = 0
  private timer: Timer | null = null

  constructor(private db: Database, private power: PowerSource) {}

  start(): void {
    const loop = async () => {
      try {
        await this.tick()
      } catch (err) {
        console.error("[collector] tick failed:", err)
      }
      this.timer = setTimeout(loop, config.pollMs)
    }
    loop()
    setInterval(() => mediaSweep(this.db).catch((e) => console.error("[media] sweep failed:", e)), 60_000)
    setInterval(() => this.maintenance(), 6 * 3600_000)
  }

  // Last 15 min of plug watts for the dashboard sparkline (memory only; job samples hold the rest)
  private plugRecent: [number, number][] = []

  private plugReading(r: PowerReading | null): void {
    if (this.power.name === "none") return
    const now = Date.now() / 1000
    if (r) this.plugRecent.push([Math.round(now), r.watts])
    this.plugRecent = this.plugRecent.filter(([t]) => t > now - 900)
    const prev = this.live.plug
    this.live.plug = r
      ? { on: r.on ?? null, watts: r.watts, volts: r.volts ?? null, at: now, canSwitch: !!this.power.setSwitch, recent: this.plugRecent }
      : { on: prev?.on ?? null, volts: prev?.volts ?? null, at: prev?.at ?? 0, canSwitch: !!this.power.setSwitch, watts: null, recent: this.plugRecent }
  }

  async setPower(on: boolean): Promise<NonNullable<LiveState["plug"]>> {
    if (!this.power.setSwitch) throw new Error("no switchable plug")
    console.log(`[power] switching printer ${on ? "on" : "off"} (printer state ${this.live.online ? this.live.state : "offline"})`)
    this.plugReading(await this.power.setSwitch(on))
    if (on) this.backoffUntil = 0 // look for the printer as soon as it boots
    return this.live.plug!
  }

  private async tick(): Promise<void> {
    const now = Date.now()
    // The plug is read every poll, printer or not, so the dashboard shows it switching on and off
    const reading = await this.power.read().catch(() => null)
    this.plugReading(reading)
    if (now < this.backoffUntil) return
    let status: Record<string, any>
    try {
      status = await queryObjects()
    } catch (err) {
      if (this.live.online) console.warn(`[collector] printer unreachable: ${(err as Error).message}`)
      this.live.online = false
      this.backoffUntil = now + 30_000
      return
    }
    if (!this.live.online) console.log("[collector] printer online")
    this.live.online = true
    this.recordSample(status, reading?.watts ?? null)

    const state: string = status.print_stats?.state ?? "unknown"
    const flags = `idle_timeout=${status.idle_timeout?.state} START_PRINT.prepare=${JSON.stringify(status["gcode_macro START_PRINT"]?.prepare)}`
    if (flags !== this.lastFlags) {
      console.log(`[collector] ${flags} (print_stats ${state}, nozzle target ${status.extruder?.target}, bed target ${status.heater_bed?.target})`)
      this.lastFlags = flags
    }
    const changed = state !== this.lastState
    if (changed) console.log(`[collector] print_stats ${this.lastState} -> ${state}`)
    const prevJobId = this.live.jobId
    if (changed || now - this.lastReconcile > config.reconcileMs) {
      this.lastReconcile = now
      await this.reconcile(status)
    }

    // Leaving "printing" for anything but a Klipper pause: take the final picture now, while it's fresh
    if (changed && this.lastState === "printing" && state !== "paused" && prevJobId) {
      const group = this.groupOf(prevJobId)
      saveFinalSnapshot(this.db, group).catch((e) => console.error("[media] snapshot failed:", e))
    }

    const layer = num(status.virtual_sdcard?.layer)
    if (state === "printing" && this.live.jobId && layer !== this.lastLayer && now - this.lastFrameAt >= config.frameIntervalMs) {
      this.lastFrameAt = now
      captureFrame(this.groupOf(this.live.jobId)).catch(() => {})
    }
    this.lastLayer = layer
    this.lastState = state
    this.updateLive(status, reading?.watts ?? null)
  }

  private groupOf(jobId: string): string {
    const j = getJob(this.db, jobId)
    return j ? groupId(j) : jobId
  }

  private recordSample(s: Record<string, any>, watts: number | null): void {
    const ex = s.extruder ?? {}
    const bed = s.heater_bed ?? {}
    const chamberFan = s["temperature_fan chamber_fan"] ?? {}
    const chamber = s["temperature_sensor chamber_temp"] ?? {}
    this.db.query(`INSERT OR REPLACE INTO samples (ts, state, progress, layer, filament_mm, nozzle, nozzle_target, nozzle_power,
      bed, bed_target, bed_power, chamber, chamber_target, watts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      Math.round(Date.now() / 100) / 10,
      s.print_stats?.state ?? null,
      num(s.virtual_sdcard?.progress),
      num(s.virtual_sdcard?.layer),
      num(s.print_stats?.filament_used),
      num(ex.temperature), num(ex.target), num(ex.power),
      num(bed.temperature), num(bed.target), num(bed.power),
      num(chamber.temperature) ?? num(chamberFan.temperature), num(chamberFan.target),
      watts,
    )
  }

  // Sync with Moonraker's job history: new jobs, live job details, and jobs that just ended
  async reconcile(status?: Record<string, any>): Promise<void> {
    if (this.reconciling) return this.reconciling
    this.reconciling = this.doReconcile(status).finally(() => (this.reconciling = null))
    return this.reconciling
  }

  private async doReconcile(status?: Record<string, any>): Promise<void> {
    const firstRun = !this.db.query("SELECT 1 FROM jobs LIMIT 1").get()
    const history = await historyList(firstRun ? Infinity : 20)
    const cfs: CfsState = status ? cfsStateFromStatus(status.box, status.filament_rack) : { slots: this.live.cfs, map: null }
    const cur = status?.virtual_sdcard?.cur_print_data
    let liveJob: JobRow | null = null

    for (const h of history.slice().reverse()) {
      const { job, ended, isNew } = upsertHistoryJob(this.db, h)
      if (job.status === "in_progress") {
        liveJob = job
        if (isNew || !job.seen_live) await this.openJob(job, cfs, cur)
      } else if (ended) {
        console.log(`[collector] job ${job.job_id} ended: ${job.status}`)
        await finalizeJob(this.db, job.job_id, cfs)
      } else if (!job.finalized) {
        await finalizeJob(this.db, job.job_id, cfs)
      }
    }
    this.live.jobId = liveJob?.job_id ?? null
    const energy = liveJob ? jobEnergy(this.db, getJob(this.db, liveJob.job_id)!, loadSettings(this.db)) : null
    this.live.energyKwh = energy?.kwh ?? null
    this.live.energyCost = energy?.cost ?? null
    this.live.energySource = energy?.source ?? null
  }

  private async openJob(job: JobRow, cfs: CfsState, cur: any): Promise<void> {
    const fields: Partial<JobRow> = { seen_live: 1 }
    if (cfs.slots.length && !job.cfs_json) fields.cfs_json = JSON.stringify(cfs)
    const live = cur && cur.status === "in_progress" && cur.filename === job.filename.split("/").pop() ? cur : null
    if (live?.start_time) fields.creality_start = live.start_time
    updateJob(this.db, job.job_id, fields)
    let updated = getJob(this.db, job.job_id)!
    linkFragment(this.db, updated)
    updated = ensurePrep(this.db, getJob(this.db, job.job_id)!)
    if (updated.prep_start) console.log(`[collector] job ${job.job_id} prepared for ${Math.round(updated.start - updated.prep_start)} s`)
    console.log(`[collector] tracking job ${job.job_id} ${job.filename}`)
    await ensureSlicer(this.db, updated, slicerFromLive(live?.metadata))
  }

  private updateLive(s: Record<string, any>, watts: number | null): void {
    const ps = s.print_stats ?? {}
    const vs = s.virtual_sdcard ?? {}
    const job = this.live.jobId ? getJob(this.db, this.live.jobId) : null
    const slicer: SlicerInfo | null = job?.slicer_json ? JSON.parse(job.slicer_json) : null
    const cfs = cfsFromStatus(s.box, s.filament_rack)
    const active = ps.state === "printing" || ps.state === "paused" || !!job
    let filamentG: number | null = null
    let cost: number | null = null
    if (active && num(ps.filament_used) != null) {
      const jobCfs = job?.cfs_json ? parseCfs(job.cfs_json) : cfsStateFromStatus(s.box, s.filament_rack)
      const priced = priceJob({ filament_mm: ps.filament_used, total_duration: ps.total_duration ?? 0, energy_kwh: this.live.energyKwh, energy_cost: this.live.energyCost, slicer, cfs: jobCfs }, loadSettings(this.db))
      filamentG = priced.filament_g
      cost = priced.total_cost
    }
    const chamberFan = s["temperature_fan chamber_fan"] ?? {}
    let preparing: LiveState["preparing"] = null
    if (!this.live.jobId && looksLikePrep(ps.state ?? null, num(s.extruder?.target), num(s.heater_bed?.target))) {
      // When it began: the run of heating samples just recorded, else now
      preparing = this.live.preparing ?? { since: detectPrep(this.db, Date.now() / 1000 + 1) ?? Date.now() / 1000 }
    }
    if (preparing && !this.live.preparing) console.log("[collector] printer is preparing a print")
    this.live = {
      ...this.live,
      preparing,
      updatedAt: Date.now() / 1000,
      state: ps.state ?? null,
      filename: ps.filename || null,
      progress: num(vs.progress),
      layer: num(vs.layer),
      layerCount: num(vs.layer_count) ?? slicer?.layer_count ?? null,
      printDuration: num(ps.print_duration),
      estTime: slicer?.est_time ?? num(vs.cur_print_data?.metadata?.estimated_time),
      filamentMm: num(ps.filament_used),
      filamentG,
      cost,
      temps: {
        nozzle: { temp: num(s.extruder?.temperature), target: num(s.extruder?.target), power: num(s.extruder?.power) },
        bed: { temp: num(s.heater_bed?.temperature), target: num(s.heater_bed?.target), power: num(s.heater_bed?.power) },
        chamber: { temp: num(s["temperature_sensor chamber_temp"]?.temperature) ?? num(chamberFan.temperature), target: num(chamberFan.target) },
      },
      watts,
      cfs,
    }
  }

  // Keep job-window samples at full rate; thin everything else older than 30 days to one a minute
  private maintenance(): void {
    const cutoff = Date.now() / 1000 - 30 * 86400
    const res = this.db.query(`DELETE FROM samples WHERE ts < ? AND (CAST(ts AS INTEGER) % 60) >= 5
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE samples.ts BETWEEN COALESCE(jobs.prep_start, jobs.creality_start, jobs.start - 600) AND COALESCE(jobs.end, 1e12))`).run(cutoff)
    if (res.changes) console.log(`[collector] thinned ${res.changes} old samples`)
  }
}
