import { describe, expect, test } from "bun:test"
import { cfsFromStatus, cfsStateFromStatus, DEFAULT_SETTINGS, gramsFromMm, matchSlot, priceJob } from "../src/cost"
import { extractThumbnail, normColour, parseDuration, parseGcode } from "../src/gcode"
import { memoryDb, getJob, updateJob } from "../src/db"
import { linkFragment, upsertHistoryJob } from "../src/jobs"
import { matchFirmwareVideo } from "../src/media"
import { integrateKwh } from "../src/power"
import { prettyName } from "../src/server"
import printing from "./fixtures/printing.json"

const FOUR_COLOUR = `; HEADER_BLOCK_START
; total layer number: 192
; filament_density: 1.24,1.24,1.24,1.24
; HEADER_BLOCK_END
; thumbnail begin 2x2 8
; iVBORw0K
; thumbnail end
; thumbnail begin 4x4 8
; iVBORw0KGgo=
; thumbnail end
G1 X0
; filament used [mm] = 1716.67, 923.12, 1452.36, 635.96
; filament used [g] = 5.12, 2.75, 4.33, 1.90
; filament used [mm]: 4728.12
; estimated printing time (normal mode) = 32m 23s
; filament_colour = #ff0000;#ffffff;#0000ff;#000000
; filament_density = 1.24,1.24,1.24,1.24
; filament_settings_id = "CR-PLA @Creality K2 0.4 nozzle";;;
; filament_type = PLA;PLA;PLA;PETG
`

describe("gcode", () => {
  test("parses per-filament estimates", () => {
    const info = parseGcode(FOUR_COLOUR)
    expect(info.filaments.map((f) => f.est_g)).toEqual([5.12, 2.75, 4.33, 1.9])
    expect(info.filaments.map((f) => f.colour)).toEqual(["#ff0000", "#ffffff", "#0000ff", "#000000"])
    expect(info.filaments[3].type).toBe("PETG")
    expect(info.filaments[0].name).toBe("CR-PLA")
    expect(info.filaments[0].est_mm).toBeCloseTo(1716.67)
    expect(info.est_time).toBe(32 * 60 + 23)
    expect(info.layer_count).toBe(192)
  })
  test("picks the largest thumbnail", () => {
    expect(extractThumbnail(FOUR_COLOUR)?.toString("base64")).toBe("iVBORw0KGgo=")
  })
  test("durations and colours", () => {
    expect(parseDuration("1h 57m 14s")).toBe(7034)
    expect(normColour("01b04ae")).toBe("#1b04ae")
    expect(normColour("#545454")).toBe("#545454")
    expect(normColour("-1")).toBeNull()
  })
})

