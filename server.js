/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║          PIRX RADAR BACKEND — iCAS2 ADS-B + Audio Server        ║
 * ║   Beast (fr24feed :30005) → WebSocket JSON → Browser            ║
 * ║   SDR/ALSA audio → HTTP stream → Browser per frequency          ║
 * ║   Optimised for Raspberry Pi 3B  |  PM2 compatible              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 */

'use strict';

const express            = require('express');
const http               = require('http');
const WebSocket          = require('ws');
const net                = require('net');
const path               = require('path');
const fs                 = require('fs');
const { spawn }          = require('child_process');
const { PassThrough }    = require('stream');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  HTTP_PORT:        parseInt(process.env.PORT        || '8080', 10),
  BEAST_HOST:       process.env.BEAST_HOST            || '127.0.0.1',
  BEAST_PORT:       parseInt(process.env.BEAST_PORT  || '30005', 10),
  STATIC_DIR:       path.resolve(__dirname, 'pirx-radar-ui'),
  TRACK_TIMEOUT:    30_000,
  BROADCAST_HZ:     10,
  RECONNECT_DELAY:  5_000,
  LOG_FILE:         path.join(__dirname, 'pirx-backend.log'),
  MOCK_ON_FAILURE:  true,

  // Audio
  AUDIO_SOURCE:     process.env.AUDIO_SOURCE || 'rtl_fm', // 'rtl_fm' | 'alsa' | 'mock'
  AUDIO_IDLE_TTL:   10_000,   // ms — stop process after last client disconnects
  RTL_DEVICE:       parseInt(process.env.RTL_DEVICE || '0', 10),
  RTL_GAIN:         process.env.RTL_GAIN    || '40',
  ALSA_DEVICE:      process.env.ALSA_DEVICE || 'default',
};

// ─── EDDN Frequencies (kHz) ───────────────────────────────────────────────────

const EDDN_FREQS = {
  APP:  119475,
  TWR:  118305,
  GND:  121760,
  DEL:  121760,
  CTR:  129525,
  ATIS: 123080,
};

const FREQ_HZ_SET = new Set(Object.values(EDDN_FREQS));
const FREQ_LABEL  = Object.fromEntries(
  Object.entries(EDDN_FREQS).map(([k, v]) => [v, k])
);

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

const tracks = new Map();

