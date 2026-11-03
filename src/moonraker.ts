import { config } from "./config"

export interface HistoryJob {
  job_id: string
  filename: string
  status: string
  start_time: number
  end_time: number | null
  print_duration: number
  total_duration: number
  filament_used: number
  exists?: boolean
}

export const OBJECTS = [
  "print_stats",
  "virtual_sdcard",
  "box",
  "filament_rack",
  "extruder",
  "heater_bed",
  "temperature_fan chamber_fan",
  "temperature_sensor chamber_temp",
  "pause_resume",
]

async function get(path: string, timeoutMs = 8000): Promise<any> {
  const res = await fetch(config.moonraker + path, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`moonraker ${path}: HTTP ${res.status}`)
  return ((await res.json()) as any).result
}

export async function queryObjects(): Promise<Record<string, any>> {
  const q = OBJECTS.map(encodeURIComponent).join("&")
  return (await get(`/printer/objects/query?${q}`)).status
}

export async function historyList(maxJobs = Infinity): Promise<HistoryJob[]> {
  const out: HistoryJob[] = []
  const limit = 100
  for (let start = 0; out.length < maxJobs; start += limit) {
    const page = await get(`/server/history/list?limit=${limit}&start=${start}&order=desc`)
    out.push(...page.jobs)
    if (page.jobs.length < limit) break
  }
  return out
}

export async function fetchGcode(filename: string): Promise<string> {
  const path = filename.split("/").map(encodeURIComponent).join("/")
  const res = await fetch(`${config.moonraker}/server/files/gcodes/${path}`, { signal: AbortSignal.timeout(120_000) })
  if (!res.ok) throw new Error(`gcode ${filename}: HTTP ${res.status}`)
  return res.text()
}
