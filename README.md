# print-stats

Job history, cost, temperatures and timelapses for the Creality K2. Runs on `server.local` under pm2.

- Polls Moonraker (`MOONRAKER_URL`) every 5 s, read-only, and records nozzle/bed/chamber samples.
- Jobs come from Moonraker's history. Each job's slicer estimates are parsed from its gcode file.
- Filament weight is the actual extruded length split by the slicer's per-filament weights, then priced per material or per CFS slot (see Settings).
- Media:
  - when a job ends, it takes a final snapshot from the ring-bridge camera (`SNAPSHOT_URL`);
  - it imports the printer's own timelapse over SSH (`K2_SSH`);
  - if the printer made none, it stitches layer-change frames with ffmpeg.
- Power: `src/power.ts` has the provider interface; no meter is connected yet.

## Run

```sh
bun install          # dev types only; no runtime deps
bun test
bun src/index.ts     # http://localhost:8790
```

`.env` (Bun loads it automatically):

```
PORT=8790
MOONRAKER_URL=http://printer.local:7125
SNAPSHOT_URL=http://localhost:3000/api/ring/k2/snapshot
K2_SSH=root@printer.local
CF_ACCESS_TEAM=yourteam.cloudflareaccess.com
DASH_PASSWORD=...        # fallback login through the tunnel
SESSION_SECRET=...
```

Requests carrying `CF-Connecting-IP` (the tunnel) need either a verified Cloudflare Access JWT or a password session. LAN requests need neither.

## Deploy

```sh
rsync -a --delete --exclude node_modules --exclude data --exclude .env ./ user@server:print-stats/
ssh user@server 'export PATH=$HOME/.bun/bin:$PATH; cd print-stats && pm2 restart print-stats'
```

Data lives in `~/print-stats/data` (SQLite + `media/<job>/`).
