/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║          PIRX RADAR BACKEND — iCAS2 ADS-B Server            ║
 * ║   Beast (fr24feed :30005) → WebSocket JSON → Browser        ║
 * ║   Optimised for Raspberry Pi 3B  |  PM2 compatible          ║
 * ╚══════════════════════════════════════════════════════════════╝
 */

'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const net       = require('net');
const path      = require('path');
const fs        = require('fs');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  HTTP_PORT:       parseInt(process.env.PORT        || '8080', 10),
  BEAST_HOST:      process.env.BEAST_HOST            || '127.0.0.1',
  BEAST_PORT:      parseInt(process.env.BEAST_PORT  || '30005', 10),
  STATIC_DIR:      path.resolve(__dirname, 'pirx-radar-ui'),
  TRACK_TIMEOUT:   30_000,   // ms — remove aircraft with no update
  BROADCAST_HZ:    10,       // max WebSocket push rate
  RECONNECT_DELAY: 5_000,    // ms before Beast TCP reconnect attempt
  LOG_FILE:        path.join(__dirname, 'pirx-backend.log'),
  MOCK_ON_FAILURE: true,     // serve synthetic traffic if Beast is down
};

// EDDN frequencies (informational — synced with frontend)
const EDDN_FREQS = {
  APP:  119475,
  TWR:  118305,
  GND:  121760,
  DEL:  121760,
  CTR:  129525,
  ATIS: 123080,
};

// ─── Logger ───────────────────────────────────────────────────────────────────

const logStream = fs.createWriteStream(CONFIG.LOG_FILE, { flags: 'a' });

function log(level, ...args) {
  const ts  = new Date().toISOString();
  const msg = `[${ts}] [${level}] ${args.join(' ')}`;
  console.log(msg);
  logStream.write(msg + '\n');
}

const logger = {
  info:  (...a) => log('INFO ', ...a),
  warn:  (...a) => log('WARN ', ...a),
  error: (...a) => log('ERROR', ...a),
  debug: (...a) => { if (process.env.DEBUG) log('DEBUG', ...a); },
};

// ─── Track Store ──────────────────────────────────────────────────────────────

/**
 * In-memory aircraft track table.
 * Key: ICAO hex string (uppercase)
 * Value: track object (matches frontend JSON contract)
 */
const tracks = new Map();

function upsertTrack(icao, fields) {
  const existing = tracks.get(icao) || { icao };
  const updated  = Object.assign(existing, fields, {
    icao,
    last_seen: Date.now(),
  });
  tracks.set(icao, updated);
}

function pruneStale() {
  const cutoff = Date.now() - CONFIG.TRACK_TIMEOUT;
  for (const [icao, t] of tracks) {
    if (t.last_seen < cutoff) {
      tracks.delete(icao);
      logger.debug(`Pruned stale track ${icao}`);
    }
  }
}

setInterval(pruneStale, 5_000).unref();

// ─── Beast Binary Decoder ─────────────────────────────────────────────────────

/**
 * Beast format:
 *   0x1A          — escape / frame start marker
 *   0x31/0x32/0x33 — message type (Short/Long Squitter, Mode-AC)
 *   6 bytes MLAT timestamp
 *   1 byte signal level
 *   N bytes payload  (2 for Mode-AC, 7 for Mode-S short, 14 for Mode-S long)
 *
 * Within payload, 0x1A is escaped as 0x1A 0x1A.
 */

class BeastDecoder {
  constructor() {
    this._buf   = Buffer.alloc(0);
    this._stats = { messages: 0, decoded: 0, errors: 0 };
  }

  get stats() { return { ...this._stats }; }

