// Energy metering. Nothing is connected yet; once the Eightree plug is installed, add a provider
// (Tuya local via tuyapi, or Matter) that returns live watts and the plug's kWh counter.

export interface PowerReading {
  watts: number
  kwhTotal?: number
}

export interface PowerSource {
  name: string
  read(): Promise<PowerReading | null>
}

export const noPower: PowerSource = {
  name: "none",
  read: async () => null,
}

export function createPowerSource(): PowerSource {
  return noPower
}

// kWh from watt samples (trapezoid), ignoring gaps longer than maxGap seconds
export function integrateKwh(samples: { ts: number; watts: number | null }[], maxGap = 60): number | null {
  let wh = 0
  let any = false
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1]
    const b = samples[i]
    if (a.watts == null || b.watts == null) continue
    const dt = b.ts - a.ts
    if (dt <= 0 || dt > maxGap) continue
    wh += ((a.watts + b.watts) / 2) * (dt / 3600)
    any = true
  }
  return any ? wh / 1000 : null
}
