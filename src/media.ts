import type { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import { config } from "./config"
import { getJob, updateJob, type JobRow } from "./db"
import { mediaDir } from "./jobs"

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

interface Snapshot {
  buf: Buffer
  age: number // seconds since the bridge captured it
}

async function grab(): Promise<Snapshot | null> {
  try {
    const res = await fetch(config.snapshotUrl, { signal: AbortSignal.timeout(15_000) })
    if (!res.ok) return null
    const buf = Buffer.from(await res.arrayBuffer())
    return { buf, age: Number(res.headers.get("x-snapshot-age") ?? 0) }
  } catch {
    return null
  }
}

// The bridge serves a cached frame for 30 s and refreshes in the background once it is older, so a
// fresh picture is: wait out the cache, poke it, then collect the new capture (~7 s WebRTC setup).
export async function freshSnapshot(): Promise<Buffer | null> {
  let s = await grab()
  if (s && s.age <= 8) return s.buf
  if (s && s.age < 31) await sleep((31 - s.age) * 1000)
  await grab()
  await sleep(9000)
  for (let i = 0; i < 3; i++) {
    const next = await grab()
    if (next) s = next
    if (s && s.age <= 15) break
    await sleep(3000)
  }
  return s?.buf ?? null
}

export async function saveFinalSnapshot(db: Database, group: string): Promise<void> {
  const buf = await freshSnapshot()
  if (!buf) {
    console.warn(`[media] ${group}: no snapshot available`)
    return
  }
  const dir = mediaDir(group)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "final.jpg"), buf)
  updateJob(db, group, { snapshot: "final.jpg" })
  console.log(`[media] ${group}: saved final snapshot (${buf.length} B)`)
}

// Layer-change frames for the fallback timelapse; skips repeats of the same bridge capture
const lastCapture = new Map<string, number>()
export async function captureFrame(group: string): Promise<boolean> {
  const s = await grab()
  if (!s || s.age > 35) return false
  const capturedAt = Date.now() / 1000 - s.age
  if (Math.abs(capturedAt - (lastCapture.get(group) ?? 0)) < 3) return false
  lastCapture.set(group, capturedAt)
  const dir = path.join(mediaDir(group), "frames")
  fs.mkdirSync(dir, { recursive: true })
  const n = fs.readdirSync(dir).filter((f) => f.endsWith(".jpg")).length
  fs.writeFileSync(path.join(dir, `${String(n).padStart(5, "0")}.jpg`), s.buf)
  return true
}

// ---- Firmware timelapse (the K2 renders its own mp4 for most jobs) ----

const FW_DIR = "/mnt/UDISK/creality/userdata/delay_image"

export interface FirmwareVideo {
  id: number
  starttime: number
  gcodename: string
  video: string
  cover: string
  printtime: number
}

async function ssh(cmd: string, outFile?: string): Promise<string> {
  const proc = Bun.spawn(
    ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=accept-new", config.k2Ssh, cmd],
    { stdout: outFile ? Bun.file(outFile) : "pipe", stderr: "pipe" },
  )
  const timer = setTimeout(() => proc.kill(), 120_000)
  const code = await proc.exited
  clearTimeout(timer)
  if (code !== 0) throw new Error(`ssh exit ${code}: ${(await new Response(proc.stderr).text()).trim()}`)
  return outFile ? "" : new Response(proc.stdout as ReadableStream).text()
}

let sshError: string | null = null
export async function listFirmwareVideos(): Promise<FirmwareVideo[] | null> {
  if (!config.k2Ssh) return null
  try {
    const text = await ssh(`cat ${FW_DIR}/delay_image_info.json`)
    if (sshError) console.log("[media] K2 ssh reachable again")
    sshError = null
    return (JSON.parse(text).list ?? []) as FirmwareVideo[]
  } catch (err) {
    const msg = (err as Error).message
    if (msg !== sshError) console.warn(`[media] firmware timelapse list unavailable: ${msg}`)
    sshError = msg
    return null
  }
}

export function matchFirmwareVideo(list: FirmwareVideo[], filename: string, start: number, end: number): FirmwareVideo | null {
  const base = path.basename(filename)
  // The printer's clock starts at preheat, a few minutes before Moonraker's job start
  const hits = list.filter((v) => v.gcodename === base && v.starttime >= start - 1800 && v.starttime <= end)
  hits.sort((a, b) => Math.abs(a.starttime - start) - Math.abs(b.starttime - start))
  return hits[0] ?? null
}

