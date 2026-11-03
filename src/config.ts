import path from "node:path"

const env = process.env
const dataDir = path.resolve(env.DATA_DIR ?? "./data")

export const config = {
  port: Number(env.PORT ?? 8790),
  moonraker: (env.MOONRAKER_URL ?? "http://printer.local:7125").replace(/\/$/, ""),
  // ring-bridge camera endpoint (the K2 camera is WebRTC-only; the bridge decodes a keyframe to JPEG)
  snapshotUrl: env.SNAPSHOT_URL ?? "http://localhost:3000/api/ring/k2/snapshot",
  // Firmware timelapses are pulled over SSH; empty disables the import
  k2Ssh: env.K2_SSH ?? "root@printer.local",
  dataDir,
  mediaDir: path.join(dataDir, "media"),
  dbPath: path.join(dataDir, "stats.sqlite"),
  publicDir: path.resolve(import.meta.dir, "../public"),
  password: env.DASH_PASSWORD ?? "",
  // Cloudflare Access team domain in front of the tunnel; its JWT counts as a login
  accessTeam: env.CF_ACCESS_TEAM ?? "",
  accessAud: env.CF_ACCESS_AUD || undefined,
  sessionSecret: env.SESSION_SECRET ?? "",
  pollMs: Number(env.POLL_MS ?? 5000),
  reconcileMs: 30_000,
  // Layer-change frames for the fallback timelapse; the bridge caches snapshots for 30 s anyway
  frameIntervalMs: Number(env.FRAME_INTERVAL_MS ?? 30_000),
  // How long after a job ends to wait for the firmware timelapse before stitching our own
  firmwareVideoWaitMs: 15 * 60_000,
  ffmpeg: env.FFMPEG ?? "ffmpeg",
}
