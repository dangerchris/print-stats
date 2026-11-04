import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"

export interface JobRow {
  job_id: string
  filename: string
  status: string
  start: number
  end: number | null
  print_duration: number
  total_duration: number
  filament_mm: number
  filament_g: number | null
  merged_into: string | null
  creality_start: number | null
  prep_start: number | null // Creality's print preparation (heat, level, wipe) before the file started
  slicer_json: string | null
  cfs_json: string | null
  material_cost: number | null
  energy_kwh: number | null
  energy_source: string | null
  energy_cost: number | null
  machine_cost: number | null
  total_cost: number | null
  cost_inputs_json: string | null
  finalized: number
  seen_live: number
  media_state: string | null
  snapshot: string | null
  video: string | null
  video_source: string | null
  cover: string | null
  thumb: string | null
  updated_at: number
}

export interface FilamentRow {
  job_id: string
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

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  filename TEXT NOT NULL,
  status TEXT NOT NULL,
  start REAL NOT NULL,
  end REAL,
  print_duration REAL NOT NULL DEFAULT 0,
  total_duration REAL NOT NULL DEFAULT 0,
  filament_mm REAL NOT NULL DEFAULT 0,
  filament_g REAL,
  merged_into TEXT,
  creality_start REAL,
  prep_start REAL,
  slicer_json TEXT,
  cfs_json TEXT,
  material_cost REAL,
  energy_kwh REAL,
  energy_source TEXT,
  energy_cost REAL,
  machine_cost REAL,
  total_cost REAL,
  cost_inputs_json TEXT,
  finalized INTEGER NOT NULL DEFAULT 0,
  seen_live INTEGER NOT NULL DEFAULT 0,
  media_state TEXT,
  snapshot TEXT,
  video TEXT,
  video_source TEXT,
  cover TEXT,
  thumb TEXT,
  updated_at REAL NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS jobs_start ON jobs(start);
CREATE TABLE IF NOT EXISTS job_filament (
  job_id TEXT NOT NULL,
  idx INTEGER NOT NULL,
  slot TEXT,
  material TEXT NOT NULL,
  colour TEXT,
  name TEXT,
  est_g REAL NOT NULL,
  actual_g REAL NOT NULL,
  price_per_kg REAL NOT NULL,
  cost REAL NOT NULL,
  match TEXT NOT NULL,
  PRIMARY KEY (job_id, idx)
);
CREATE TABLE IF NOT EXISTS samples (
  ts REAL PRIMARY KEY,
  state TEXT,
  progress REAL,
  layer INTEGER,
  filament_mm REAL,
  nozzle REAL, nozzle_target REAL, nozzle_power REAL,
  bed REAL, bed_target REAL, bed_power REAL,
  chamber REAL, chamber_target REAL,
  watts REAL
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export function openDb(file: string): Database {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const db = new Database(file, { create: true })
  db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;")
  db.exec(SCHEMA)
  migrate(db)
  return db
}

// Columns added after the first deploy
function migrate(db: Database): void {
  const cols = new Set(db.query<{ name: string }, []>("PRAGMA table_info(jobs)").all().map((c) => c.name))
  if (!cols.has("prep_start")) db.exec("ALTER TABLE jobs ADD COLUMN prep_start REAL")
}

export function memoryDb(): Database {
  const db = new Database(":memory:")
  db.exec(SCHEMA)
  return db
}

export function getJob(db: Database, id: string): JobRow | null {
  return db.query<JobRow, [string]>("SELECT * FROM jobs WHERE job_id = ?").get(id)
}

export function updateJob(db: Database, id: string, fields: Partial<JobRow>): void {
  const keys = Object.keys(fields)
  if (!keys.length) return
  const sets = keys.map((k) => `${k} = $${k}`).join(", ")
  const params: Record<string, any> = { $id: id, $updated_at: Date.now() / 1000 }
  for (const k of keys) params[`$${k}`] = (fields as any)[k]
  db.query(`UPDATE jobs SET ${sets}, updated_at = $updated_at WHERE job_id = $id`).run(params)
}
