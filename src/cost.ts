import type { Database } from "bun:sqlite"
import { normColour, type SlicerInfo } from "./gcode"
import { DEFAULT_TOU, type TouSettings } from "./tou"

export interface CfsSlot {
  slot: string // T1A..T4D, or EXT for the side spool holder
  type: string | null
  colour: string | null
}

// CFS state captured for a job: loaded slots plus the print dialog's tool -> slot remap
export interface CfsState {
  slots: CfsSlot[]
  map: Record<string, string> | null
}

export interface MaterialSetting {
  pricePerKg: number
  density: number
}

export interface SlotOverride {
  slot: string
  colour: string | null // override applies only while that colour is loaded; null = any colour
  pricePerKg: number
  label?: string
}

// Energy estimate used until a power meter is connected: base load (board, motors, fans, camera, CFS)
// plus each heater's rated watts scaled by its Klipper duty cycle
export interface EnergyEstimate {
  enabled: boolean
  baseWatts: number
  nozzleWatts: number
  bedWatts: number
}

export interface Settings {
  currency: string
  diameter: number
  kwhRate: number
  machinePerHour: number
  materials: Record<string, MaterialSetting>
  slotOverrides: SlotOverride[]
  energyEstimate: EnergyEstimate
  tou: TouSettings // time-of-use rates; kwhRate applies when disabled
}

export const DEFAULT_SETTINGS: Settings = {
  currency: "$",
  diameter: 1.75,
  kwhRate: 0.13,
  machinePerHour: 0,
  materials: {
    PLA: { pricePerKg: 20, density: 1.24 },
    PETG: { pricePerKg: 22, density: 1.27 },
    ABS: { pricePerKg: 20, density: 1.04 },
    ASA: { pricePerKg: 25, density: 1.07 },
    TPU: { pricePerKg: 30, density: 1.21 },
    Other: { pricePerKg: 25, density: 1.24 },
  },
  slotOverrides: [],
  // Base K2 at 110 V is rated 450 W. Its bed runs at Klipper max_power 0.5, so 700 W at full duty is
  // ~350 W peak; with a 70 W hotend and ~40 W base load that totals the rated figure.
  energyEstimate: { enabled: true, baseWatts: 40, nozzleWatts: 70, bedWatts: 700 },
  tou: DEFAULT_TOU,
}

export function loadSettings(db: Database): Settings {
  const row = db.query<{ value: string }, []>("SELECT value FROM settings WHERE key = 'settings'").get()
  if (!row) return structuredClone(DEFAULT_SETTINGS)
  const saved = JSON.parse(row.value)
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...saved,
    materials: { ...DEFAULT_SETTINGS.materials, ...saved.materials },
    energyEstimate: { ...DEFAULT_SETTINGS.energyEstimate, ...saved.energyEstimate },
    tou: { ...DEFAULT_SETTINGS.tou, ...saved.tou },
  }
}

export function saveSettings(db: Database, s: Settings): void {
  db.query("INSERT INTO settings (key, value) VALUES ('settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .run(JSON.stringify(s))
}

export function gramsFromMm(mm: number, diameter: number, density: number): number {
  return (mm * Math.PI * (diameter / 2) ** 2 * density) / 1000
}

function material(s: Settings, type: string | null | undefined): MaterialSetting {
  const key = Object.keys(s.materials).find((k) => k.toLowerCase() === (type ?? "").toLowerCase())
  return s.materials[key ?? "Other"] ?? DEFAULT_SETTINGS.materials.Other
}

function colourDistance(a: string, b: string): number {
  const p = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16))
  const [x, y] = [p(a), p(b)]
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2])
}

// Slicer filament index -> CFS tool name: 0 -> T1A, 5 -> T2B
export const toolName = (i: number) => `T${Math.floor(i / 4) + 1}${"ABCD"[i % 4]}`

