# Changelog — pirx-radar-backend

---

## [1.2.0] — 2026-03-17

### Fixed
- **`rtl_power` exit code 1 / FFT always 500** — step argument changed from
  `${FFT_MIN_MHZ}M:${FFT_MAX_MHZ}M:25k` to full Hz integers
  `${Math.round(FFT_MIN_MHZ*1e6)}:${Math.round(FFT_MAX_MHZ*1e6)}:25000`.
  The `M`/`k` shorthand causes exit code 1 on this Pi's `rtl_power` build.
- **`SyntaxError: Invalid or unexpected token` crash** — added `rawOutput`
  empty-guard before CSV parsing: if `rtl_power` exits 0 but writes nothing,
  the route now returns `500` cleanly instead of crashing the parse.
- **Audio silent on frequency switch** — `getAudioSource()` now evicts ALL
  other active `AudioSource` instances before creating a new one, then waits
  `DONGLE_RELEASE_MS` (600ms) for the OS to release the USB device. Previously
  the old `rtl_fm` process kept holding the dongle causing the new one to exit
  immediately with code 0 (device busy).

### Added
- **`/audio/fft` endpoint** — `GET /audio/fft?bins=<N>&gain=<0-50>` runs
  `rtl_power` for a single sweep over 118–128 MHz, returns normalised power
  bins as JSON `{ bins: [0..1,...], min_khz, max_khz, min_dbm, max_dbm }`.
  Returns 503 if audio is currently streaming (dongle conflict).
- **`audioIsActive()`** — checks if any `AudioSource` holds the dongle.
- **`DONGLE_RELEASE_MS = 600`** — wait time after SIGTERM before new spawn.
- **`RTL_POWER_BIN`** env var — path to `rtl_power` binary.
- **`FFT_MIN_MHZ` / `FFT_MAX_MHZ`** env vars — sweep range (default 118/128).
- **No-cache headers for static files** — `Cache-Control: no-cache` on all
  `.js`/`.css`/`.html` responses. Prevents Cloudflare and browsers from serving
  stale frontend versions after deployment.
- **Gain parameter in audio stream** — `?gain=<0-50>` forwarded to `rtl_fm`.
  Pool key is now `${freqKHz}:${gainDb}` — gain changes force new instance.
- **`/health`** now includes `audio_active` array with gain_db per stream.
- **Graceful shutdown** sends `pt.end()` (not `pt.destroy()`) on intentional
  frequency switch — avoids spurious stream errors in browser console.

---

## [1.1.1] — 2026-03-09

### Fixed
- `app.get('*')` SPA catch-all was intercepting API routes (`/audio/freqs`,
  `/audio/stream`, `/health`, `/status`) and returning `index.html` — added
  `API_PATHS` regex guard.

---

## [1.1.0] — 2026-03-06

### Added — Audio Streaming
- `AudioSource` class — one process per frequency, shared across clients.
- `AUDIO_DRIVERS`: `rtl_fm`, `alsa`, `mock`.
- `GET /audio/stream?freq=<kHz>` — chunked `audio/mpeg`.
- `GET /audio/freqs` — JSON frequency list.
- `audioPool` Map, idle TTL, graceful shutdown.
- New env vars: `AUDIO_SOURCE`, `RTL_DEVICE`, `RTL_GAIN`, `ALSA_DEVICE`.

---

## [1.0.1] — 2026-03-04

### Fixed
- `STATIC_DIR` path corrected to `./pirx-radar-ui/`.

---

## [1.0.0] — 2026-03-01

### Added
- Beast TCP client, full DF17/18 ADS-B decoder, CPR decode.
- WebSocket `/ws/traffic`, 10 Hz broadcast, mock fallback.
- `/health`, `/status`, CORS, static file server, PM2-compatible.
