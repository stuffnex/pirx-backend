# Changelog

All notable changes to **pirx-radar-backend** are documented here.  
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/).

---

## [1.1.0] — 2026-03-06

### Added — Audio Streaming (Milestone 2)
- `AudioSource` class — manages one child process per frequency, shared across all clients
- Audio driver registry (`AUDIO_DRIVERS`) with three pluggable backends:
  - `rtl_fm` — RTL-SDR dongle → `rtl_fm` → `sox` MP3 pipeline (default)
  - `alsa` — ALSA line-in capture → `sox` MP3 pipeline (external receiver)
  - `mock` — `sox` 1 kHz sine tone, no hardware required (testing)
- `GET /audio/stream?freq=<kHz>` — chunked `audio/mpeg` HTTP stream, browser-native `<audio>` compatible
- `GET /audio/freqs` — JSON list of all streamable frequencies with labels and stream URLs
- Frequency validation — rejects unknown values with `400`/`404` + allowed-set in response body
- `audioPool` Map — one `AudioSource` per frequency, lazily created on first request
- Idle TTL — process killed 10 s after last client disconnects (`AUDIO_IDLE_TTL`)
- Cloudflare anti-buffering headers on all stream responses: `X-Accel-Buffering: no`, `Cache-Control: no-store`
- `/health` now includes `audio_source` driver name and `audio_active` array (active freqs + client counts)
- Graceful shutdown destroys all `AudioSource` instances and sends `SIGTERM` to child processes
- New env vars: `AUDIO_SOURCE`, `RTL_DEVICE`, `RTL_GAIN`, `ALSA_DEVICE`
- `package.json` updated to `v1.1.0` with new npm scripts: `dev:mock`, `dev:alsa`, `pm2:mock`, `check:sox`, `check:rtl`, `check:alsa`
- `README.md` — full Testing section (12 numbered test commands with expected output), audio architecture diagram, driver table, Cloudflare notes, custom driver guide

### Architecture decisions
- HTTP chunked streaming chosen over WebSocket for audio: browser `<audio>` plays natively with zero JS, lower latency through Cloudflare, simpler client integration
- One process per frequency (not per client) — single `rtl_fm` instance shared across N simultaneous listeners; Pi 3B CPU budget preserved
- `PassThrough` streams fan audio bytes from one `proc.stdout` pipe to N HTTP response objects
- `sox -C 5` (quality 5 VBR) balances CPU load vs audio fidelity on Pi 3B

---

## [1.0.1] — 2026-03-04

### Fixed
- `STATIC_DIR` now resolves to `./pirx-radar-ui/` (subfolder inside the project directory) instead of `../pirx-radar-ui/` — corrects "Static dir not found" warning when running from `~/PIRX/`
- Updated directory layout in `README.md` and `DEPLOY.md` to reflect the correct structure

---

## [1.0.0] — 2026-03-01

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
- WebSocket server on `/ws/traffic` — 10 Hz broadcast cap, immediate snapshot on connect
- Client message handler: `get_freqs` → returns EDDN frequency table
- Mock fallback — 5 animated synthetic aircraft when Beast is unreachable (`MOCK_ON_FAILURE`)
- Express static file server → `pirx-radar-ui/` (index.html, app.js, style.css)
- `GET /health` — JSON: beast status, track count, uptime, decoder stats, EDDN freqs
- `GET /status` — fr24feed-compatible receiver/link status
- CORS headers (`Access-Control-Allow-Origin: *`) for Cloudflare Pages compatibility
- Console + append file logging (`pirx-backend.log`) with ISO timestamps
- `DEBUG` env var for verbose decoder output
- Graceful shutdown on `SIGTERM` / `SIGINT`
- `uncaughtException` + `unhandledRejection` guards
- `package.json` with `express ^4.18` + `ws ^8.16`
- `DEPLOY.md` — full Raspberry Pi deployment guide
- `README.md` — API reference, feature table, resource usage
- `CHANGELOG.md`
- Cloudflare Tunnel setup: `pirx.dustyhut.org` → `localhost:8080`

### Architecture decisions
- Single `server.js` file — no build step, minimal npm dependencies, easy to audit on Pi
- Buffer cap (512 B) on Beast stream to prevent OOM on malformed data
- `setInterval` / `setTimeout` with `.unref()` to allow clean process exit
- `--max-memory-restart 128M` PM2 recommendation for Pi 3B (1 GB RAM)

---

## Unreleased

### Planned
- Squawk decode — 7500 / 7600 / 7700 emergency flags in track object
- Mode-S short squitter (DF 0/4/5/11) support
- Aircraft type / registration lookup via offline CSV (icao-aircraft-db)
- Configurable CPR reference position via env var (`REF_LAT`, `REF_LON`)
- `/ws/traffic` bounding-box filter — client sends viewport, server filters tracks
- Prometheus `/metrics` endpoint (track count, decoder rate, WS clients, audio streams)
- Optional SBS-1 (port 30003) input as alternative to Beast
- Unit tests for Beast decoder and CPR decode functions

---

_Dates use ISO 8601. Versions follow [Semantic Versioning](https://semver.org/)._