// Slicer filament -> CFS slot. For jobs seen live, the box's tool map (set in the print dialog) says
// which slot fed each filament. Otherwise match by colour among slots of the same material: exact
// first, else nearest.
export function matchSlot(type: string, colour: string | null, cfs: CfsSlot[], index = 0, map: Record<string, string> | null = null): { slot: CfsSlot | null; match: string } {
  if (map) {
    const physical = map[toolName(index)]
    const slot = physical && cfs.find((c) => c.slot === physical)
    if (slot) return { slot, match: "mapped" }
  }
  if (!cfs.length || !colour) return { slot: null, match: "type" }
  const sameType = cfs.filter((c) => c.colour && (!c.type || c.type.toLowerCase() === type.toLowerCase()))
  const pool = sameType.length ? sameType : cfs.filter((c) => c.colour)
  const exact = pool.filter((c) => c.colour === colour)
  if (exact.length === 1) return { slot: exact[0], match: "colour" }
  if (exact.length > 1) return { slot: exact[0], match: "ambiguous" }
  let best: CfsSlot | null = null
  let bestD = Infinity
  for (const c of pool) {
    const d = colourDistance(colour, c.colour!)
    if (d < bestD) [best, bestD] = [c, d]
  }
  return best ? { slot: best, match: "nearest" } : { slot: null, match: "type" }
}

export interface PricedFilament {
  idx: number
  slot: string | null
  material: string
  colour: string | null
  name: string | null
  est_g: number
  actual_g: number
  price_per_kg: number
  cost: number
  match: string
}

export interface PricedJob {
  filaments: PricedFilament[]
  filament_g: number
  material_cost: number
  energy_cost: number | null
  machine_cost: number
  total_cost: number
  inputs: Settings
}

export interface PriceInput {
  filament_mm: number
  total_duration: number
  energy_kwh: number | null
  energy_cost?: number | null // already priced by time of use; otherwise energy_kwh x kwhRate
  slicer: SlicerInfo | null
  cfs: CfsState
}

export function priceJob(job: PriceInput, s: Settings): PricedJob {
  // Actual extrusion (incl. purge/flush) is split across filaments by the slicer's per-filament weights
  let parts = (job.slicer?.filaments ?? []).filter((f) => f.est_g > 0)
  if (!parts.length) {
    const f = job.slicer?.filaments[0]
    parts = [{ index: 0, type: f?.type ?? "PLA", colour: f?.colour ?? null, density: null, name: null, est_g: 1, est_mm: 0 }]
  }
  const estTotal = parts.reduce((a, f) => a + f.est_g, 0)
  const filaments = parts.map((f) => {
    const mat = material(s, f.type)
    const mm = (job.filament_mm * f.est_g) / estTotal
    const actual_g = gramsFromMm(mm, s.diameter, mat.density)
    const { slot, match } = matchSlot(f.type, f.colour, job.cfs.slots, f.index, job.cfs.map)
    const override = slot && s.slotOverrides.find((o) => o.slot === slot.slot && (!o.colour || o.colour === slot.colour))
    const price_per_kg = override ? override.pricePerKg : mat.pricePerKg
    return {
      idx: f.index,
      slot: slot?.slot ?? null,
      material: f.type,
      colour: slot?.colour ?? f.colour,
      name: override?.label || f.name,
      est_g: job.slicer ? f.est_g : 0,
      actual_g,
      price_per_kg,
      cost: (actual_g / 1000) * price_per_kg,
      match: job.slicer ? match : "default",
    }
  })
  const filament_g = filaments.reduce((a, f) => a + f.actual_g, 0)
  const material_cost = filaments.reduce((a, f) => a + f.cost, 0)
  const energy_cost = job.energy_kwh == null ? null : job.energy_cost ?? job.energy_kwh * s.kwhRate
  const machine_cost = (s.machinePerHour * job.total_duration) / 3600
  return {
    filaments,
    filament_g,
    material_cost,
    energy_cost,
    machine_cost,
    total_cost: material_cost + (energy_cost ?? 0) + machine_cost,
    inputs: s,
  }
}

export function cfsStateFromStatus(box: any, rack?: any): CfsState {
  const map = box?.map && typeof box.map === "object" ? (box.map as Record<string, string>) : null
  return { slots: cfsFromStatus(box, rack), map }
}

// CFS slots from Moonraker's `box` object (+ the external spool holder)
export function cfsFromStatus(box: any, rack?: any): CfsSlot[] {
  const slots: CfsSlot[] = []
  for (const entry of box?.same_material ?? []) {
    const [, colour, names, type] = entry
    for (const slot of names ?? []) {
      slots.push({ slot, type: type || null, colour: normColour(colour) })
    }
  }
  if (rack && rack.color_value && rack.color_value !== "-1") {
    slots.push({ slot: "EXT", type: null, colour: normColour(rack.color_value) })
  }
  return slots.sort((a, b) => a.slot.localeCompare(b.slot))
}

