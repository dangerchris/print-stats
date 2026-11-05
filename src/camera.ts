import { config } from "./config"

// Live camera. ring-bridge turns the K2's WebRTC feed into a growing MPEG-TS stream, which the
// dashboard plays with mpegts.js. print-stats proxies it (the tunnel only reaches print-stats) and
// stops the bridge's call shortly after its last viewer leaves, unless something else (the TV app)
// had started that call.

const snap = new URL(config.snapshotUrl)
const bridge = snap.origin
const cameraId = /\/api\/ring\/([^/]+)\/snapshot/.exec(snap.pathname)?.[1] ?? "k2"
const streamUrl = `${bridge}/streams/${cameraId}/stream.ts`
const STOP_GRACE_MS = 15_000

let viewers = 0
let ownCall = false
let stopTimer: Timer | null = null

// The bridge answers 410 at once when no call is running, otherwise starts streaming
async function callActive(): Promise<boolean> {
  const ctl = new AbortController()
  try {
    const res = await fetch(streamUrl, { signal: ctl.signal })
    return res.ok
  } catch {
    return false
  } finally {
    ctl.abort()
  }
}

async function stopCall(reason: string): Promise<void> {
  if (!ownCall) return
  ownCall = false
  console.log(`[camera] stopping live stream (${reason})`)
  await fetch(`${bridge}/api/ring/${cameraId}/stop`, { method: "POST", signal: AbortSignal.timeout(10_000) }).catch(() => {})
}

export async function liveStream(req: Request): Promise<Response> {
  if (stopTimer) clearTimeout(stopTimer)
  stopTimer = null
  if (!(await callActive())) {
    console.log("[camera] starting live stream")
    const res = await fetch(`${bridge}/api/ring/${cameraId}/start`, { method: "POST", signal: AbortSignal.timeout(95_000) })
    if (!res.ok) return new Response(`camera start failed: HTTP ${res.status}`, { status: 502 })
    ownCall = true
  }
  const upstreamCtl = new AbortController()
  const upstream = await fetch(streamUrl, { signal: upstreamCtl.signal }).catch(() => null)
  if (!upstream?.ok || !upstream.body) return new Response("camera stream unavailable", { status: 502 })

  viewers++
  let done = false
  const leave = () => {
    if (done) return
    done = true
    upstreamCtl.abort()
    viewers--
    if (viewers === 0 && ownCall) stopTimer = setTimeout(() => viewers === 0 && stopCall("no viewers"), STOP_GRACE_MS)
  }
  req.signal.addEventListener("abort", leave)
  const chunks = joinAtKeyframe(upstream.body.getReader() as Reader)
  const body = new ReadableStream<Uint8Array>({
    async pull(ctl) {
      try {
        const { value, done: end } = await chunks.next()
        if (end) {
          ctl.close()
          leave()
        } else ctl.enqueue(value)
      } catch {
        ctl.close()
        leave()
      }
    },
    cancel: leave,
  })
  return new Response(body, { headers: { "Content-Type": "video/mp2t", "Cache-Control": "no-store" } })
}

// The bridge sends each new reader everything since its call began (many MB once a call has run a
// while). The backlog arrives in one burst, so the first JOIN_WINDOW_MS of data is cut to start at
// its last keyframe (the camera sends one a second), with the stream's PAT and PMT in front.
const TS = 188
const JOIN_WINDOW_MS = 300

export function trimToKeyframe(data: Uint8Array): Uint8Array {
  const n = Math.floor(data.length / TS)
  let last = -1
  let pat: Uint8Array | null = null
  let pmt: Uint8Array | null = null
  let pmtPid = -1
  for (let i = 0; i < n; i++) {
    const o = i * TS
    if (data[o] !== 0x47) return data // not aligned MPEG-TS: leave it alone
    const pusi = data[o + 1] & 0x40
    const pid = ((data[o + 1] & 0x1f) << 8) | data[o + 2]
    if (pid === 0 && pusi) {
      pat = data.subarray(o, o + TS)
      // First program entry after the pointer field and the 8-byte section header
      const sec = o + 5 + data[o + 4]
      for (let e = sec + 8; e + 4 <= o + TS && e < sec + 3 + (((data[sec + 1] & 0x0f) << 8) | data[sec + 2]) - 4; e += 4) {
        if (((data[e] << 8) | data[e + 1]) !== 0) {
          pmtPid = ((data[e + 2] & 0x1f) << 8) | data[e + 3]
          break
        }
      }
    } else if (pid === pmtPid && pusi) pmt = data.subarray(o, o + TS)
    // Start of a PES with the adaptation field's random_access_indicator set: a keyframe
    const adapt = data[o + 3] & 0x20
    if (pusi && adapt && data[o + 4] > 0 && data[o + 5] & 0x40) last = i
  }
  if (last <= 0 || !pat || !pmt) return data
  const tail = data.subarray(last * TS)
  const out = new Uint8Array(2 * TS + tail.length)
  out.set(pat, 0)
  out.set(pmt, TS)
  out.set(tail, 2 * TS)
  return out
}

type Reader = { read(): Promise<{ done: boolean; value?: Uint8Array }> }

async function* joinAtKeyframe(reader: Reader): AsyncGenerator<Uint8Array> {
  const buf: Uint8Array[] = []
  let pending: ReturnType<Reader["read"]> | null = null
  const deadline = Date.now() + JOIN_WINDOW_MS
  for (;;) {
    pending ??= reader.read()
    const left = deadline - Date.now()
    if (left <= 0) break
    const r = await Promise.race([pending, Bun.sleep(left).then(() => null)])
    if (!r) break
    pending = null
    if (r.done) {
      yield* buf
      return
    }
    if (r.value) buf.push(r.value)
  }
  const size = buf.reduce((a, b) => a + b.length, 0)
  if (size) {
    const all = new Uint8Array(size)
    let off = 0
    for (const b of buf) {
      all.set(b, off)
      off += b.length
    }
    const trimmed = trimToKeyframe(all)
    if (trimmed.length < size) console.log(`[camera] viewer joined at the latest keyframe, skipping ${((size - trimmed.length) / 1e6).toFixed(1)} MB`)
    yield trimmed
  }
  if (pending) {
    const r = await pending
    if (r.done) return
    if (r.value) yield r.value
  }
  for (;;) {
    const r = await reader.read()
    if (r.done) return
    if (r.value) yield r.value
  }
}

// Player errors reported by the dashboard, so they show up in the service log
export function logPlayerError(body: unknown): void {
  console.warn(`[camera] player error: ${JSON.stringify(body).slice(0, 500)}`)
}

// A job is ending: the final snapshot needs the camera, which can't snapshot while streaming
export async function releaseCamera(): Promise<void> {
  await stopCall("job ended, taking the final snapshot")
}

export async function cameraSnapshot(): Promise<Response> {
  const res = await fetch(config.snapshotUrl, { signal: AbortSignal.timeout(20_000) }).catch(() => null)
  if (!res?.ok) return new Response("no snapshot", { status: 502 })
  return new Response(res.body, {
    headers: { "Content-Type": res.headers.get("content-type") ?? "image/jpeg", "Cache-Control": "no-store",
      "X-Snapshot-Age": res.headers.get("x-snapshot-age") ?? "" },
  })
}