async function importFirmware(group: string, v: FirmwareVideo): Promise<void> {
  const dir = mediaDir(group)
  fs.mkdirSync(dir, { recursive: true })
  const tmp = path.join(dir, "timelapse.mp4.part")
  await ssh(`cat '${v.video}'`, tmp)
  fs.renameSync(tmp, path.join(dir, "timelapse.mp4"))
  try {
    await ssh(`cat '${v.cover}'`, path.join(dir, "cover.png"))
  } catch (err) {
    console.warn(`[media] ${group}: cover not copied: ${(err as Error).message}`)
  }
}

export async function stitchFrames(group: string): Promise<boolean> {
  const dir = mediaDir(group)
  const framesDir = path.join(dir, "frames")
  if (!fs.existsSync(framesDir)) return false
  const frames = fs.readdirSync(framesDir).filter((f) => f.endsWith(".jpg")).sort()
  if (frames.length < 2) return false
  // Hold on the final snapshot for a second at the end
  const final = path.join(dir, "final.jpg")
  if (fs.existsSync(final)) {
    for (let i = 0; i < 15; i++) {
      fs.copyFileSync(final, path.join(framesDir, `${String(frames.length + i).padStart(5, "0")}.jpg`))
    }
  }
  const out = path.join(dir, "timelapse.mp4")
  const proc = Bun.spawn([
    config.ffmpeg, "-y", "-loglevel", "error", "-framerate", "15", "-i", path.join(framesDir, "%05d.jpg"),
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "23",
    "-movflags", "+faststart", out,
  ], { stderr: "pipe" })
  const code = await proc.exited
  if (code !== 0) {
    console.warn(`[media] ${group}: ffmpeg failed: ${await new Response(proc.stderr).text()}`)
    return false
  }
  return true
}

function groupInfo(db: Database, root: JobRow): { inProgress: boolean; end: number } {
  const rows = db.query<JobRow, [string, string]>("SELECT * FROM jobs WHERE job_id = ? OR merged_into = ?").all(root.job_id, root.job_id)
  return {
    inProgress: rows.some((r) => r.status === "in_progress" || !r.finalized),
    end: Math.max(...rows.map((r) => r.end ?? 0)),
  }
}

let sweeping = false
// Resolve each finished job's timelapse: firmware video if the printer made one, else our frames
export async function mediaSweep(db: Database): Promise<void> {
  if (sweeping) return
  sweeping = true
  try {
    const pending = db.query<JobRow, []>(
      "SELECT * FROM jobs WHERE media_state = 'pending' AND finalized = 1 AND merged_into IS NULL ORDER BY start",
    ).all()
    if (!pending.length) return
    const fw = await listFirmwareVideos()
    for (const root of pending) {
      const g = groupInfo(db, root)
      if (g.inProgress) continue
      const group = root.job_id
      const framesDir = path.join(mediaDir(group), "frames")
      const match = fw && matchFirmwareVideo(fw, root.filename, root.start, g.end)
      if (match) {
        try {
          await importFirmware(group, match)
          fs.rmSync(framesDir, { recursive: true, force: true })
          const hasCover = fs.existsSync(path.join(mediaDir(group), "cover.png"))
          updateJob(db, group, { media_state: "done", video: "timelapse.mp4", video_source: "firmware", cover: hasCover ? "cover.png" : null })
          console.log(`[media] ${group}: imported firmware timelapse ${match.id}`)
        } catch (err) {
          console.warn(`[media] ${group}: firmware import failed: ${(err as Error).message}`)
        }
        continue
      }
      const waited = Date.now() / 1000 - g.end
      if (waited < config.firmwareVideoWaitMs / 1000) continue
      if (await stitchFrames(group)) {
        fs.rmSync(framesDir, { recursive: true, force: true })
        updateJob(db, group, { media_state: "done", video: "timelapse.mp4", video_source: "own" })
        console.log(`[media] ${group}: stitched own timelapse`)
      } else if (fw) {
        // The printer is reachable and made no video, and we have no frames
        updateJob(db, group, { media_state: "none" })
      }
      // else: K2 unreachable over ssh; keep pending so a later sweep can import its video
    }
  } finally {
    sweeping = false
  }
}

export function currentFrameGroup(db: Database, jobId: string): string {
  const j = getJob(db, jobId)
  return j?.merged_into ?? jobId
}