function upsertTrack(icao, fields) {
  const existing = tracks.get(icao) || { icao };
  tracks.set(icao, Object.assign(existing, fields, { icao, last_seen: Date.now() }));
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

class BeastDecoder {
  constructor() {
    this._buf   = Buffer.alloc(0);
    this._stats = { messages: 0, decoded: 0, errors: 0 };
  }

  get stats() { return { ...this._stats }; }

  push(chunk) {
    this._buf = Buffer.concat([this._buf, chunk]);
    this._parse();
    if (this._buf.length > 512) this._buf = this._buf.slice(this._buf.length - 256);
  }

  _parse() {
    let buf = this._buf, i = 0;
    while (i < buf.length) {
      if (buf[i] !== 0x1A) { i++; continue; }
      if (i + 1 >= buf.length) break;
      const type = buf[i + 1];
      let pLen;
      if      (type === 0x31) pLen = 2;
      else if (type === 0x32) pLen = 7;
      else if (type === 0x33) pLen = 14;
      else { i += 2; continue; }
      const fLen = 9 + pLen;
      if (i + fLen > buf.length) break;
      const unescaped = this._unescape(buf.slice(i + 9, i + fLen));
      this._stats.messages++;
      if (type === 0x33) {
        try   { this._decodeLongSquitter(unescaped); this._stats.decoded++; }
        catch (e) { this._stats.errors++; }
      }
      i += fLen;
    }
    this._buf = buf.slice(i);
  }

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
    const df   = (msg[0] >> 3) & 0x1F;
    const icao = msg.slice(1, 4).toString('hex').toUpperCase();
    if (df !== 17 && df !== 18) return;
    const tc     = (msg[4] >> 3) & 0x1F;
    const fields = {};

    if (tc >= 9 && tc <= 18) {
      const altRaw = ((msg[5] & 0xFF) << 4) | ((msg[6] >> 4) & 0x0F);
      if (altRaw && (altRaw >> 4) & 1) {
        const n = ((altRaw & 0x1F80) >> 2) | (altRaw & 0x3F);
        fields.altitude = n * 25 - 1000;
      }
      const cprLat  = ((msg[6] & 0x03) << 15) | ((msg[7] & 0xFF) << 7) | ((msg[8] >> 1) & 0x7F);
      const cprLon  = ((msg[8] & 0x01) << 16) | ((msg[9] & 0xFF) << 8) | (msg[10] & 0xFF);
      const { lat, lon } = decodeCPR(cprLat, cprLon, msg[6] & 0x04 ? 1 : 0, 49.4987, 11.0669);
      if (lat !== null) { fields.lat = +lat.toFixed(5); fields.lon = +lon.toFixed(5); }
    }

    if (tc >= 5 && tc <= 8) {
      const mov = ((msg[4] & 0x07) << 4) | ((msg[5] >> 4) & 0x0F);
      if (mov > 1 && mov <= 124) fields.groundspeed = decodeMovement(mov);
      fields.altitude = 0;
    }

    if (tc === 19 && (msg[4] & 0x07) <= 2) {
      const sub  = msg[4] & 0x07;
      const vEW  = ((msg[5] >> 2) & 1 ? -1 : 1) * ((((msg[5] & 0x03) << 8) | msg[6]) - 1);
      const vNS  = ((msg[7] >> 7) & 1 ? -1 : 1) * ((((msg[7] & 0x7F) << 3) | (msg[8] >> 5)) - 1);
      const spd  = Math.round(Math.sqrt(vEW * vEW + vNS * vNS));
      fields.groundspeed   = sub === 2 ? spd * 4 : spd;
      fields.heading       = +((Math.atan2(vEW, vNS) * 180 / Math.PI + 360) % 360).toFixed(1);
      const vrRaw          = ((msg[8] & 0x07) << 6) | (msg[9] >> 2);
      if (vrRaw) fields.vertical_rate = ((msg[8] >> 3) & 1 ? -1 : 1) * (vrRaw - 1) * 64;
    }

    if (tc >= 1 && tc <= 4) {
      const CS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
      let cs   = '';
      for (let b = 5; b < 11; b++) {
        cs += CS[(msg[b] >> 2) & 0x3F] || '';
        if (b < 10) cs += CS[((msg[b] & 0x03) << 4) | ((msg[b + 1] >> 4) & 0x0F)] || '';
      }
      fields.callsign = cs.replace(/_/g, ' ').trim() || null;
    }

    if (Object.keys(fields).length) upsertTrack(icao, fields);
  }
}

function decodeCPR(cprLat, cprLon, isOdd, refLat, refLon) {
  const NZ   = 15;
  const dLat = isOdd ? 360 / (4 * NZ - 1) : 360 / (4 * NZ);
  const latC = cprLat / 131072, lonC = cprLon / 131072;
  const j    = Math.floor(refLat / dLat) + Math.floor(0.5 + ((refLat % dLat) / dLat) - latC);
  const lat  = dLat * (j + latC);
  if (lat < -90 || lat > 90) return { lat: null, lon: null };
  const nl   = cprNL(lat);
  const ni   = Math.max(isOdd ? nl - 1 : nl, 1);
  const dLon = 360 / ni;
  const m    = Math.floor(refLon / dLon) + Math.floor(0.5 + ((refLon % dLon) / dLon) - lonC);
  const lon  = dLon * (m + lonC);
  if (Math.abs(lat - refLat) > 8 || Math.abs(lon - refLon) > 12) return { lat: null, lon: null };
  return { lat, lon };
}

function cprNL(lat) {
  if (Math.abs(lat) >= 87) return 1;
  return Math.floor(2 * Math.PI / Math.acos(1 - (1 - Math.cos(Math.PI / 30)) / Math.cos(Math.PI * lat / 180) ** 2));
}