  /** Feed raw TCP bytes; calls _processMessage for each complete frame */
  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parse();
    // Prevent unbounded growth if data is malformed
    if (this._buf.length > 512) {
      this._buf = this._buf.slice(this._buf.length - 256);
    }
  }

  _parse() {
    let buf = this._buf;
    let i   = 0;

    while (i < buf.length) {
      // Find 0x1A frame marker
      if (buf[i] !== 0x1A) { i++; continue; }
      if (i + 1 >= buf.length) break;   // need more data

      const type = buf[i + 1];
      let payloadLen;

      if      (type === 0x31) payloadLen = 2;   // Mode-AC
      else if (type === 0x32) payloadLen = 7;   // Mode-S Short
      else if (type === 0x33) payloadLen = 14;  // Mode-S Long (ADS-B)
      else                    { i += 2; continue; }

      // 2 (marker+type) + 6 (timestamp) + 1 (signal) + payloadLen
      const frameLen = 2 + 6 + 1 + payloadLen;
      if (i + frameLen > buf.length) break;     // incomplete frame — wait

      // Extract and unescape payload
      const raw = buf.slice(i, i + frameLen);
      const unescaped = this._unescape(raw.slice(9, 9 + payloadLen));

      this._stats.messages++;
      if (type === 0x33) {
        try {
          this._decodeLongSquitter(unescaped);
          this._stats.decoded++;
        } catch (e) {
          this._stats.errors++;
          logger.debug('Decode error:', e.message);
        }
      }

      i += frameLen;
    }

    this._buf = buf.slice(i);
  }

  /** Replace escaped 0x1A 0x1A with single 0x1A */
  _unescape(buf) {
    const out = [];
    for (let i = 0; i < buf.length; i++) {
      out.push(buf[i]);
      if (buf[i] === 0x1A && buf[i + 1] === 0x1A) i++;
    }
    return Buffer.from(out);
  }

  _decodeLongSquitter(msg) {
    if (msg.length < 14) return;

    const df   = (msg[0] >> 3) & 0x1F;   // Downlink Format
    const icao = msg.slice(1, 4).toString('hex').toUpperCase();

    if (df !== 17 && df !== 18) return;   // ADS-B only

    const typeCode = (msg[4] >> 3) & 0x1F;
    const fields   = {};

    // ── Airborne Position (TC 9-18) ────────────────────────────
    if (typeCode >= 9 && typeCode <= 18) {
      const altRaw = ((msg[5] & 0xFF) << 4) | ((msg[6] >> 4) & 0x0F);
      if (altRaw !== 0) {
        const qBit = (altRaw >> 4) & 0x01;
        if (qBit) {
          const n = ((altRaw & 0x1F80) >> 2) | (altRaw & 0x3F);
          fields.altitude = n * 25 - 1000;
        }
      }

      // CPR position decode (odd/even — simplified single-frame)
      const cprLat  = ((msg[6] & 0x03) << 15) | ((msg[7] & 0xFF) << 7) | ((msg[8] >> 1) & 0x7F);
      const cprLon  = ((msg[8] & 0x01) << 16) | ((msg[9] & 0xFF) << 8) | (msg[10] & 0xFF);
      const oddFlag = msg[6] & 0x04 ? 1 : 0;

      // Use reference position EDDN (49.4987, 11.0669) for local decode
      const { lat, lon } = decodeCPR(cprLat, cprLon, oddFlag, 49.4987, 11.0669);
      if (lat !== null) {
        fields.lat = +lat.toFixed(5);
        fields.lon = +lon.toFixed(5);
      }
    }

    // ── Surface Position (TC 5-8) ──────────────────────────────
    if (typeCode >= 5 && typeCode <= 8) {
      const movRaw = ((msg[4] & 0x07) << 4) | ((msg[5] >> 4) & 0x0F);
      if (movRaw > 1 && movRaw <= 124) fields.groundspeed = decodeMovement(movRaw);
      fields.altitude = 0;
    }

    // ── Airborne Velocity (TC 19) ──────────────────────────────
    if (typeCode === 19) {
      const subtype = msg[4] & 0x07;
      if (subtype === 1 || subtype === 2) {
        const dirEW   = (msg[5] >> 2) & 0x01;
        const velEW   = (((msg[5] & 0x03) << 8) | msg[6]) - 1;
        const dirNS   = (msg[7] >> 7) & 0x01;
        const velNS   = (((msg[7] & 0x7F) << 3) | (msg[8] >> 5)) - 1;

        const vEW = dirEW ? -velEW : velEW;
        const vNS = dirNS ? -velNS : velNS;
        const spd = Math.round(Math.sqrt(vEW * vEW + vNS * vNS));
        const hdg = (Math.atan2(vEW, vNS) * 180 / Math.PI + 360) % 360;

        if (subtype === 2) fields.groundspeed = spd * 4;  // supersonic
        else               fields.groundspeed = spd;

        fields.heading = +hdg.toFixed(1);

        // Vertical rate
        const vrSign = (msg[8] >> 3) & 0x01;
        const vrRaw  = ((msg[8] & 0x07) << 6) | (msg[9] >> 2);
        if (vrRaw !== 0) fields.vertical_rate = (vrSign ? -1 : 1) * (vrRaw - 1) * 64;
      }
    }

    // ── Identification (TC 1-4) — Callsign ────────────────────
    if (typeCode >= 1 && typeCode <= 4) {
      const CHARSET = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
      let callsign  = '';
      for (let b = 5; b < 11; b++) {
        callsign += CHARSET[(msg[b] >> 2) & 0x3F] || '';
        if (b < 10) callsign += CHARSET[((msg[b] & 0x03) << 4) | ((msg[b + 1] >> 4) & 0x0F)] || '';
      }
      fields.callsign = callsign.replace(/_/g, ' ').trim() || null;
    }

    if (Object.keys(fields).length > 0) {
      upsertTrack(icao, fields);
    }
  }
}

