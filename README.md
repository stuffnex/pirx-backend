# PIRX Radar Backend

> **iCAS2 ADS-B + VHF Audio Server** — Raspberry Pi 3B  
> `fr24feed Beast :30005` → WebSocket JSON → Browser radar  
> `RTL-SDR / ALSA` → HTTP MP3 stream → Browser audio player

```
┌─────────────┐  TCP Beast   ┌───────────────────────┐  WS JSON  ┌──────────────┐
│  fr24feed   │ ───────────▶ │    pirx-backend        │ ────────▶ │  iCAS2 radar │
│  :30005     │              │    Express + ws        │           │  browser UI  │
└─────────────┘              └───────────────────────-┘           └──────────────┘
                                        │  HTTP MP3 stream
┌─────────────┐  PCM stdout             ▼
│  rtl_fm     │ ───────────▶  GET /audio/stream?freq=119475
│  / arecord  │                         │
└─────────────┘              ┌──────────┴──────────┐
                             ▼                     ▼
                        browser tab 1         browser tab 2
```

---

## Features

| Feature | Detail |
|---|---|
| **Beast decoder** | Full DF17/18 ADS-B — position, velocity, callsign, altitude |
| **CPR decode** | Local reference EDDN (49.4987 N, 11.0669 E) |
| **Track store** | In-memory, 30 s stale timeout, auto-prune every 5 s |
| **WebSocket** | `/ws/traffic` — 10 Hz max broadcast, snapshot on connect |
| **ADS-B mock** | 5 synthetic aircraft when Beast is unreachable |
| **Audio streaming** | `/audio/stream?freq=<kHz>` — chunked MP3, browser-native |
| **Audio drivers** | Pluggable: `rtl_fm`, `alsa`, `mock` |
| **Audio pool** | One process per frequency, shared across all clients |
| **Static files** | Serves `pirx-radar-ui/` (index.html, app.js, style.css) |
| **Health API** | `/health` — JSON status + decoder + audio stats |
| **CORS** | `*` — compatible with Cloudflare Pages |
| **PM2 ready** | SIGTERM / SIGINT graceful shutdown, uncaught exception guard |
| **Logging** | Console + `pirx-backend.log` (append) |

---

## Directory Layout

```
/home/stuffnex/PIRX/
├── server.js
├── package.json
├── DEPLOY.md
├── README.md
├── CHANGELOG.md
├── node_modules/
├── pirx-backend.log        ← created at runtime
└── pirx-radar-ui/          ← frontend static files
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Quick Start

```bash
cd ~/PIRX
npm install

# Development — foreground, ADS-B mock + audio mock (no hardware needed)
AUDIO_SOURCE=mock node server.js

# Development — foreground, RTL-SDR audio
AUDIO_SOURCE=rtl_fm node server.js

# Production via PM2
pm2 start server.js --name pirx-backend --max-memory-restart 128M
pm2 save && pm2 startup
```

Open **`http://<pi-ip>:8080`** or **`https://pirx.dustyhut.org`** in your browser.

---

## Testing

Run all checks below after deploying or updating. Expected output shown as comments.

### 1 — Server health

```bash
curl http://localhost:8080/health
# Expected: { "status": "ok", "beast_connected": true, "track_count": N, "audio_source": "...", ... }
```

### 2 — Beast / fr24feed status

```bash
curl http://localhost:8080/status
# Expected: { "receiver": "connected", "link": "connected", "mode": "Beast", "tracks": N }
```

### 3 — WebSocket live tracks

Install `wscat` once:
```bash
sudo npm install -g wscat
```

Connect to the traffic stream:
```bash
wscat -c ws://localhost:8080/ws/traffic
```

You will see a JSON message arrive immediately (the current snapshot), then a new one every ~100 ms:
```
Connected (press CTRL+C to quit)
< {"type":"tracks","tracks":[{"icao":"3C6444","callsign":"DLH123","lat":49.52,...}],"source":"live","ts":1700000000000}
< {"type":"tracks","tracks":[...],"source":"live","ts":1700000001000}
```

If `"source":"mock"` appears instead of `"live"`, Beast is not connected — this is expected when fr24feed is down.

Press `Ctrl+C` to disconnect.

### 4 — WebSocket frequency request

Connect with wscat, then type the JSON message and press Enter to send it:
```bash
wscat -c ws://localhost:8080/ws/traffic
```

Once connected, type this exactly and press Enter:
```
{"type":"get_freqs"}
```

Expected response on the next line:
```
< {"type":"freqs","freqs":{"APP":119475,"TWR":118305,"GND":121760,"DEL":121760,"CTR":129525,"ATIS":123080}}
```

wscat shows `>` for messages you send and `<` for messages the server sends back.

### 5 — Audio frequency list