function decodeMovement(mov) {
  if (mov <= 8)  return mov - 1;
  if (mov <= 12) return 2 + (mov - 9) * 0.5;
  if (mov <= 38) return 4 + (mov - 13);
  if (mov <= 93) return 30 + (mov - 39) * 2;
  return Math.round(100 + (mov - 94) * 5);
}

// ─── Mock Data ────────────────────────────────────────────────────────────────

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
    return { ...a,
      lat:       +(a.lat + Math.sin(angle) * 0.05).toFixed(5),
      lon:       +(a.lon + Math.cos(angle) * 0.07).toFixed(5),
      last_seen: Date.now(),
    };
  });
}

// ─── Audio Driver Registry ────────────────────────────────────────────────────
//
// Each driver factory receives freqHz (integer Hz, e.g. 119475000) and returns
// { cmd: string, args: string[] }. The process must write MP3 bytes to stdout.
//
// Adding a new driver:
//   AUDIO_DRIVERS.mydriver = (freqHz) => ({ cmd: '...', args: [...] });
//   Set AUDIO_SOURCE=mydriver env var before starting the server.

const AUDIO_DRIVERS = {

// rtl_fm → ffmpeg MP3 encoder pipeline
  // -M am   : AM demodulation — required for VHF aeronautical voice (118–137 MHz)
  // -s 12k  : 12 kHz sample rate — sufficient for AM voice, low CPU
  // -d 1    : RTL-SDR device index 1 — leaves device 0 free for Beast/fr24feed
  // ffmpeg  : replaces sox (not installed); outputs 32 kbps mono MP3
  rtl_fm: (freqHz) => ({
    cmd:  'sh',
    args: ['-c',
      `rtl_fm -f ${freqHz} -M am -s 12k -g ${CONFIG.RTL_GAIN} -d 1 - ` +
      `| ffmpeg -hide_banner -loglevel error ` +
      `-f s16le -ar 12000 -ac 1 -i pipe:0 ` +
      `-codec:a libmp3lame -b:a 32k -f mp3 pipe:1`
    ],
  }),

  // ALSA capture → sox MP3 encoder (use when receiver is external, audio via line-in)
  alsa: (_freqHz) => ({
    cmd:  'sh',
    args: ['-c',
      `arecord -D ${CONFIG.ALSA_DEVICE} -f S16_LE -r 48000 -c 1 -t raw ` +
      `| sox -t raw -r 48000 -e signed -b 16 -c 1 - -t mp3 -C 5 -`
    ],
  }),

  // Mock — 1 kHz sine tone, no hardware needed (for testing)
  mock: (_freqHz) => ({
    cmd:  'sox',
    args: ['-n', '-t', 'mp3', '-C', '5', '-', 'synth', '9999', 'sin', '1000'],
  }),

};

// ─── AudioSource ──────────────────────────────────────────────────────────────
//
// One instance per active frequency.
// Spawns ONE child process shared across all clients on that frequency.
// Stops the process CONFIG.AUDIO_IDLE_TTL ms after the last client disconnects.

class AudioSource {
  constructor(freqKHz) {
    this.freqKHz    = freqKHz;
    this.freqHz     = freqKHz * 1000;
    this.label      = FREQ_LABEL[freqKHz] || String(freqKHz);
    this._clients   = new Set();
    this._proc      = null;
    this._started   = false;
    this._idleTimer = null;
  }

  /** Returns a PassThrough stream delivering MP3 bytes to one client */
  subscribe() {
    const pt = new PassThrough({ highWaterMark: 32 * 1024 });
    this._clients.add(pt);
    logger.info(`Audio [${this.label}] +client  (total: ${this._clients.size})`);

    pt.on('close', () => this._release(pt));
    pt.on('error', () => this._release(pt));

    clearTimeout(this._idleTimer);
    if (!this._started) this._start();

    return pt;
  }

  _release(pt) {
    if (!this._clients.has(pt)) return;
    this._clients.delete(pt);
    logger.info(`Audio [${this.label}] -client  (remaining: ${this._clients.size})`);
    if (this._clients.size === 0) {
      this._idleTimer = setTimeout(() => this._stop(), CONFIG.AUDIO_IDLE_TTL);
    }
  }