// ─── CPR Position Decode (simplified, local reference) ───────────────────────

function decodeCPR(cprLat, cprLon, isOdd, refLat, refLon) {
  const NZ  = 15;
  const dLat = isOdd ? 360 / (4 * NZ - 1) : 360 / (4 * NZ);

  const latCPR = cprLat / 131072;
  const lonCPR = cprLon / 131072;

  const j   = Math.floor(refLat / dLat) + Math.floor(0.5 + ((refLat % dLat) / dLat) - latCPR);
  const lat  = dLat * (j + latCPR);

  if (lat < -90 || lat > 90) return { lat: null, lon: null };

  const nl  = cprNL(lat);
  const ni  = Math.max(isOdd ? nl - 1 : nl, 1);
  const dLon = 360 / ni;

  const m   = Math.floor(refLon / dLon) + Math.floor(0.5 + ((refLon % dLon) / dLon) - lonCPR);
  const lon  = dLon * (m + lonCPR);

  // Sanity check — within ~500 NM of EDDN
  const dlat = Math.abs(lat - refLat);
  const dlon = Math.abs(lon - refLon);
  if (dlat > 8 || dlon > 12) return { lat: null, lon: null };

  return { lat, lon };
}

function cprNL(lat) {
  if (Math.abs(lat) >= 87) return 1;
  const a = 1 - Math.cos(Math.PI / (2 * 15));
  const b = Math.cos(Math.PI * lat / 180) ** 2;
  return Math.floor(2 * Math.PI / Math.acos(1 - a / b));
}

function decodeMovement(mov) {
  if (mov <= 8)  return mov - 1;
  if (mov <= 12) return 2 + (mov - 9) * 0.5;
  if (mov <= 38) return 4 + (mov - 13) * 1;
  if (mov <= 93) return 30 + (mov - 39) * 2;
  return Math.round(100 + (mov - 94) * 5);
}

// ─── Mock Data (fallback when Beast is down) ──────────────────────────────────

