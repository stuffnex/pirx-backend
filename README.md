# PIRX Radar Backend

> **iCAS2 ADS-B Server** — Raspberry Pi 3B  
> `fr24feed Beast :30005` → WebSocket JSON → Browser radar

```
┌─────────────┐   TCP Beast    ┌──────────────────┐   WS JSON   ┌──────────────┐
│  fr24feed   │ ─────────────▶ │  pirx-backend    │ ──────────▶ │  iCAS2 radar │
│  :30005     │                │  Express + ws    │             │  browser UI  │
└─────────────┘                └──────────────────┘             └──────────────┘
                                        │
                                        ▼
                               static ../pirx-radar-ui/
```

---

## Features

| Feature | Detail |
|---|---|
| **Beast decoder** | Full DF17/18 ADS-B — position, velocity, callsign, altitude |
| **CPR decode** | Local reference EDDN (49.4987 N, 11.0669 E) |
| **Track store** | In-memory, 30 s stale timeout, auto-prune every 5 s |
| **WebSocket** | `/ws/traffic` — 10 Hz max broadcast, snapshot on connect |
| **Mock fallback** | 5 synthetic aircraft when Beast is unreachable |
| **Static files** | Serves `../pirx-radar-ui/` (index.html, app.js, style.css) |
| **Health API** | `/health` — JSON status + decoder stats |
| **CORS** | `*` — compatible with Cloudflare Pages |
| **PM2 ready** | SIGTERM / SIGINT graceful shutdown, uncaught exception guard |
| **Logging** | Console + `pirx-backend.log` (append) |

---

## Directory Layout

```
/home/pi/PIRX/
├── server.js
├── package.json
├── DEPLOY.md
├── README.md
├── CHANGELOG.md
├── node_modules/
├── pirx-backend.log             ← created at runtime
└── pirx-radar-ui/               ← frontend static files (subfolder)
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Quick Start

```bash
# 1. Install dependencies
cd /home/pi/pirx-radar-backend
npm install

# 2. Run (foreground / dev)
node server.js

# 3. Run via PM2 (production)
pm2 start server.js --name pirx-backend --max-memory-restart 128M
pm2 save && pm2 startup
```

Open **`http://<pi-ip>:8080`** in your browser.

---

## API Reference

### `GET /health`
Full health + decoder statistics.

```jsonc
{
  "status": "ok",
  "beast_connected": true,
  "track_count": 12,
  "uptime_s": 3600,
  "decoder_stats": { "messages": 48201, "decoded": 31540, "errors": 0 },
  "eddn_freqs": { "APP": 119475, "TWR": 118305, ... },
  "timestamp": "2025-01-01T12:00:00.000Z"
}
```

### `GET /status`
fr24feed-compatible status summary.

```jsonc
{ "receiver": "connected", "link": "connected", "mode": "Beast", "tracks": 12 }
```

### `WS /ws/traffic`
Live aircraft track stream.

**Server → Client** (every 100 ms, or on connect):
```jsonc
{
  "type": "tracks",
  "source": "live",          // "live" | "mock"
  "ts": 1700000000000,
  "tracks": [
    {
      "icao": "3C6444",
      "callsign": "DLH123",
      "lat": 49.52,
      "lon": 11.10,
      "altitude": 34000,     // ft
      "groundspeed": 450,    // kt
      "heading": 270,        // °
      "squawk": "1000",
      "vertical_rate": 0,    // ft/min
      "last_seen": 1700000000000
    }
  ]
}
```

**Client → Server** (optional):
```jsonc
{ "type": "get_freqs" }
```

**Server → Client** (response):
```jsonc
{ "type": "freqs", "freqs": { "APP": 119475, "TWR": 118305, ... } }
```

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `PORT` | `8080` | HTTP + WebSocket listen port |
| `BEAST_HOST` | `127.0.0.1` | fr24feed Beast TCP host |
| `BEAST_PORT` | `30005` | fr24feed Beast TCP port |
| `DEBUG` | *(unset)* | Set to any value for verbose debug logging |

---

## EDDN Frequencies

```
APP   119.475 MHz
TWR   118.305 MHz
GND   121.760 MHz
DEL   121.760 MHz
CTR   129.525 MHz
ATIS  123.080 MHz
```

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

| Resource | Idle | Active (20 aircraft) |
|---|---|---|
| CPU | ~1 % | ~3–5 % |
| RAM | ~35 MB | ~40 MB |
| Network (LAN) | — | ~50 KB/s |

---

## Deployment

See **[DEPLOY.md](./DEPLOY.md)** for full step-by-step instructions including PM2 setup, firewall rules, and Cloudflare Tunnel for remote access.

---

## License

MIT