```bash
curl http://localhost:8080/audio/freqs
# Expected: { "freqs": [ { "label": "APP", "freq_khz": 119475, "freq_mhz": "119.475", "stream_url": "/audio/stream?freq=119475" }, ... ] }
```

### 6 — Audio stream mock (no hardware needed)

```bash
# Requires sox: sudo apt install sox

# Start server in mock audio mode (background)
AUDIO_SOURCE=mock node server.js &
SERVER_PID=$!

# Save 5 seconds to file
curl -s --max-time 5 "http://localhost:8080/audio/stream?freq=119475" -o test.mp3

# Verify it is a valid MP3
file test.mp3
# Expected: test.mp3: Audio file with ID3 version 2.3.0 ...

# Cleanup
rm -f test.mp3
kill $SERVER_PID
```

### 7 — Audio stream live playback

```bash
# Play APP stream with mpv (install: sudo apt install mpv)
curl -s "http://localhost:8080/audio/stream?freq=119475" | mpv -

# Or with ffplay (install: sudo apt install ffmpeg)
curl -s "http://localhost:8080/audio/stream?freq=119475" | ffplay -nodisp -autoexit -t 10 -
```

### 8 — Invalid frequency rejection

```bash
# Unknown frequency → 404
curl -s http://localhost:8080/audio/stream?freq=99999
# Expected: HTTP 404 → { "error": "99999 kHz is not an allowed frequency", "allowed": [...] }

# Missing parameter → 400
curl -s http://localhost:8080/audio/stream
# Expected: HTTP 400 → { "error": "Missing or invalid ?freq= parameter ...", "example": "..." }
```

### 9 — Static frontend served

```bash
curl -s -o /dev/null -w "%{http_code}" http://localhost:8080/
# Expected: 200
```

### 10 — Cloudflare tunnel end-to-end

```bash
# Health through tunnel
curl -I https://pirx.dustyhut.org/health
# Expected: HTTP/2 200, server: cloudflare

# Audio stream headers through tunnel
curl -sI "https://pirx.dustyhut.org/audio/stream?freq=119475"
# Expected headers: x-accel-buffering: no, content-type: audio/mpeg, transfer-encoding: chunked
```

### 11 — PM2 process status

```bash
pm2 list
# Expected: pirx-backend → online, pirx-tunnel → online

pm2 show pirx-backend
# Check: status=online, restart count=0 or low, memory < 128 MB
```

### 12 — System tool availability

```bash
npm run check:sox
# Expected: sox SoX v14.x.x

npm run check:rtl
# Expected: rtl_fm help output (only if RTL-SDR dongle is connected)

npm run check:alsa
# Expected: arecord version output
```

---

## API Reference

### `GET /health`

```jsonc
{
  "status": "ok",
  "beast_connected": true,
  "track_count": 12,
  "uptime_s": 3600,
  "decoder_stats": { "messages": 48201, "decoded": 31540, "errors": 0 },
  "eddn_freqs": { "APP": 119475, "TWR": 118305, "GND": 121760, "DEL": 121760, "CTR": 129525, "ATIS": 123080 },
  "audio_source": "rtl_fm",
  "audio_active": [ { "freq_khz": 119475, "label": "APP", "clients": 2 } ],
  "timestamp": "2026-03-06T00:00:00.000Z"
}
```

### `GET /status`

```jsonc
{ "receiver": "connected", "link": "connected", "mode": "Beast", "tracks": 12 }
```

### `GET /audio/freqs`

```jsonc
{
  "freqs": [
    { "label": "APP", "freq_khz": 119475, "freq_mhz": "119.475", "stream_url": "/audio/stream?freq=119475" }
  ]
}
```

### `GET /audio/stream?freq=<kHz>`

Returns a chunked `audio/mpeg` stream. Use directly in a browser `<audio>` element:

```html
<audio controls src="/audio/stream?freq=119475"></audio>
```

Error responses:
- `400` — missing or non-integer `freq` parameter
- `404` — frequency not in the allowed set (returns allowed list)
- `503` — audio source process failed

### `WS /ws/traffic`

**Server → Client** (every ~100 ms + immediately on connect):

```jsonc
{
  "type": "tracks",
  "source": "live",
  "ts": 1700000000000,
  "tracks": [
    {
      "icao": "3C6444",
      "callsign": "DLH123",
      "lat": 49.52,
      "lon": 11.10,
      "altitude": 34000,
      "groundspeed": 450,
      "heading": 270,
      "squawk": "1000",
      "vertical_rate": 0,
      "last_seen": 1700000000000
    }
  ]
}
```

**Client → Server:**

```jsonc
{ "type": "get_freqs" }
```

**Server → Client** (response):

```jsonc
{ "type": "freqs", "freqs": { "APP": 119475, "TWR": 118305, "GND": 121760, "DEL": 121760, "CTR": 129525, "ATIS": 123080 } }
```

---

## Audio Streaming

### Architecture