const MOCK_AIRCRAFT = [
  { icao: '3C6444', callsign: 'DLH123', lat: 49.52, lon: 11.10, altitude: 34000, groundspeed: 450, heading: 270, squawk: '1000', vertical_rate:    0 },
  { icao: '4CA234', callsign: 'RYR456', lat: 49.40, lon: 11.20, altitude: 12000, groundspeed: 310, heading:  90, squawk: '2200', vertical_rate: -800 },
  { icao: '3D1234', callsign: 'EWG789', lat: 49.55, lon: 10.90, altitude: 24000, groundspeed: 380, heading: 180, squawk: '3400', vertical_rate: 1200 },
  { icao: '406ABC', callsign: 'BAW001', lat: 49.35, lon: 11.30, altitude:  8000, groundspeed: 250, heading: 320, squawk: '5000', vertical_rate: -1600 },
  { icao: '3C7777', callsign: 'CLH002', lat: 49.60, lon: 11.05, altitude:  3000, groundspeed: 180, heading:  80, squawk: '7000', vertical_rate: -500 },
];

let mockTick = 0;

function buildMockTracks() {
  mockTick++;
  return MOCK_AIRCRAFT.map((a, i) => {
    const angle = ((mockTick * 0.02) + i * 1.2) % (2 * Math.PI);
    return {
      ...a,
      lat: +(a.lat + Math.sin(angle) * 0.05).toFixed(5),
      lon: +(a.lon + Math.cos(angle) * 0.07).toFixed(5),
      last_seen: Date.now(),
    };
  });
}

// ─── Beast TCP Client ─────────────────────────────────────────────────────────

let beastSocket   = null;
let beastConnected = false;
let reconnectTimer = null;
const decoder      = new BeastDecoder();

function connectBeast() {
  if (beastSocket) {
    beastSocket.removeAllListeners();
    beastSocket.destroy();
    beastSocket = null;
  }

  clearTimeout(reconnectTimer);
  logger.info(`Connecting to Beast on ${CONFIG.BEAST_HOST}:${CONFIG.BEAST_PORT} …`);

  beastSocket = new net.Socket();
  beastSocket.setKeepAlive(true, 10_000);
  beastSocket.setTimeout(60_000);

  beastSocket.connect(CONFIG.BEAST_PORT, CONFIG.BEAST_HOST);

  beastSocket.on('connect', () => {
    beastConnected = true;
    logger.info('Beast connected ✓');
  });

  beastSocket.on('data', (chunk) => {
    decoder.push(chunk);
  });

  beastSocket.on('timeout', () => {
    logger.warn('Beast socket timeout — reconnecting');
    scheduleReconnect();
  });

  beastSocket.on('error', (err) => {
    beastConnected = false;
    logger.error(`Beast error: ${err.message}`);
    scheduleReconnect();
  });

  beastSocket.on('close', () => {
    beastConnected = false;
    logger.warn('Beast connection closed — reconnecting');
    scheduleReconnect();
  });
}

function scheduleReconnect() {
  if (beastSocket) { beastSocket.destroy(); beastSocket = null; }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBeast, CONFIG.RECONNECT_DELAY);
}

// ─── Express App ──────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

// CORS (Cloudflare Pages + local dev)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Health check
app.get('/health', (req, res) => {
  res.json({
    status:          'ok',
    beast_connected: beastConnected,
    track_count:     tracks.size,
    uptime_s:        Math.floor(process.uptime()),
    decoder_stats:   decoder.stats,
    eddn_freqs:      EDDN_FREQS,
    timestamp:       new Date().toISOString(),
  });
});

// Beast status (mirrors fr24feed-status fields)
app.get('/status', (req, res) => {
  res.json({
    receiver: beastConnected ? 'connected' : 'disconnected',
    link:     beastConnected ? 'connected' : 'disconnected',
    mode:     'Beast',
    tracks:   tracks.size,
  });
});

