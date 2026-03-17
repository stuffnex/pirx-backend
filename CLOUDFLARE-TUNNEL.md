# Cloudflare Tunnel Setup — PIRX

Expose your Pi radar securely over HTTPS with no open ports.

## 1. Install cloudflared

```bash
# Raspberry Pi 4 (ARM64)
wget -q https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-arm64 \
  -O /tmp/cloudflared
sudo mv /tmp/cloudflared /usr/local/bin/cloudflared
sudo chmod +x /usr/local/bin/cloudflared
cloudflared --version
```

## 2. Authenticate

Run this on a machine with a browser, then copy `~/.cloudflared/cert.pem` to the Pi:

```bash
cloudflared tunnel login
```

## 3. Create tunnel

```bash
cloudflared tunnel create pirx
# Note the UUID printed — you need it in config.yml
```

## 4. Configure (`~/.cloudflared/config.yml`)

```yaml
tunnel: <your-tunnel-uuid>
credentials-file: /home/stuffnex/.cloudflared/<your-tunnel-uuid>.json

ingress:
  - hostname: pirx.yourdomain.com
    service: http://localhost:8080
    originRequest:
      disableChunkedEncoding: false   # required for audio streaming
  - service: http_status:404
```

## 5. Add DNS record

```bash
cloudflared tunnel route dns pirx pirx.yourdomain.com
```

## 6. Run as PM2 service

```bash
pm2 start "cloudflared tunnel run pirx" --name pirx-tunnel
pm2 save
```

## 7. Update frontend config

In `app.js` find `PRODUCTION_HOSTS` and add your hostname:

```js
const PRODUCTION_HOSTS = [
  'pirx.yourdomain.com',
];
```

## Notes

- Cloudflare passes `audio/mpeg` chunked streams as `cf-cache-status: DYNAMIC` — no special config needed
- JS/CSS/HTML files have `Cache-Control: no-cache` headers — browsers always get fresh files
- WebSocket (`wss://`) works natively through the tunnel — no extra config
