# PIRX Radar Backend — Deployment Guide

## Directory Layout on the Pi

```
/home/pi/PIRX/
├── server.js          ← this file
├── package.json
├── DEPLOY.md
├── README.md
├── CHANGELOG.md
├── node_modules/
├── pirx-backend.log   ← auto-created at runtime
└── pirx-radar-ui/     ← frontend (served as static files, subfolder)
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 1 — Install Node.js (if not already present)

```bash
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v   # should print v18.x.x
```

---

## 2 — Install dependencies

```bash
cd /home/pi/pirx-radar-backend
npm install
```

---

## 3 — Install PM2 (process manager)

```bash
sudo npm install -g pm2
```

---

## 4 — Start the server

### One-shot (foreground, for testing)
```bash
node server.js
```

### Via PM2 (production, auto-restart)
```bash
pm2 start server.js --name pirx-backend --restart-delay 3000 --max-memory-restart 128M
pm2 save                        # persist across reboots
pm2 startup                     # enable PM2 on boot (follow the printed command)
```

---

## 5 — Verify

```bash
# Beast receiver status
curl http://localhost:8080/status

# Health + decoder stats
curl http://localhost:8080/health

# Live log tail
pm2 logs pirx-backend
# or
tail -f /home/pi/pirx-radar-backend/pirx-backend.log
```

---

## 6 — Access the UI

Find the Pi's IP:
```bash
hostname -I
```

Open in browser:
```
http://<pi-ip>:8080
```

Or if mDNS is configured:
```
http://raspberrypi.local:8080
```

WebSocket endpoint used by the frontend:
```
ws://<pi-ip>:8080/ws/traffic
```

---

## 7 — Verify fr24feed is running

```bash
fr24feed-status
# Expected output:
#   Receiver:  connected
#   Link:      connected
```

fr24feed Beast port must be active on `127.0.0.1:30005`.
Check `/etc/fr24feed.ini`:
```
bs=yes        # Beast output must be enabled
```

---

## Environment Variables (optional overrides)

| Variable     | Default     | Description                        |
|-------------|-------------|------------------------------------|
| PORT        | 8080        | HTTP + WebSocket listen port       |
| BEAST_HOST  | 127.0.0.1   | fr24feed Beast TCP host            |
| BEAST_PORT  | 30005       | fr24feed Beast TCP port            |
| DEBUG       | (unset)     | Set to any value for debug logging |

Example:
```bash
PORT=8080 BEAST_HOST=127.0.0.1 node server.js
```

---

## PM2 Useful Commands

```bash
pm2 list                        # show all processes
pm2 restart pirx-backend        # restart
pm2 stop pirx-backend           # stop
pm2 delete pirx-backend         # remove from PM2
pm2 monit                       # live CPU/memory monitor
```

---

## Behaviour When Beast Is Down

If fr24feed is unreachable, the server:
- Continues serving the frontend
- Pushes **5 synthetic aircraft** around EDDN (mock mode)
- Reconnects automatically every 5 seconds
- `/health` reports `beast_connected: false` and `source: "mock"`

To disable mock data, set `MOCK_ON_FAILURE = false` in `server.js`.

---

## Firewall (if UFW is active)

```bash
sudo ufw allow 8080/tcp
```

---

## Cloudflare Pages (remote access)

The backend sets `Access-Control-Allow-Origin: *`.
Point your Cloudflare Pages frontend's WebSocket URL to:
```
ws://<your-public-ip-or-tunnel>:8080/ws/traffic
```

For secure remote access without port-forwarding, use **Cloudflare Tunnel**:
```bash
cloudflared tunnel --url http://localhost:8080
```
