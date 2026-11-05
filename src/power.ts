import fs from "node:fs"
import TuyAPI from "tuyapi"
import { config } from "./config"

// Energy metering: the printer's Eightree plug, read locally over the Tuya protocol

export interface PowerReading {
  watts: number
  on?: boolean
  volts?: number
}

export interface PowerSource {
  name: string
  read(): Promise<PowerReading | null>
  setSwitch?(on: boolean): Promise<PowerReading>
}

export const noPower: PowerSource = {
  name: "none",
  read: async () => null,
}

// Standard Tuya outlet datapoints
const SWITCH_DPS = "1"
const POWER_DPS = "5" // tenths of a watt
const VOLTAGE_DPS = "6" // tenths of a volt
const READ_TIMEOUT_MS = 4000
const RECONNECT_MS = 30_000

function withTimeout<T>(p: Promise<T>, label: string): Promise<T> {
  let timer: Timer
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out`)), READ_TIMEOUT_MS)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

// Connects for each read or switch and disconnects straight after. The plug accepts only one
// local connection at a time, and cottage-mon reads it too, so neither may hold it open. A
// 3.3 connection is a plain TCP connect with no session handshake, so this is cheap. When
// both connect at once one read fails; only FAILURES_BEFORE_BACKOFF failures in a row (the
// plug unplugged or off the network) pause reads for RECONNECT_MS.
const FAILURES_BEFORE_BACKOFF = 3

export class TuyaPower implements PowerSource {
  name: string
  private retryAt = 0
  private failures = 0

  constructor(private opts: { id: string; key: string; ip: string; version: string }) {
    this.name = `tuya ${opts.ip}`
  }

  // Run fn on a fresh connection, always disconnecting afterwards
  private async withDevice<T>(fn: (d: TuyAPI) => Promise<T>): Promise<T> {
    const d = new TuyAPI({ id: this.opts.id, key: this.opts.key, ip: this.opts.ip, version: this.opts.version, issueGetOnConnect: false })
    d.on("error", () => {}) // surfaced through the rejected calls
    try {
      await withTimeout(d.connect(), "connect")
      return await fn(d)
    } finally {
      try {
        d.disconnect()
      } catch {}
    }
  }

  // One command at a time, so this app never holds two connections
  private queue: Promise<unknown> = Promise.resolve()
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => {})
    return next
  }

  private async fetchReading(d: TuyAPI): Promise<PowerReading> {
    const status = (await withTimeout(d.get({ schema: true }), "get")) as { dps?: Record<string, unknown> }
    const dps = status?.dps ?? {}
    if (typeof dps[POWER_DPS] !== "number") throw new Error("no power datapoint")
    return {
      watts: (dps[POWER_DPS] as number) / 10,
      on: dps[SWITCH_DPS] === true,
      volts: typeof dps[VOLTAGE_DPS] === "number" ? (dps[VOLTAGE_DPS] as number) / 10 : undefined,
    }
  }

  private succeeded(): void {
    if (this.failures >= FAILURES_BEFORE_BACKOFF) console.log("[power] plug reachable again")
    this.failures = 0
    this.retryAt = 0
  }

  private failed(err: unknown): void {
    this.failures++
    if (this.failures === FAILURES_BEFORE_BACKOFF) {
      console.warn(`[power] plug read failed ${this.failures} times: ${(err as Error).message}`)
    }
    if (this.failures >= FAILURES_BEFORE_BACKOFF) this.retryAt = Date.now() + RECONNECT_MS
  }

  read(): Promise<PowerReading | null> {
    if (Date.now() < this.retryAt) return Promise.resolve(null)
    return this.serial(async () => {
      try {
        const r = await this.withDevice((d) => this.fetchReading(d))
        this.succeeded()
        return r
      } catch (err) {
        this.failed(err)
        return null
      }
    })
  }

  // Someone is waiting on this, so it ignores the backoff and throws on failure
  setSwitch(on: boolean): Promise<PowerReading> {
    return this.serial(async () => {
      try {
        const r = await this.withDevice(async (d) => {
          await withTimeout(d.set({ dps: Number(SWITCH_DPS), set: on }), "set")
          return this.fetchReading(d)
        })
        this.succeeded()
        return r
      } catch (err) {
        this.failed(err)
        throw err
      }
    })
  }
}

export function createPowerSource(): PowerSource {
  if (!fs.existsSync(config.tuyaDevicesFile)) return noPower
  const entries = JSON.parse(fs.readFileSync(config.tuyaDevicesFile, "utf8")) as Record<string, string>[]
  const d = entries.find((e) => e.name === config.tuyaDevice) ?? (entries.length === 1 ? entries[0] : undefined)
  if (!d?.id || !d.key || !d.ip) {
    console.warn(`[power] no usable "${config.tuyaDevice}" entry in ${config.tuyaDevicesFile}`)
    return noPower
  }
  return new TuyaPower({ id: d.id, key: d.key, ip: d.ip, version: String(d.version ?? "3.3") })
}

export interface DutySample {
  ts: number
  nozzle_power: number | null
  bed_power: number | null
}

export function estimateWatts(s: DutySample, e: { baseWatts: number; nozzleWatts: number; bedWatts: number }): number {
  return e.baseWatts + (s.nozzle_power ?? 0) * e.nozzleWatts + (s.bed_power ?? 0) * e.bedWatts
}

// kWh from watt samples (trapezoid), ignoring gaps longer than maxGap seconds
export function integrateKwh(samples: { ts: number; watts: number | null }[], maxGap = 60): number | null {
  return integrateEnergy(samples, () => 0, maxGap)?.kwh ?? null
}

// kWh and cost together, each interval priced at the rate in force at its midpoint
export function integrateEnergy(samples: { ts: number; watts: number | null }[], rate: (ts: number) => number, maxGap = 60):
  { kwh: number; cost: number; covered: number } | null {
  let wh = 0
  let cost = 0
  let covered = 0
  let any = false
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    if (a.watts == null || b.watts == null) continue
    const dt = b.ts - a.ts
    if (dt <= 0 || dt > maxGap) continue
    const segWh = ((a.watts + b.watts) / 2) * (dt / 3600)
    wh += segWh
    cost += (segWh / 1000) * rate((a.ts + b.ts) / 2)
    covered += dt
    any = true
  }
  return any ? { kwh: wh / 1000, cost, covered } : null
}
