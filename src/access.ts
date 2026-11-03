import crypto from "node:crypto"

// Cloudflare Access sits in front of the tunnel hostname. Its signed JWT (Cf-Access-Jwt-Assertion)
// is verified against the team's published keys so a forged header can't stand in for a login.

let keys = new Map<string, crypto.KeyObject>()
let fetchedAt = 0

async function loadKeys(teamDomain: string, force = false): Promise<void> {
  if (!force && Date.now() - fetchedAt < 3600_000 && keys.size) return
  const res = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`, { signal: AbortSignal.timeout(8000) })
  if (!res.ok) throw new Error(`access certs: HTTP ${res.status}`)
  const body = (await res.json()) as { keys: ({ kid: string } & Record<string, any>)[] }
  keys = new Map(body.keys.map((k) => [k.kid, crypto.createPublicKey({ key: k as any, format: "jwk" })]))
  fetchedAt = Date.now()
}

const b64url = (s: string) => Buffer.from(s, "base64url")

export async function verifyAccessJwt(token: string | null, teamDomain: string, aud?: string): Promise<string | null> {
  if (!token || !teamDomain) return null
  const parts = token.split(".")
  if (parts.length !== 3) return null
  try {
    const header = JSON.parse(b64url(parts[0]).toString())
    const payload = JSON.parse(b64url(parts[1]).toString())
    if (header.alg !== "RS256") return null
    await loadKeys(teamDomain)
    if (!keys.has(header.kid)) await loadKeys(teamDomain, true)
    const key = keys.get(header.kid)
    if (!key) return null
    const ok = crypto.verify("RSA-SHA256", Buffer.from(`${parts[0]}.${parts[1]}`), key, b64url(parts[2]))
    const now = Date.now() / 1000
    if (!ok || payload.exp < now || payload.iss !== `https://${teamDomain}`) return null
    if (aud && !(Array.isArray(payload.aud) ? payload.aud : [payload.aud]).includes(aud)) return null
    return payload.email ?? payload.sub ?? "access"
  } catch (err) {
    console.warn(`[auth] access jwt check failed: ${(err as Error).message}`)
    return null
  }
}
