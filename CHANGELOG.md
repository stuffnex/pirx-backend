# Changelog

All notable changes to **pirx-radar-backend** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.0.1] — 2026-03-04

### Fixed
- `STATIC_DIR` now resolves to `./pirx-radar-ui/` (subfolder inside the project directory) instead of `../pirx-radar-ui/` — corrects "Static dir not found" warning when running from `~/PIRX/`
- Updated directory layout in `README.md` and `DEPLOY.md` to reflect the correct structure

---

## [1.0.0] — 2025-01-01

### Added
- Initial production release
- Beast TCP client (`127.0.0.1:30005`) with auto-reconnect (5 s delay)
- Full Beast binary frame parser — sync on `0x1A`, unescape `0x1A 0x1A`, handle DF17/18
- ADS-B decoder:
  - TC 1–4 — aircraft identification / callsign (6-char charset)
  - TC 5–8 — surface position + movement speed decode
  - TC 9–18 — airborne position, Q-bit altitude, CPR lat/lon
  - TC 19 — airborne velocity (EW/NS components → speed + heading + vertical rate)
- CPR position decoder with local EDDN reference (49.4987 N, 11.0669 E) and ±500 NM sanity check
- In-memory track store (`Map`) with 30 s stale timeout, pruned every 5 s
- WebSocket server on `/ws/traffic` — 10 Hz broadcast cap, immediate snapshot on client connect
- Client message handler: `get_freqs` → returns EDDN frequency table
- Mock fallback — 5 animated synthetic aircraft when Beast is unreachable (`MOCK_ON_FAILURE`)
- Express static file server → `../pirx-radar-ui/` (index.html, app.js, style.css)
- `GET /health` — JSON: beast status, track count, uptime, decoder stats, EDDN freqs
- `GET /status` — fr24feed-compatible receiver/link status
- CORS headers (`Access-Control-Allow-Origin: *`) for Cloudflare Pages compatibility
- Console + append file logging (`pirx-backend.log`) with ISO timestamps
- `DEBUG` env var for verbose decoder output
- Graceful shutdown on `SIGTERM` / `SIGINT` — closes WS clients, TCP socket, HTTP server, log stream
- `uncaughtException` + `unhandledRejection` guards
- `package.json` with `express ^4.18` + `ws ^8.16`; PM2 npm script
- `DEPLOY.md` — full Raspberry Pi deployment guide
- `README.md` — API reference, feature table, resource usage, frequency table

### Architecture decisions
- Single `server.js` file — no build step, minimal dependencies, easy to audit on Pi
- Buffer cap (512 B) on Beast stream to prevent OOM on malformed data
- `setInterval` / `setTimeout` with `.unref()` to allow clean process exit
- `--max-memory-restart 128M` PM2 recommendation for Pi 3B (1 GB RAM)

---

## Unreleased

### Planned
- Squawk decode — 7500/7600/7700 emergency flag in track object
- Mode-S Mode-AC (DF 0/4/5/11) short squitter support
- Aircraft type / registration lookup via offline CSV (icao-aircraft-db)
- Configurable CPR reference position via env var (`REF_LAT`, `REF_LON`)
- `/ws/traffic` filter support — client sends bounding box, server filters tracks
- Prometheus `/metrics` endpoint (track count, decoder rate, WS clients)
- Optional SBS-1 (port 30003) input as alternative to Beast
- HTTPS / WSS support via self-signed cert option
- Unit tests for Beast decoder and CPR decode functions

---

_Dates use ISO 8601. Versions follow [Semantic Versioning](https://semver.org/)._