describe("cost", () => {
  test("mm to grams matches the slicer for job 00000C", () => {
    // 8652 mm of PLA actually extruded; slicer estimated 25.65 g at density 1.25
    expect(gramsFromMm(8652.45, 1.75, 1.24)).toBeCloseTo(25.8, 1)
  })

  const cfs = cfsFromStatus(printing.result.status.box)
  test("reads CFS slots", () => {
    expect(cfs.map((c) => `${c.slot}:${c.colour}:${c.type}`)).toEqual([
      "T1A:#1b04ae:PLA", "T1B:#000000:PLA", "T1C:#ffffff:PLA", "T1D:#3ddf57:PLA",
    ])
  })

  test("maps slicer colours to slots", () => {
    expect(matchSlot("PLA", "#3ddf57", cfs)).toMatchObject({ slot: { slot: "T1D" }, match: "colour" })
    expect(matchSlot("PLA", "#545454", cfs)).toMatchObject({ slot: { slot: "T1A" }, match: "nearest" })
    // The live job's dialog mapping wins: filament 0 (T1A) was fed from T1B
    const state = cfsStateFromStatus(printing.result.status.box)
    expect(matchSlot("PLA", "#545454", state.slots, 0, state.map)).toMatchObject({ slot: { slot: "T1B" }, match: "mapped" })
    expect(matchSlot("PLA", null, cfs)).toMatchObject({ slot: null, match: "type" })
  })

  test("splits actual extrusion by slicer weights and applies overrides", () => {
    const slicer = parseGcode(FOUR_COLOUR)
    slicer.filaments[3].type = "PLA"
    const s = { ...DEFAULT_SETTINGS, slotOverrides: [{ slot: "T1C", colour: "#ffffff", pricePerKg: 40 }] }
    const p = priceJob({ filament_mm: 5595.73, total_duration: 2320, energy_kwh: 0.5, slicer, cfs: { slots: cfs, map: null } }, s)
    expect(p.filaments.length).toBe(4)
    const total = gramsFromMm(5595.73, 1.75, 1.24)
    expect(p.filament_g).toBeCloseTo(total, 6)
    const white = p.filaments.find((f) => f.colour === "#ffffff")!
    expect(white.slot).toBe("T1C")
    expect(white.price_per_kg).toBe(40)
    expect(white.actual_g).toBeCloseTo((total * 2.75) / 14.1, 6)
    expect(p.energy_cost).toBeCloseTo(0.5 * s.kwhRate)
    expect(p.total_cost).toBeCloseTo(p.material_cost + p.energy_cost!)
  })

  test("prices a job with no slicer data as default material", () => {
    const p = priceJob({ filament_mm: 1000, total_duration: 3600, energy_kwh: null, slicer: null, cfs: { slots: [], map: null } },
      { ...DEFAULT_SETTINGS, machinePerHour: 1 })
    expect(p.filaments[0]).toMatchObject({ material: "PLA", match: "default", slot: null })
    expect(p.machine_cost).toBe(1)
    expect(p.energy_cost).toBeNull()
  })
})

describe("jobs", () => {
  const h = (over: object) => ({
    job_id: "00000D", filename: "a.gcode", status: "in_progress", start_time: 1000, end_time: null,
    print_duration: 0, total_duration: 0, filament_used: 0, ...over,
  })

  test("detects the in_progress -> terminal transition once", () => {
    const db = memoryDb()
    expect(upsertHistoryJob(db, h({})).isNew).toBe(true)
    expect(upsertHistoryJob(db, h({ filament_used: 0 })).ended).toBe(false)
    const r = upsertHistoryJob(db, h({ status: "completed", end_time: 4000, filament_used: 8652 }))
    expect(r.ended).toBe(true)
    expect(r.job.filament_mm).toBe(8652)
    expect(upsertHistoryJob(db, h({ status: "completed", end_time: 4000, filament_used: 8652 })).ended).toBe(false)
  })

  test("links a resumed fragment to the first part", () => {
    const db = memoryDb()
    upsertHistoryJob(db, h({ job_id: "1", status: "cancelled", end_time: 2000 }))
    updateJob(db, "1", { creality_start: 900 })
    upsertHistoryJob(db, h({ job_id: "2", start_time: 2500 }))
    updateJob(db, "2", { creality_start: 900.4 })
    linkFragment(db, getJob(db, "2")!)
    expect(getJob(db, "2")!.merged_into).toBe("1")
    upsertHistoryJob(db, h({ job_id: "3", start_time: 9000 }))
    updateJob(db, "3", { creality_start: 8900 })
    linkFragment(db, getJob(db, "3")!)
    expect(getJob(db, "3")!.merged_into).toBeNull()
  })
})

describe("media and power", () => {
  test("matches firmware timelapses by name and printer clock", () => {
    const list = [
      { id: 1793676886, starttime: 1793676886, gcodename: "K2 Riser Corner.stl_PLA_49m32s.gcode", video: "", cover: "", printtime: 3103 },
      { id: 1793676404, starttime: 1793676404, gcodename: "Other.gcode", video: "", cover: "", printtime: 0 },
    ]
    expect(matchFirmwareVideo(list, "K2 Riser Corner.stl_PLA_49m32s.gcode", 1793677277, 1793680427)?.id).toBe(1793676886)
    expect(matchFirmwareVideo(list, "K2 Riser Corner.stl_PLA_49m32s.gcode", 1793716791, 1793720000)).toBeNull()
  })
  test("integrates watts", () => {
    const s = Array.from({ length: 721 }, (_, i) => ({ ts: i * 5, watts: 300 }))
    expect(integrateKwh(s)).toBeCloseTo(0.3)
    expect(integrateKwh([{ ts: 0, watts: 300 }, { ts: 600, watts: 300 }])).toBeNull()
  })
  test("pretty names", () => {
    expect(prettyName("K2 Riser Corner.stl_PLA_49m32s.gcode")).toBe("K2 Riser Corner")
    expect(prettyName(".Cable_Organizer_S_11021648.3mf/Cable_Organizer_S_11021648_plate_1.gcode")).toBe("Cable Organizer S")
    expect(prettyName("4color-3DBench_PLA_32m.gcode")).toBe("4color-3DBench PLA 32m")
  })
})