```
rtl_fm / arecord
      │  (raw PCM stdout)
      ▼
    sox  (MP3 encoder, quality 5)
      │  (MP3 bytes stdout)
      ▼
  AudioSource  (one instance per active frequency)
      │  (PassThrough fan-out to N clients)
      ├──▶ HTTP client 1  /audio/stream?freq=119475
      ├──▶ HTTP client 2  /audio/stream?freq=119475
      └──▶ HTTP client 3  /audio/stream?freq=118305
```

One process per frequency — not per client. Pi 3B CPU-friendly.  
Idle process stops automatically 10 s after the last client disconnects.

### Audio Source Drivers

| Driver | `AUDIO_SOURCE` | Requirements | Use case |
|---|---|---|---|
| RTL-SDR | `rtl_fm` | `rtl-sdr`, `sox` | SDR dongle on Pi USB |
| ALSA | `alsa` | `alsa-utils`, `sox` | External receiver via line-in |
| Mock | `mock` | `sox` only | Testing — no hardware needed |

### Install System Dependencies

```bash
sudo apt update

# Required for all drivers
sudo apt install sox

# RTL-SDR driver only
sudo apt install rtl-sdr

# ALSA (usually pre-installed on Raspberry Pi OS)
sudo apt install alsa-utils
```

### Running with Each Driver

```bash
# RTL-SDR (default)
AUDIO_SOURCE=rtl_fm node server.js

# RTL-SDR with custom gain and device
AUDIO_SOURCE=rtl_fm RTL_GAIN=30 RTL_DEVICE=1 node server.js

# ALSA line-in
AUDIO_SOURCE=alsa ALSA_DEVICE=hw:1,0 node server.js

# Mock test tone — no hardware
AUDIO_SOURCE=mock node server.js
```

### Cloudflare Tunnel Notes

The server sets these headers to prevent Cloudflare buffering the stream:
- `X-Accel-Buffering: no`
- `Cache-Control: no-cache, no-store`
- `Transfer-Encoding: chunked`

If audio is choppy through the tunnel, add to `~/.cloudflared/config.yml`:

```yaml
ingress:
  - hostname: pirx.dustyhut.org
    service: http://localhost:8080
    originRequest:
      disableChunkedEncoding: false
```

Then: `pm2 restart pirx-tunnel`

### Adding a Custom Audio Driver

Add an entry to `AUDIO_DRIVERS` in `server.js`:

```js
AUDIO_DRIVERS.myreceiver = (freqHz) => ({
  cmd:  'sh',
  args: ['-c',
    `my-tool --freq ${freqHz} | sox -t raw -r 48000 -e signed -b 16 -c 1 - -t mp3 -C 5 -`
  ],
});
```

Then set `AUDIO_SOURCE=myreceiver` and restart.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port |
| `BEAST_HOST` | `127.0.0.1` | fr24feed Beast TCP host |
| `BEAST_PORT` | `30005` | fr24feed Beast TCP port |
| `DEBUG` | *(unset)* | Set to any value for verbose debug logging |
| `AUDIO_SOURCE` | `rtl_fm` | Audio driver: `rtl_fm`, `alsa`, or `mock` |
| `RTL_DEVICE` | `0` | RTL-SDR device index |
| `RTL_GAIN` | `40` | RTL-SDR gain in dB |
| `ALSA_DEVICE` | `default` | ALSA capture device (e.g. `hw:1,0`) |

---

## EDDN Frequencies

| Label | kHz | MHz |
|---|---|---|
| APP | 119475 | 119.475 |
| TWR | 118305 | 118.305 |
| GND | 121760 | 121.760 |
| DEL | 121760 | 121.760 |
| CTR | 129525 | 129.525 |
| ATIS | 123080 | 123.080 |

---

## fr24feed Configuration

Beast output must be enabled in `/etc/fr24feed.ini`:

```ini
bs=yes
```

Verify:

```bash
fr24feed-status
# Receiver: connected
# Link:     connected
```

---

## Behaviour When Beast Is Down

- Frontend continues to load normally
- WebSocket pushes 5 animated mock aircraft around EDDN
- Automatic TCP reconnect every 5 seconds
- `/health` reports `beast_connected: false`, `source: "mock"`
- To disable mock data: set `MOCK_ON_FAILURE = false` in `server.js`

---

## Pi 3B Resource Usage (typical)

| Resource | Idle | ADS-B active | ADS-B + 1 audio stream |
|---|---|---|---|
| CPU | ~1 % | ~3–5 % | ~15–25 % |
| RAM | ~35 MB | ~40 MB | ~50 MB |
| Network (LAN) | — | ~50 KB/s | ~115 KB/s |

---

## Deployment

See **[DEPLOY.md](./DEPLOY.md)** for full step-by-step instructions including PM2 setup, firewall rules, and Cloudflare Tunnel configuration.

---

## License

MIT
