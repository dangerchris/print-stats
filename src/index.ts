import fs from "node:fs"
import { config } from "./config"
import { openDb } from "./db"
import { Collector } from "./collector"
import { createPowerSource } from "./power"
import { startServer } from "./server"
import { mediaSweep } from "./media"

fs.mkdirSync(config.mediaDir, { recursive: true })
const db = openDb(config.dbPath)
const power = createPowerSource()
const collector = new Collector(db, power)

const server = startServer(db, collector)
console.log(`[print-stats] http://localhost:${server.port}  moonraker=${config.moonraker} power=${power.name}`)
collector.start()
setTimeout(() => mediaSweep(db).catch((e) => console.error("[media] sweep failed:", e)), 20_000)

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    server.stop()
    db.close()
    process.exit(0)
  })
}
