// Slicer facts from a Creality Print / Orca-style gcode file: per-filament estimates and the
// embedded thumbnail. The printer's Moonraker history keeps none of this ("slicer: Unknown").

export interface SlicerFilament {
  index: number
  type: string
  colour: string | null
  density: number | null
  name: string | null
  est_g: number
  est_mm: number
}

export interface SlicerInfo {
  source: "gcode" | "live"
  filaments: SlicerFilament[]
  est_time: number | null
  layer_count: number | null
}

const splitList = (v: string | undefined, sep: RegExp) => (v ? v.split(sep).map((s) => s.trim()) : [])
const nums = (v: string | undefined) => splitList(v, /[,;]/).map((s) => Number(s))

export function parseDuration(s: string): number | null {
  let total = 0
  let any = false
  for (const m of s.matchAll(/(\d+)\s*([dhms])/g)) {
    any = true
    total += Number(m[1]) * { d: 86400, h: 3600, m: 60, s: 1 }[m[2] as "d" | "h" | "m" | "s"]
  }
  return any ? total : null
}

export function normColour(c: string | null | undefined): string | null {
  if (!c) return null
  const hex = c.replace(/^#/, "").trim().toLowerCase()
  // CFS colours carry a leading alpha-ish digit ("01b04ae"); slicer colours are "#RRGGBB"
  const six = hex.length >= 6 ? hex.slice(-6) : ""
  return /^[0-9a-f]{6}$/.test(six) ? `#${six}` : null
}

export function parseGcode(text: string): SlicerInfo {
  const eq = new Map<string, string>()
  const colon = new Map<string, string>()
  for (const line of text.split("\n")) {
    if (line.charCodeAt(0) !== 59 /* ; */) continue
    let m = /^;\s*([^=:]+?)\s*=\s*(.*?)\s*$/.exec(line)
    if (m) {
      if (!eq.has(m[1])) eq.set(m[1], m[2])
      continue
    }
    m = /^;\s*([^=:]+?)\s*:\s*(.*?)\s*$/.exec(line)
    if (m && !colon.has(m[1])) colon.set(m[1], m[2])
  }
  const grams = nums(eq.get("filament used [g]"))
  const mm = nums(eq.get("filament used [mm]"))
  const types = splitList(eq.get("filament_type"), /;/)
  const colours = splitList(eq.get("filament_colour"), /;/)
  const densities = nums(eq.get("filament_density") ?? colon.get("filament_density"))
  const names = splitList(eq.get("filament_settings_id"), /;/).map((s) => s.replace(/^"|"$/g, "").replace(/ @.*$/, ""))
  const count = Math.max(grams.length, types.length)
  const filaments: SlicerFilament[] = []
  for (let i = 0; i < count; i++) {
    filaments.push({
      index: i,
      type: types[i] || types[0] || "PLA",
      colour: normColour(colours[i]),
      density: Number.isFinite(densities[i]) ? densities[i] : null,
      name: names[i] || null,
      est_g: Number.isFinite(grams[i]) ? grams[i] : 0,
      est_mm: Number.isFinite(mm[i]) ? mm[i] : 0,
    })
  }
  const time = eq.get("estimated printing time (normal mode)")
  const layers = colon.get("total layer number") ?? eq.get("total layers count")
  return {
    source: "gcode",
    filaments,
    est_time: time ? parseDuration(time) : null,
    layer_count: layers ? Number(layers) || null : null,
  }
}

// Largest embedded PNG thumbnail ("; thumbnail begin WxH len" ... "; thumbnail end")
export function extractThumbnail(text: string): Buffer | null {
  let best: { area: number; data: string } | null = null
  const re = /^; thumbnail begin (\d+)x(\d+) \d+\r?\n([\s\S]*?)^; thumbnail end/gm
  for (const m of text.slice(0, 2_000_000).matchAll(re)) {
    const area = Number(m[1]) * Number(m[2])
    if (!best || area > best.area) {
      best = { area, data: m[3].replace(/^;\s?/gm, "").replace(/\s+/g, "") }
    }
  }
  return best ? Buffer.from(best.data, "base64") : null
}

// The printer's own parse of the running file, from virtual_sdcard.cur_print_data.metadata
export function slicerFromLive(meta: any): SlicerInfo | null {
  if (!meta || !Array.isArray(meta.filament_used_g)) return null
  const type = meta.filament_type || "PLA"
  const colours: string[] = meta.default_filament_colour ?? []
  return {
    source: "live",
    filaments: meta.filament_used_g.map((g: string, i: number) => ({
      index: i,
      type,
      colour: normColour(colours[i]),
      density: null,
      name: null,
      est_g: Number(g) || 0,
      est_mm: 0,
    })),
    est_time: Number(meta.estimated_time) || null,
    layer_count: Number(meta.layer_count) || null,
  }
}
