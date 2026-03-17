# PIRX Radar Backend — Deployment Guide

## Directory Layout on the Pi

```
/home/stuffnex/PIRX/
├── server.js
├── package.json
├── DEPLOY.md
├── README.md
├── CHANGELOG.md
├── node_modules/
├── pirx-backend.log        ← auto-created at runtime
└── pirx-radar-ui/          ← frontend (served as static files)
    ├── index.html
    ├── app.js
    └── style.css
```

---

## 1. System dependencies

```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y nodejs npm rtl-sdr ffmpeg git curl

# Blacklist DVB kernel module — prevents kernel claiming RTL dongles
echo 'blacklist dvb_usb_rtl28xxu' | sudo tee /etc/modprobe.d/rtl-sdr.conf
sudo rmmod dvb_usb_rtl28xxu 2>/dev/null || true

# Verify Node.js >= 18
node --version

# Verify both dongles visible
rtl_test -t 2>&1 | grep -E 'Found|SN:'
# Expected:
#   Found 2 device(s):
#     0:  Nooelec, NESDR Nano 3, SN: stx:978:0   ← audio dongle
#     1:  Nooelec, NESDR Nano 3, SN: AIS          ← ADS-B dongle
```

---

## 2. Install Node dependencies

```bash
cd ~/PIRX
npm install
```

---

## 3. Install PM2

```bash
sudo npm install -g pm2
```

---

## 4. Environment variables

Copy and edit:
```bash
cp .env.example .env   # if exists, otherwise set inline
```

Key variables:

| Variable | Default | Description |
|---|---|---|
| `PORT` | 8080 | HTTP + WS listen port |
| `BEAST_HOST` | 127.0.0.1 | fr24feed Beast TCP host |
| `BEAST_PORT` | 30005 | Beast binary output port |
| `AUDIO_SOURCE` | rtl_fm | `rtl_fm` or `mock` |
| `RTL_DEVICE` | 0 | Audio dongle index (NOT Beast dongle) |
| `RTL_GAIN` | 40 | Tuner gain 0–50 dB |
| `DEBUG` | (unset) | Set to any value for verbose logging |

---

## 5. Start with PM2

```bash
pm2 start server.js --name pirx-backend --restart-delay 3000 --max-memory-restart 128M
pm2 save
pm2 startup   # follow the printed command to enable on reboot
```

---

## 6. Cloudflare Tunnel

See `CLOUDFLARE-TUNNEL.md` for full setup.

Quick start:
```bash
# Install
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -O /tmp/cf && sudo mv /tmp/cf /usr/local/bin/cloudflared && sudo chmod +x /usr/local/bin/cloudflared

# Authenticate, create tunnel, configure, start
cloudflared tunnel login
cloudflared tunnel create pirx
# edit ~/.cloudflared/config.yml (see CLOUDFLARE-TUNNEL.md)
pm2 start "cloudflared tunnel run pirx" --name pirx-tunnel
pm2 save
```

---

## 7. Verify

```bash
# Backend health
curl http://localhost:8080/health

# WebSocket (should print JSON immediately)
wscat -c ws://localhost:8080/ws/traffic

# Audio stream (should print ID3 header bytes)
curl -s --max-time 5 "http://localhost:8080/audio/stream?freq=119475" | \
  od -A x -t x1z | head -3

# FFT (only works when no audio stream active)
curl -s "http://localhost:8080/audio/fft?bins=64&gain=40" | python3 -m json.tool | head -10
```

---

## 8. RTL-SDR dongle notes

```bash
# Identify dongle indices
rtl_test -t 2>&1 | grep -E 'Found|SN:'

# Test audio dongle manually (Ctrl+C after ~3s to stop)
rtl_fm -d 0 -f 119475000 -M am -s 200k -r 48000 -g 40 - 2>/dev/null | \
  ffmpeg -hide_banner -loglevel error -f s16le -ar 48000 -ac 1 -i pipe:0 \
  -codec:a libmp3lame -b:a 32k -f mp3 pipe:1 | od -A x -t x1z | head -3
# Should print: 000000 49 44 33 ...  (ID3 MP3 header)

# If only 1 dongle appears despite 2 connected:
# - Check USB power (use powered hub)
# - Check dmesg: dmesg | grep -i 'usb\|rtl' | tail -20
# - Reboot with both dongles already inserted
```

---

## 9. PM2 commands

```bash
pm2 list                    # show all processes
pm2 logs pirx-backend       # live log tail
pm2 restart pirx-backend    # restart after config/code change
pm2 monit                   # CPU/memory live monitor
```

---

## 10. fr24feed Beast output

Ensure Beast output is enabled in `/etc/fr24feed.ini`:
```ini
bs=yes
```

Verify:
```bash
fr24feed-status
# Receiver: connected
# Link:     connected
```