  _start() {
    const driver = AUDIO_DRIVERS[CONFIG.AUDIO_SOURCE];
    if (!driver) {
      logger.error(`Unknown AUDIO_SOURCE: "${CONFIG.AUDIO_SOURCE}". Valid: ${Object.keys(AUDIO_DRIVERS).join(', ')}`);
      return;
    }

    const { cmd, args } = driver(this.freqHz);
    logger.info(`Audio [${this.label}] spawn: ${cmd} ${args.join(' ')}`);

    this._proc    = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._started = true;

    this._proc.stdout.on('data', (chunk) => {
      for (const pt of this._clients) {
        if (!pt.destroyed) pt.write(chunk);
      }
    });

    this._proc.stderr.on('data', (d) =>
      logger.debug(`Audio [${this.label}] stderr: ${d.toString().trim()}`)
    );

    this._proc.on('error', (err) => {
      logger.error(`Audio [${this.label}] spawn error: ${err.message}`);
      this._broadcastError(err);
      this._cleanup();
    });

    this._proc.on('close', (code) => {
      logger.warn(`Audio [${this.label}] process exited (code ${code})`);
      this._broadcastError(new Error(`process exited with code ${code}`));
      this._cleanup();
    });
  }

  _stop() {
    logger.info(`Audio [${this.label}] idle — stopping process`);
    this._cleanup();
  }

  _cleanup() {
    this._started = false;
    if (this._proc) {
      try { this._proc.kill('SIGTERM'); } catch (_) {}
      this._proc = null;
    }
  }

  _broadcastError(err) {
    for (const pt of this._clients) {
      try { pt.destroy(err); } catch (_) {}
    }
    this._clients.clear();
  }

  destroy() {
    clearTimeout(this._idleTimer);
    this._broadcastError(new Error('server shutting down'));
    this._cleanup();
  }
}

// ─── Audio Pool (one source per frequency) ───────────────────────────────────

const audioPool = new Map();   // freqKHz → AudioSource

function getAudioSource(freqKHz) {
  if (!audioPool.has(freqKHz)) audioPool.set(freqKHz, new AudioSource(freqKHz));
  return audioPool.get(freqKHz);
}

// ─── Beast TCP Client ─────────────────────────────────────────────────────────

let beastSocket    = null;
let beastConnected = false;
let reconnectTimer = null;
const decoder      = new BeastDecoder();

function connectBeast() {
  if (beastSocket) { beastSocket.removeAllListeners(); beastSocket.destroy(); beastSocket = null; }
  clearTimeout(reconnectTimer);
  logger.info(`Connecting to Beast on ${CONFIG.BEAST_HOST}:${CONFIG.BEAST_PORT} …`);

  beastSocket = new net.Socket();
  beastSocket.setKeepAlive(true, 10_000);
  beastSocket.setTimeout(60_000);
  beastSocket.connect(CONFIG.BEAST_PORT, CONFIG.BEAST_HOST);

  beastSocket.on('connect', () => { beastConnected = true;  logger.info('Beast connected ✓'); });
  beastSocket.on('data',    (c)  => decoder.push(c));
  beastSocket.on('timeout', ()   => { logger.warn('Beast timeout'); scheduleReconnect(); });
  beastSocket.on('error',   (e)  => { beastConnected = false; logger.error(`Beast: ${e.message}`); scheduleReconnect(); });
  beastSocket.on('close',   ()   => { beastConnected = false; logger.warn('Beast closed'); scheduleReconnect(); });
}

function scheduleReconnect() {
  if (beastSocket) { beastSocket.destroy(); beastSocket = null; }
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectBeast, CONFIG.RECONNECT_DELAY);
}