// Static frontend files
if (fs.existsSync(CONFIG.STATIC_DIR)) {
  app.use(express.static(CONFIG.STATIC_DIR));
  app.get('*', (req, res) => {
    const index = path.join(CONFIG.STATIC_DIR, 'index.html');
    if (fs.existsSync(index)) res.sendFile(index);
    else res.status(404).send('Frontend not found — expected at ' + CONFIG.STATIC_DIR);
  });
  logger.info(`Serving static files from ${CONFIG.STATIC_DIR}`);
} else {
  logger.warn(`Static dir not found: ${CONFIG.STATIC_DIR} — UI will not be served`);
  app.get('/', (req, res) => res.json({ status: 'PIRX backend running', ui: 'not found' }));
}

// ─── WebSocket Server ─────────────────────────────────────────────────────────

const wss = new WebSocket.Server({ server, path: '/ws/traffic' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  logger.info(`WS client connected: ${ip}  (total: ${wss.clients.size})`);

  // Send current snapshot immediately on connect
  sendTracks(ws);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      // Echo back frequencies on request
      if (data.type === 'get_freqs') {
        safeSend(ws, { type: 'freqs', freqs: EDDN_FREQS });
      }
    } catch (_) {}
  });

  ws.on('close', () => {
    logger.info(`WS client disconnected: ${ip}  (remaining: ${wss.clients.size})`);
  });

  ws.on('error', (err) => {
    logger.error(`WS client error [${ip}]: ${err.message}`);
  });
});

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}

function sendTracks(ws) {
  const data = beastConnected
    ? Array.from(tracks.values())
    : (CONFIG.MOCK_ON_FAILURE ? buildMockTracks() : []);

  safeSend(ws, {
    type:   'tracks',
    tracks: data,
    source: beastConnected ? 'live' : 'mock',
    ts:     Date.now(),
  });
}

function broadcastTracks() {
  if (wss.clients.size === 0) return;

  const data = beastConnected
    ? Array.from(tracks.values())
    : (CONFIG.MOCK_ON_FAILURE ? buildMockTracks() : []);

  const payload = JSON.stringify({
    type:   'tracks',
    tracks: data,
    source: beastConnected ? 'live' : 'mock',
    ts:     Date.now(),
  });

  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      try { client.send(payload); } catch (_) {}
    }
  }
}

// Push updates at configured rate
const broadcastInterval = setInterval(broadcastTracks, Math.floor(1000 / CONFIG.BROADCAST_HZ));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(CONFIG.HTTP_PORT, () => {
  logger.info('══════════════════════════════════════════');
  logger.info('  PIRX Radar Backend  |  iCAS2 ADS-B      ');
  logger.info('══════════════════════════════════════════');
  logger.info(`  HTTP  → http://0.0.0.0:${CONFIG.HTTP_PORT}`);
  logger.info(`  WS    → ws://0.0.0.0:${CONFIG.HTTP_PORT}/ws/traffic`);
  logger.info(`  Beast → ${CONFIG.BEAST_HOST}:${CONFIG.BEAST_PORT}`);
  logger.info(`  UI    → ${CONFIG.STATIC_DIR}`);
  logger.info(`  Mock  → ${CONFIG.MOCK_ON_FAILURE ? 'enabled (fallback)' : 'disabled'}`);
  logger.info('══════════════════════════════════════════');
});

connectBeast();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully …`);
  clearInterval(broadcastInterval);
  clearTimeout(reconnectTimer);

  if (beastSocket) beastSocket.destroy();

  wss.clients.forEach(ws => ws.terminate());
  wss.close();

  server.close(() => {
    logStream.end(() => {
      logger.info('Server stopped.');
      process.exit(0);
    });
  });

  // Force-kill after 10 s
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

process.on('uncaughtException', (err) => {
  logger.error('Uncaught exception:', err.message, err.stack);
});

process.on('unhandledRejection', (reason) => {
  logger.error('Unhandled rejection:', reason);
});
