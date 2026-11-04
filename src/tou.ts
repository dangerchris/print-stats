// Time-of-use electricity pricing. Defaults are Ontario's TOU schedule (OEB): weekends and the
// listed statutory holidays are off-peak all day; weekday bands differ between winter and summer.

export type Band = "off" | "mid" | "on"

export interface TouSettings {
  enabled: boolean
  timeZone: string
  rates: Record<Band, number>
  // Weekday hours as "start-end" ranges (end exclusive), e.g. "7-11,17-19"; everything else is off-peak
  winter: { on: string; mid: string } // November to April
  summer: { on: string; mid: string } // May to October
  holidays: "ontario" | "none"
}

export const DEFAULT_TOU: TouSettings = {
  enabled: true,
  timeZone: "America/Toronto",
  rates: { off: 0.098, mid: 0.157, on: 0.203 },
  winter: { on: "7-11,17-19", mid: "11-17" },
  summer: { on: "11-17", mid: "7-11,17-19" },
  holidays: "ontario",
}

export const BAND_LABEL: Record<Band, string> = { off: "Off-peak", mid: "Mid-peak", on: "On-peak" }

export function parseHours(spec: string): Set<number> | null {
  const hours = new Set<number>()
  for (const part of spec.split(",").map((p) => p.trim()).filter(Boolean)) {
    const m = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(part)
    if (!m) return null
    const [a, b] = [Number(m[1]), Number(m[2])]
    if (a > 23 || b > 24 || a >= b) return null
    for (let h = a; h < b; h++) hours.add(h)
  }
  return hours
}

export function validTou(t: any): t is TouSettings {
  if (!t || typeof t !== "object" || typeof t.enabled !== "boolean" || typeof t.timeZone !== "string") return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: t.timeZone })
  } catch {
    return false
  }
  return (["off", "mid", "on"] as const).every((b) => typeof t.rates?.[b] === "number" && t.rates[b] >= 0) &&
    ["winter", "summer"].every((s) => typeof t[s]?.on === "string" && typeof t[s]?.mid === "string" &&
      parseHours(t[s].on) && parseHours(t[s].mid)) &&
    (t.holidays === "ontario" || t.holidays === "none")
}

const ymd = (y: number, m: number, d: number) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`
const weekday = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d)).getUTCDay()

// nth (1-based) given weekday of a month
function nthWeekday(y: number, m: number, dow: number, n: number): number {
  const first = weekday(y, m, 1)
  return 1 + ((dow - first + 7) % 7) + (n - 1) * 7
}

function easter(y: number): [number, number] {
  const a = y % 19, b = Math.floor(y / 100), c = y % 100, d = Math.floor(b / 4), e = b % 4
  const f = Math.floor((b + 8) / 25), g = Math.floor((b - f + 1) / 3), h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4), k = c % 4, l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  return [Math.floor((h + l - 7 * m + 114) / 31), ((h + l - 7 * m + 114) % 31) + 1]
}

// The OEB's off-peak holidays. Fixed-date ones falling on a weekend move to the next free weekday.
const holidayCache = new Map<number, Set<string>>()
export function ontarioHolidays(y: number): Set<string> {
  const cached = holidayCache.get(y)
  if (cached) return cached
  const out = new Set<string>()
  const [em, ed] = easter(y)
  const goodFriday = new Date(Date.UTC(y, em - 1, ed - 2))
  out.add(ymd(y, goodFriday.getUTCMonth() + 1, goodFriday.getUTCDate()))
  out.add(ymd(y, 2, nthWeekday(y, 2, 1, 3))) // Family Day: 3rd Monday of February
  const may24 = weekday(y, 5, 24)
  out.add(ymd(y, 5, 24 - ((may24 + 6) % 7))) // Victoria Day: Monday on or before May 24
  out.add(ymd(y, 8, nthWeekday(y, 8, 1, 1))) // Civic Holiday
  out.add(ymd(y, 9, nthWeekday(y, 9, 1, 1))) // Labour Day
  out.add(ymd(y, 10, nthWeekday(y, 10, 1, 2))) // Thanksgiving
  for (const [m, d] of [[1, 1], [7, 1], [12, 25], [12, 26]]) {
    const date = new Date(Date.UTC(y, m - 1, d))
    const key = () => ymd(y, date.getUTCMonth() + 1, date.getUTCDate())
    while (date.getUTCDay() === 0 || date.getUTCDay() === 6 || out.has(key())) date.setUTCDate(date.getUTCDate() + 1)
    out.add(key())
  }
  holidayCache.set(y, out)
  return out
}

// Bands change on whole local hours, so the lookup is cached per UTC hour (whole-hour time zones)
const formatters = new Map<string, Intl.DateTimeFormat>()
const bandCache = new Map<string, Band>()

export function bandAt(ts: number, t: TouSettings): Band {
  const hourKey = Math.floor(ts / 3600)
  const cacheKey = `${hourKey}|${t.timeZone}|${t.winter.on}|${t.winter.mid}|${t.summer.on}|${t.summer.mid}|${t.holidays}`
  const hit = bandCache.get(cacheKey)
  if (hit) return hit
  let fmt = formatters.get(t.timeZone)
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-CA", {
      timeZone: t.timeZone, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", hourCycle: "h23",
    })
    formatters.set(t.timeZone, fmt)
  }
  const p = Object.fromEntries(fmt.formatToParts(new Date(ts * 1000)).map((x) => [x.type, x.value]))
  const [y, m, d, h] = [Number(p.year), Number(p.month), Number(p.day), Number(p.hour)]
  const dow = weekday(y, m, d)
  let band: Band = "off"
  if (dow !== 0 && dow !== 6 && !(t.holidays === "ontario" && ontarioHolidays(y).has(ymd(y, m, d)))) {
    const season = m >= 5 && m <= 10 ? t.summer : t.winter
    band = parseHours(season.on)?.has(h) ? "on" : parseHours(season.mid)?.has(h) ? "mid" : "off"
  }
  if (bandCache.size > 5000) bandCache.clear()
  bandCache.set(cacheKey, band)
  return band
}

export function rateAt(ts: number, s: { kwhRate: number; tou: TouSettings }): number {
  return s.tou.enabled ? s.tou.rates[bandAt(ts, s.tou)] : s.kwhRate
}

// Cost of a constant draw over [from, to], walking the span in steps no longer than an hour
export function spanCost(from: number, to: number, watts: number, s: { kwhRate: number; tou: TouSettings }): number {
  let cost = 0
  for (let t = from; t < to;) {
    const next = Math.min(to, (Math.floor(t / 3600) + 1) * 3600)
    cost += ((watts * (next - t)) / 3600 / 1000) * rateAt((t + next) / 2, s)
    t = next
  }
  return cost
}