// ─── Express + HTTP Server ────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── /health ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => res.json({
  status:          'ok',
  beast_connected: beastConnected,
  track_count:     tracks.size,
  uptime_s:        Math.floor(process.uptime()),
  decoder_stats:   decoder.stats,
  eddn_freqs:      EDDN_FREQS,
  audio_source:    CONFIG.AUDIO_SOURCE,
  audio_active:    [...audioPool.entries()]
                     .filter(([, s]) => s._started)
                     .map(([f, s]) => ({ freq_khz: f, label: s.label, clients: s._clients.size })),
  timestamp:       new Date().toISOString(),
}));

// ── /status ────────────────────────────────────────────────────────────────
app.get('/status', (_req, res) => res.json({
  receiver: beastConnected ? 'connected' : 'disconnected',
  link:     beastConnected ? 'connected' : 'disconnected',
  mode:     'Beast',
  tracks:   tracks.size,
}));

// ── /audio/freqs — list all streamable frequencies ─────────────────────────
app.get('/audio/freqs', (_req, res) => res.json({
  freqs: Object.entries(EDDN_FREQS).map(([label, kHz]) => ({
    label,
    freq_khz: kHz,
    freq_mhz: (kHz / 1000).toFixed(3),
    stream_url: `/audio/stream?freq=${kHz}`,
  })),
}));

// ── /audio/stream?freq=<kHz> — live MP3 stream ─────────────────────────────
//
// Design rationale (HTTP streaming vs WebSocket):
//   HTTP chunked transfer is chosen because:
//   - Browsers play it natively via <audio src="/audio/stream?freq=119475">
//   - No JS required; trivially compatible with all browsers
//   - Lower latency than buffered WebSocket framing for audio
//   - Works through Cloudflare tunnels with X-Accel-Buffering: no
//
// Cloudflare note:
//   Cloudflare may buffer HTTP responses. The headers below disable that.
//   If audio is choppy, ensure your tunnel config does NOT have http2 origin
//   compression enabled. Add `no-chunked-encoding` to ingress rules if needed.
//
app.get('/audio/stream', (req, res) => {
  const freqKHz = parseInt(req.query.freq, 10);
  const ip      = req.socket.remoteAddress;

  if (!freqKHz || isNaN(freqKHz)) {
    return res.status(400).json({
      error:   'Missing or invalid ?freq= parameter (integer kHz required)',
      example: '/audio/stream?freq=119475',
    });
  }

  if (!FREQ_HZ_SET.has(freqKHz)) {
    return res.status(404).json({
      error:   `${freqKHz} kHz is not an allowed frequency`,
      allowed: [...FREQ_HZ_SET].map(f => ({ freq_khz: f, label: FREQ_LABEL[f] })),
    });
  }

  const label = FREQ_LABEL[freqKHz];
  logger.info(`Audio [${label}] HTTP stream → ${ip}`);

  // Disable all proxy / CDN buffering for low-latency streaming
  res.setHeader('Content-Type',           'audio/mpeg');
  res.setHeader('Transfer-Encoding',      'chunked');
  res.setHeader('Cache-Control',          'no-cache, no-store, must-revalidate');
  res.setHeader('X-Accel-Buffering',      'no');   // nginx + Cloudflare: bypass buffer
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const source = getAudioSource(freqKHz);
  const stream = source.subscribe();

  stream.pipe(res, { end: false });

  req.on('close', () => {
    logger.info(`Audio [${label}] client closed (${ip})`);
    stream.unpipe(res);
    stream.destroy();
  });

  stream.on('error', (err) => {
    logger.warn(`Audio [${label}] stream error for ${ip}: ${err.message}`);
    if (!res.headersSent) res.status(503).end();
    else res.end();
  });
});

// ── Static frontend ─────────────────────────────────────────────────────────
// API paths must never be intercepted by the catch-all SPA fallback
const API_PATHS = /^\/(health|status|audio)\b/;

if (fs.existsSync(CONFIG.STATIC_DIR)) {
  app.use(express.static(CONFIG.STATIC_DIR));
  app.get('*', (req, res) => {
    if (API_PATHS.test(req.path)) {
      return res.status(404).json({ error: `API route ${req.path} not found` });
    }
    const index = path.join(CONFIG.STATIC_DIR, 'index.html');
    fs.existsSync(index)
      ? res.sendFile(index)
      : res.status(404).send('Frontend not found — expected at ' + CONFIG.STATIC_DIR);
  });
  logger.info(`Serving static files from ${CONFIG.STATIC_DIR}`);
} else {
  logger.warn(`Static dir not found: ${CONFIG.STATIC_DIR} — UI will not be served`);
  app.get('/', (_req, res) => res.json({ status: 'PIRX backend running', ui: 'not found' }));
}