describe("energy estimate", () => {
  const { jobEnergy } = require("../src/jobs")
  const { estimateWatts } = require("../src/power")
  const s = { ...DEFAULT_SETTINGS }
  const addJob = (db: any, id: string, start: number, end: number) => {
    upsertHistoryJob(db, { job_id: id, filename: "a.gcode", status: "completed", start_time: start, end_time: end,
      print_duration: end - start, total_duration: end - start, filament_used: 1000 })
    updateJob(db, id, { creality_start: start })
  }
  const addSamples = (db: any, from: number, to: number, nozzle: number, bed: number) => {
    const ins = db.query("INSERT INTO samples (ts, nozzle_power, bed_power) VALUES (?, ?, ?)")
    for (let t = from; t <= to; t += 5) ins.run(t, nozzle, bed)
  }

  test("watts from duty", () => {
    expect(estimateWatts({ ts: 0, nozzle_power: 0.5, bed_power: 0.5 }, s.energyEstimate)).toBe(40 + 35 + 350)
  })

  test("integrates heater duty over a fully sampled job", () => {
    const db = memoryDb()
    addJob(db, "1", 0, 3600)
    addSamples(db, 0, 3600, 0.12, 0.16)
    const e = jobEnergy(db, getJob(db, "1")!, s)
    expect(e.source).toBe("estimated")
    expect(e.kwh).toBeCloseTo((40 + 0.12 * 70 + 0.16 * 700) / 1000, 4) // 1 h at ~160 W
  })

  test("fills unsampled time and falls back to duration", () => {
    const db = memoryDb()
    addJob(db, "1", 0, 3600)
    addSamples(db, 0, 3600, 0.12, 0.16)
    updateJob(db, "1", { energy_kwh: 0.1604, energy_source: "estimated" })
    addJob(db, "2", 10000, 17200) // 2 h, no samples: priced at the average of sampled jobs
    expect(jobEnergy(db, getJob(db, "2")!, s)).toMatchObject({ source: "estimated-duration" })
    expect(jobEnergy(db, getJob(db, "2")!, s).kwh).toBeCloseTo(0.3208, 3)
    addJob(db, "3", 20000, 23600) // samples only for the second half (service started mid-job)
    addSamples(db, 21800, 23600, 0.12, 0.16)
    const e = jobEnergy(db, getJob(db, "3")!, s)
    expect(e.source).toBe("estimated-duration")
    expect(e.kwh).toBeCloseTo(0.1604, 2)
  })

  test("prefers the plug and fills its dropouts from duty", () => {
    const db = memoryDb()
    addJob(db, "1", 0, 3600)
    addSamples(db, 0, 3600, 0.12, 0.16)
    db.query("UPDATE samples SET watts = 300 WHERE ts > 360").run() // plug missed the first 6 min
    const e = jobEnergy(db, getJob(db, "1")!, s)
    expect(e.source).toBe("measured")
    expect(e.kwh).toBeCloseTo(0.3 * 0.9 + 0.1604 * 0.1, 2)
  })

  test("off means no energy", () => {
    const db = memoryDb()
    addJob(db, "1", 0, 3600)
    expect(jobEnergy(db, getJob(db, "1")!, { ...s, energyEstimate: { ...s.energyEstimate, enabled: false } }).kwh).toBeNull()
  })
})