// ─── WebSocket — /ws/traffic ──────────────────────────────────────────────────

const wss = new WebSocket.Server({ server, path: '/ws/traffic' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  logger.info(`WS client connected: ${ip}  (total: ${wss.clients.size})`);
  sendTracks(ws);

  ws.on('message', (msg) => {
    try {
      const data = JSON.parse(msg);
      if (data.type === 'get_freqs') safeSend(ws, { type: 'freqs', freqs: EDDN_FREQS });
    } catch (_) {}
  });

  ws.on('close', () => logger.info(`WS disconnected: ${ip}  (remaining: ${wss.clients.size})`));
  ws.on('error', (e) => logger.error(`WS error [${ip}]: ${e.message}`));
});

function safeSend(ws, payload) {
  if (ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(payload)); } catch (_) {}
}

function sendTracks(ws) {
  const data = beastConnected ? [...tracks.values()] : (CONFIG.MOCK_ON_FAILURE ? buildMockTracks() : []);
  safeSend(ws, { type: 'tracks', tracks: data, source: beastConnected ? 'live' : 'mock', ts: Date.now() });
}

function broadcastTracks() {
  if (!wss.clients.size) return;
  const data    = beastConnected ? [...tracks.values()] : (CONFIG.MOCK_ON_FAILURE ? buildMockTracks() : []);
  const payload = JSON.stringify({ type: 'tracks', tracks: data, source: beastConnected ? 'live' : 'mock', ts: Date.now() });
  for (const ws of wss.clients) {
    if (ws.readyState === WebSocket.OPEN) { try { ws.send(payload); } catch (_) {} }
  }
}

const broadcastInterval = setInterval(broadcastTracks, Math.floor(1000 / CONFIG.BROADCAST_HZ));

// ─── Start ────────────────────────────────────────────────────────────────────

server.listen(CONFIG.HTTP_PORT, () => {
  logger.info('══════════════════════════════════════════════════════');
  logger.info('  PIRX Radar Backend  |  iCAS2 ADS-B + Audio          ');
  logger.info('══════════════════════════════════════════════════════');
  logger.info(`  HTTP    → http://0.0.0.0:${CONFIG.HTTP_PORT}`);
  logger.info(`  WS      → ws://0.0.0.0:${CONFIG.HTTP_PORT}/ws/traffic`);
  logger.info(`  Audio   → http://0.0.0.0:${CONFIG.HTTP_PORT}/audio/stream?freq=<kHz>`);
  logger.info(`  Freqs   → http://0.0.0.0:${CONFIG.HTTP_PORT}/audio/freqs`);
  logger.info(`  Beast   → ${CONFIG.BEAST_HOST}:${CONFIG.BEAST_PORT}`);
  logger.info(`  UI      → ${CONFIG.STATIC_DIR}`);
  logger.info(`  AudSrc  → ${CONFIG.AUDIO_SOURCE}`);
  logger.info(`  Mock    → ${CONFIG.MOCK_ON_FAILURE ? 'enabled' : 'disabled'}`);
  logger.info('══════════════════════════════════════════════════════');
});

connectBeast();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`${signal} — shutting down …`);
  clearInterval(broadcastInterval);
  clearTimeout(reconnectTimer);
  for (const s of audioPool.values()) s.destroy();
  audioPool.clear();
  if (beastSocket) beastSocket.destroy();
  wss.clients.forEach(ws => ws.terminate());
  wss.close();
  server.close(() => logStream.end(() => { logger.info('Stopped.'); process.exit(0); }));
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('uncaughtException',  (e) => logger.error('Uncaught:', e.message, e.stack));
process.on('unhandledRejection', (r) => logger.error('Unhandled rejection:', r));
