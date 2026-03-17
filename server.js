/**
 * ╔══════════════════════════════════════════════════════════════════╗
 * ║      PIRX RADAR BACKEND v1.2.0 — iCAS2 ADS-B + Audio + FFT      ║
 * ║  Beast (fr24feed :30005) → WebSocket JSON → Browser             ║
 * ║  RTL-SDR (dongle 0) → ffmpeg MP3 → HTTP stream → Browser        ║
 * ║  Raspberry Pi 4  |  Two dongles  |  PM2 compatible              ║
 * ╚══════════════════════════════════════════════════════════════════╝
 *
 * Dongle layout:
 *   Dongle 0  SN stx:978:0  — FREE, used by rtl_fm audio + rtl_power FFT
 *   Dongle 1  SN AIS        — held by fr24feed/Beast at 1090 MHz (ADS-B)
 *
 * Key constraint: dongle 0 is EXCLUSIVE — only one process can hold it.
 *   rtl_fm (audio) and rtl_power (FFT) cannot run simultaneously.
 *   The pool enforces max 1 active AudioSource; FFT returns 503 when audio
 *   is streaming.
 */

'use strict';

const express         = require('express');
const http            = require('http');
const WebSocket       = require('ws');
const net             = require('net');
const path            = require('path');
const fs              = require('fs');
const { spawn }       = require('child_process');
const { PassThrough } = require('stream');

// ─── Configuration ────────────────────────────────────────────────────────────

const CONFIG = {
  HTTP_PORT:       parseInt(process.env.PORT         || '8080',  10),
  BEAST_HOST:      process.env.BEAST_HOST             || '127.0.0.1',
  BEAST_PORT:      parseInt(process.env.BEAST_PORT   || '30005', 10),
  STATIC_DIR:      path.resolve(__dirname, 'pirx-radar-ui'),
  TRACK_TIMEOUT:   30_000,   // ms — drop aircraft with no update
  BROADCAST_HZ:    10,       // WebSocket push rate cap
  RECONNECT_DELAY: 5_000,    // ms before Beast TCP reconnect
  LOG_FILE:        path.join(__dirname, 'pirx-backend.log'),
  MOCK_ON_FAILURE: true,     // serve 5 synthetic aircraft when Beast is down

  // Audio / SDR
  AUDIO_SOURCE:    process.env.AUDIO_SOURCE  || 'rtl_fm', // rtl_fm | mock
  AUDIO_IDLE_TTL:  parseInt(process.env.AUDIO_IDLE_TTL || '10000', 10), // ms
  RTL_DEVICE:      parseInt(process.env.RTL_DEVICE     || '0',     10), // dongle index
  RTL_GAIN:        process.env.RTL_GAIN                || '40',         // dB default
  RTL_FM_BIN:      process.env.RTL_FM_BIN              || 'rtl_fm',
  RTL_POWER_BIN:   process.env.RTL_POWER_BIN           || 'rtl_power',
  FFMPEG_BIN:      process.env.FFMPEG_BIN               || 'ffmpeg',

  // FFT sweep range
  FFT_MIN_MHZ:     parseFloat(process.env.FFT_MIN_MHZ  || '118'),
  FFT_MAX_MHZ:     parseFloat(process.env.FFT_MAX_MHZ  || '128'),
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
    // Cap buffer to prevent unbounded growth on malformed data
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
    if (df !== 17 && df !== 18) return;   // ADS-B only
    const tc     = (msg[4] >> 3) & 0x1F;
    const fields = {};

    // Airborne position (TC 9-18): altitude + CPR lat/lon
    if (tc >= 9 && tc <= 18) {
      const altRaw = ((msg[5] & 0xFF) << 4) | ((msg[6] >> 4) & 0x0F);
      if (altRaw && (altRaw >> 4) & 1) {
        const n = ((altRaw & 0x1F80) >> 2) | (altRaw & 0x3F);
        fields.altitude = n * 25 - 1000;
      }
      const cprLat = ((msg[6] & 0x03) << 15) | ((msg[7] & 0xFF) << 7) | ((msg[8] >> 1) & 0x7F);
      const cprLon = ((msg[8] & 0x01) << 16) | ((msg[9] & 0xFF) << 8) | (msg[10] & 0xFF);
      const { lat, lon } = decodeCPR(cprLat, cprLon, msg[6] & 0x04 ? 1 : 0, 49.4987, 11.0669);
      if (lat !== null) { fields.lat = +lat.toFixed(5); fields.lon = +lon.toFixed(5); }
    }

    // Surface position (TC 5-8): ground movement speed
    if (tc >= 5 && tc <= 8) {
      const mov = ((msg[4] & 0x07) << 4) | ((msg[5] >> 4) & 0x0F);
      if (mov > 1 && mov <= 124) fields.groundspeed = decodeMovement(mov);
      fields.altitude = 0;
    }

    // Airborne velocity (TC 19): groundspeed, heading, vertical_rate
    if (tc === 19 && (msg[4] & 0x07) <= 2) {
      const sub = msg[4] & 0x07;
      const vEW = ((msg[5] >> 2) & 1 ? -1 : 1) * ((((msg[5] & 0x03) << 8) | msg[6]) - 1);
      const vNS = ((msg[7] >> 7) & 1 ? -1 : 1) * ((((msg[7] & 0x7F) << 3) | (msg[8] >> 5)) - 1);
      const spd = Math.round(Math.sqrt(vEW * vEW + vNS * vNS));
      fields.groundspeed = sub === 2 ? spd * 4 : spd;
      fields.heading     = +((Math.atan2(vEW, vNS) * 180 / Math.PI + 360) % 360).toFixed(1);
      const vrRaw = ((msg[8] & 0x07) << 6) | (msg[9] >> 2);
      if (vrRaw) fields.vertical_rate = ((msg[8] >> 3) & 1 ? -1 : 1) * (vrRaw - 1) * 64;
    }

    // Identification (TC 1-4): callsign
    if (tc >= 1 && tc <= 4) {
      const CS = '#ABCDEFGHIJKLMNOPQRSTUVWXYZ#####_###############0123456789######';
      let cs = '';
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
  // Sanity check: reject positions > ~500 NM from EDDN
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
  { icao: '3C6444', callsign: 'DLH123', lat: 49.52, lon: 11.10, altitude: 34000, groundspeed: 450, heading: 270, vertical_rate:    0 },
  { icao: '4CA234', callsign: 'RYR456', lat: 49.40, lon: 11.20, altitude: 12000, groundspeed: 310, heading:  90, vertical_rate: -800 },
  { icao: '3D1234', callsign: 'EWG789', lat: 49.55, lon: 10.90, altitude: 24000, groundspeed: 380, heading: 180, vertical_rate: 1200 },
  { icao: '406ABC', callsign: 'BAW001', lat: 49.35, lon: 11.30, altitude:  8000, groundspeed: 250, heading: 320, vertical_rate: -1600 },
  { icao: '3C7777', callsign: 'CLH002', lat: 49.60, lon: 11.05, altitude:  3000, groundspeed: 180, heading:  80, vertical_rate: -500 },
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
// Each driver factory receives (freqHz: number, gainDb: string) and returns
// { cmd, args } for spawn(). The process must write MP3 bytes to stdout.
//
// sox is NOT available on this Pi — we use ffmpeg as the encoder.
// Pipeline: rtl_fm (raw S16LE PCM on stdout) | ffmpeg (MP3 on stdout)
//
// To add a new driver:
//   AUDIO_DRIVERS.mydriver = (freqHz, gainDb) => ({ cmd: '...', args: [...] });
//   Set AUDIO_SOURCE=mydriver env var.

const AUDIO_DRIVERS = {

  // RTL-SDR → ffmpeg MP3 pipeline.
  // -M am:  VHF airband is AM modulation (not FM)
  // -s 200k: sample rate for rtl_fm input
  // -r 48000: resample to 48 kHz for ffmpeg
  // -d 0:   dongle 0 (audio dongle, not ADS-B dongle)
  // ffmpeg: encode PCM S16LE → MP3 32 kbps (adequate for voice, low CPU)
  rtl_fm: (freqHz, gainDb) => ({
    cmd:  'sh',
    args: ['-c',
      `${CONFIG.RTL_FM_BIN} -f ${freqHz} -M am -s 200k -r 48000` +
      ` -g ${gainDb} -d ${CONFIG.RTL_DEVICE} -` +
      ` | ${CONFIG.FFMPEG_BIN} -hide_banner -loglevel error` +
      ` -f s16le -ar 48000 -ac 1 -i pipe:0` +
      ` -codec:a libmp3lame -b:a 32k -f mp3 pipe:1`
    ],
  }),

  // Mock: ffmpeg generates a 1 kHz sine tone — no hardware needed, for testing.
  // Uses lavfi (libavfilter) virtual input source.
  mock: (_freqHz, _gainDb) => ({
    cmd:  CONFIG.FFMPEG_BIN,
    args: [
      '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'sine=frequency=1000:sample_rate=48000',
      '-codec:a', 'libmp3lame', '-b:a', '32k',
      '-f', 'mp3', 'pipe:1',
    ],
  }),

};

// ─── AudioSource ──────────────────────────────────────────────────────────────
//
// Manages ONE child process for ONE frequency+gain combination.
// Multiple HTTP clients subscribe to the same PassThrough fan-out.
// Process is killed AUDIO_IDLE_TTL ms after the last client disconnects.
//
// gainDb is stored so that a gain change forces a new instance (different
// cache key in the pool) rather than silently keeping the old process.

class AudioSource {
  constructor(freqKHz, gainDb) {
    this.freqKHz    = freqKHz;
    this.gainDb     = gainDb;
    this.freqHz     = freqKHz * 1000;
    this.label      = FREQ_LABEL[freqKHz] || String(freqKHz);
    this._clients   = new Set();   // active PassThrough streams
    this._proc      = null;
    this._started   = false;
    this._idleTimer = null;
  }

  get isActive() { return this._started && this._proc !== null; }

  /** Subscribe a new client. Returns a PassThrough stream of MP3 bytes. */
  subscribe() {
    const pt = new PassThrough({ highWaterMark: 32 * 1024 });
    this._clients.add(pt);
    logger.info(`Audio [${this.label}@${this.gainDb}dB] +client (total: ${this._clients.size})`);

    pt.on('close', () => this._release(pt));
    pt.on('error', () => this._release(pt));

    clearTimeout(this._idleTimer);
    if (!this._started) this._start();

    return pt;
  }

  _release(pt) {
    if (!this._clients.has(pt)) return;
    this._clients.delete(pt);
    logger.info(`Audio [${this.label}@${this.gainDb}dB] -client (remaining: ${this._clients.size})`);
    // Schedule process shutdown after idle TTL — avoids immediate restart if
    // the user switches tabs briefly
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

    const { cmd, args } = driver(this.freqHz, this.gainDb);
    logger.info(`Audio [${this.label}@${this.gainDb}dB] spawn: ${cmd} ${args.join(' ')}`);

    this._proc    = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    this._started = true;

    // Fan MP3 bytes from one stdout to all subscribed PassThrough streams
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
      // code 0 on frequency switch is normal (SIGTERM from pool eviction)
      if (code !== 0 && code !== null) {
        logger.warn(`Audio [${this.label}] process exited unexpectedly (code ${code})`);
        this._broadcastError(new Error(`process exited with code ${code}`));
      }
      this._cleanup();
    });
  }

  _stop() {
    logger.info(`Audio [${this.label}] idle TTL expired — stopping`);
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
    this._cleanup();
    // Don't broadcast error on intentional destroy (frequency switch)
    for (const pt of this._clients) {
      try { pt.end(); } catch (_) {}
    }
    this._clients.clear();
  }
}

// ─── Audio Pool — enforces MAX 1 active dongle process ───────────────────────
//
// Root cause of the original bug: audioPool was keyed by freqKHz only.
// When the frontend switched frequencies, a new AudioSource was created but
// the old one was still running and holding dongle 0 exclusively.
// rtl_fm on the new frequency would exit immediately with code 0 (device busy).
//
// Fix:
//   1. Pool key is `${freqKHz}:${gainDb}` — gain changes also force new instance
//   2. getAudioSource() evicts ALL other active AudioSources before starting
//      a new one, then waits DONGLE_RELEASE_MS for the OS to release the USB
//      device before spawning the new rtl_fm process
//   3. audioIsActive() helper lets /audio/fft check dongle availability

const audioPool          = new Map();   // key: `${freqKHz}:${gainDb}` → AudioSource
const DONGLE_RELEASE_MS  = 600;         // ms to wait after SIGTERM before spawning new process

/** Returns true if any AudioSource currently holds the dongle */
function audioIsActive() {
  for (const src of audioPool.values()) {
    if (src.isActive) return true;
  }
  return false;
}

/**
 * Get-or-create an AudioSource, evicting all others first.
 * Returns a Promise because we need to wait for dongle release.
 */
async function getAudioSource(freqKHz, gainDb) {
  const key = `${freqKHz}:${gainDb}`;

  // Collect all other active sources that need to be stopped
  const toEvict = [];
  for (const [k, src] of audioPool) {
    if (k !== key && src.isActive) toEvict.push([k, src]);
  }

  if (toEvict.length > 0) {
    logger.info(`Audio pool: evicting ${toEvict.length} source(s) before starting [${FREQ_LABEL[freqKHz]}@${gainDb}dB]`);
    for (const [k, src] of toEvict) {
      src.destroy();
      audioPool.delete(k);
    }
    // Wait for the dongle to be released by the OS after SIGTERM
    await new Promise(r => setTimeout(r, DONGLE_RELEASE_MS));
  }

  if (!audioPool.has(key)) {
    audioPool.set(key, new AudioSource(freqKHz, gainDb));
  }
  return audioPool.get(key);
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

  beastSocket.on('connect', () => { beastConnected = true;  logger.info('Beast connected \u2713'); });
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

// CORS — allow any origin (Cloudflare Pages + local dev)
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
  audio_active:    [...audioPool.values()]
                     .filter(s => s.isActive)
                     .map(s => ({ label: s.label, freq_khz: s.freqKHz, gain_db: s.gainDb, clients: s._clients.size })),
  timestamp:       new Date().toISOString(),
}));

// ── /status — fr24feed-compatible ─────────────────────────────────────────
app.get('/status', (_req, res) => res.json({
  receiver: beastConnected ? 'connected' : 'disconnected',
  link:     beastConnected ? 'connected' : 'disconnected',
  mode:     'Beast',
  tracks:   tracks.size,
}));

// ── /audio/freqs — list all tunable frequencies ───────────────────────────
app.get('/audio/freqs', (_req, res) => res.json({
  freqs: Object.entries(EDDN_FREQS).map(([label, kHz]) => ({
    label,
    freq_khz:   kHz,
    freq_mhz:   (kHz / 1000).toFixed(3),
    stream_url: `/audio/stream?freq=${kHz}`,
  })),
}));

// ── /audio/stream?freq=<kHz>&gain=<0-50> ─────────────────────────────────
//
// Returns a chunked audio/mpeg stream. The browser <audio> element plays it
// natively — no JavaScript needed on the client side.
//
// ?gain= is optional; falls back to CONFIG.RTL_GAIN (env RTL_GAIN, default 40).
// Gain changes force a new AudioSource (old process evicted, dongle released,
// new rtl_fm spawned on the requested frequency at the new gain).
//
// Cloudflare note: X-Accel-Buffering: no disables proxy buffering so audio
// starts immediately rather than waiting for a full buffer to fill.
//
app.get('/audio/stream', async (req, res) => {
  const freqKHz = parseInt(req.query.freq, 10);
  const gainDb  = String(
    Math.min(50, Math.max(0, parseInt(req.query.gain ?? CONFIG.RTL_GAIN, 10))) || CONFIG.RTL_GAIN
  );
  const ip = req.socket.remoteAddress;

  // Validate frequency
  if (!freqKHz || isNaN(freqKHz)) {
    return res.status(400).json({
      error:   'Missing or invalid ?freq= parameter (integer kHz required)',
      example: '/audio/stream?freq=119475&gain=40',
    });
  }
  if (!FREQ_HZ_SET.has(freqKHz)) {
    return res.status(404).json({
      error:   `${freqKHz} kHz is not in the allowed set`,
      allowed: [...FREQ_HZ_SET].map(f => ({ freq_khz: f, label: FREQ_LABEL[f] })),
    });
  }

  const label = FREQ_LABEL[freqKHz];
  logger.info(`Audio [${label}@${gainDb}dB] stream request from ${ip}`);

  // Streaming headers — disable all proxy / CDN buffering
  res.setHeader('Content-Type',           'audio/mpeg');
  res.setHeader('Transfer-Encoding',      'chunked');
  res.setHeader('Cache-Control',          'no-cache, no-store, must-revalidate');
  res.setHeader('X-Accel-Buffering',      'no');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  // getAudioSource is async — it may wait DONGLE_RELEASE_MS for eviction
  const source = await getAudioSource(freqKHz, gainDb);
  const stream = source.subscribe();

  stream.pipe(res, { end: false });

  req.on('close', () => {
    logger.info(`Audio [${label}] client disconnected (${ip})`);
    stream.unpipe(res);
    stream.destroy();
  });

  stream.on('error', (err) => {
    logger.warn(`Audio [${label}] stream error for ${ip}: ${err.message}`);
    if (!res.headersSent) res.status(503).end();
    else res.end();
  });
});

// ── /audio/fft?bins=<N>&gain=<0-50> ──────────────────────────────────────
//
// Runs rtl_power for a single sweep over FFT_MIN_MHZ..FFT_MAX_MHZ (118-128 MHz).
// Returns normalised bin amplitudes as a flat array of floats [0..1].
//
// IMPORTANT CONSTRAINT: rtl_power uses the same dongle 0 as rtl_fm.
// If audio is currently streaming, the dongle is busy and we return 503.
// The frontend is expected to retry after retry_ms ms.
//
// rtl_power CSV output format (one line per sweep):
//   date, time, Hz_low, Hz_high, Hz_step, samples, dBm, dBm, ...
// We parse only the dBm values, normalise to [0..1], resample to `bins`.
//
app.get('/audio/fft', async (req, res) => {
  // Block if audio dongle is in use
  if (audioIsActive()) {
    return res.status(503).json({
      error:     'FFT unavailable while audio streaming',
      retry_ms:  1000,
    });
  }

  const binCount = Math.min(2048, Math.max(32, parseInt(req.query.bins ?? '512', 10)));
  const gainDb   = String(
    Math.min(50, Math.max(0, parseInt(req.query.gain ?? CONFIG.RTL_GAIN, 10))) || CONFIG.RTL_GAIN
  );

  // rtl_power arguments:
  //   -f 118M:128M:25k  sweep 118-128 MHz in 25 kHz steps
  //   -g <gain>          tuner gain
  //   -d 0               dongle 0
  //   -1                 single sweep, then exit
  //   -               write CSV to stdout
  const rtlArgs = [
    // FIX: use full Hz integers — the 'M'/'k' shorthand causes exit code 1
    //      on some rtl_power builds (confirmed on this Pi)
    '-f', `${Math.round(CONFIG.FFT_MIN_MHZ*1e6)}:${Math.round(CONFIG.FFT_MAX_MHZ*1e6)}:25000`,
    '-g', gainDb,
    '-d', String(CONFIG.RTL_DEVICE),
    '-1',        // single sweep
    '-',         // output to stdout
  ];

  logger.info(`FFT sweep ${CONFIG.FFT_MIN_MHZ}-${CONFIG.FFT_MAX_MHZ} MHz bins=${binCount} gain=${gainDb}`);

  let rawOutput = '';
  let exited    = false;

  const proc = spawn(CONFIG.RTL_POWER_BIN, rtlArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

  const timeout = setTimeout(() => {
    if (!exited) {
      logger.warn('FFT: rtl_power timed out — killing');
      proc.kill('SIGTERM');
    }
  }, 15_000);

  proc.stdout.on('data', (d) => { rawOutput += d.toString(); });
  proc.stderr.on('data', (d) => logger.debug(`FFT stderr: ${d.toString().trim()}`));

  proc.on('error', (err) => {
    clearTimeout(timeout);
    logger.error(`FFT spawn error: ${err.message}`);
    if (!res.headersSent) res.status(500).json({ error: `rtl_power failed: ${err.message}` });
  });

  proc.on('close', (code) => {
    exited = true;
    clearTimeout(timeout);

    if (code !== 0) {
      logger.warn(`FFT: rtl_power exited with code ${code}`);
      if (!res.headersSent) return res.status(500).json({ error: `rtl_power exited ${code}` });
      return;
    }

    // Guard: ensure output exists before parsing — empty string causes SyntaxError
    if (!rawOutput || rawOutput.trim().length === 0) {
      logger.warn('FFT: rtl_power produced no output');
      if (!res.headersSent) return res.status(500).json({ error: 'rtl_power produced no output' });
      return;
    }

    // Parse CSV output — collect all dBm values from all sweep lines
    const allDbm = [];
    for (const line of rawOutput.split('\n')) {
      const parts = line.trim().split(',');
      // CSV: date, time, hz_low, hz_high, hz_step, samples, [dBm...]
      if (parts.length < 7) continue;
      for (let i = 6; i < parts.length; i++) {
        const v = parseFloat(parts[i]);
        if (!isNaN(v)) allDbm.push(v);
      }
    }

    if (allDbm.length === 0) {
      logger.warn('FFT: no data parsed from rtl_power output');
      return res.status(500).json({ error: 'No FFT data received from rtl_power' });
    }

    // Normalise dBm to [0..1] using min/max of this sweep
    const minDbm = Math.min(...allDbm);
    const maxDbm = Math.max(...allDbm);
    const range  = maxDbm - minDbm || 1;
    const norm   = allDbm.map(v => (v - minDbm) / range);

    // Resample to requested bin count using simple linear interpolation
    const bins = [];
    for (let i = 0; i < binCount; i++) {
      const srcIdx = (i / (binCount - 1)) * (norm.length - 1);
      const lo     = Math.floor(srcIdx);
      const hi     = Math.min(lo + 1, norm.length - 1);
      const t      = srcIdx - lo;
      bins.push(+(norm[lo] * (1 - t) + norm[hi] * t).toFixed(4));
    }

    res.json({
      bins,
      bin_count:  binCount,
      min_khz:    CONFIG.FFT_MIN_MHZ * 1000,
      max_khz:    CONFIG.FFT_MAX_MHZ * 1000,
      min_dbm:    +minDbm.toFixed(1),
      max_dbm:    +maxDbm.toFixed(1),
      raw_bins:   allDbm.length,
      gain_db:    gainDb,
      ts:         Date.now(),
    });
  });
});

// ── Static frontend — catch-all must never swallow API routes ──────────────
// API routes (/health /status /audio/*) are registered above. The SPA
// catch-all below must not intercept them, otherwise index.html is returned
// instead of JSON (confirmed bug when frontend files exist on disk).
const API_PATHS = /^\/(health|status|audio)\b/;

if (fs.existsSync(CONFIG.STATIC_DIR)) {
  // Disable caching for JS/HTML/CSS so Cloudflare always fetches fresh files
  app.use((req, res, next) => {
    if (/\.(js|css|html)(\?.*)?$/.test(req.path)) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    }
    next();
  });
  app.use(express.static(CONFIG.STATIC_DIR));
  app.get('*', (req, res) => {
    if (API_PATHS.test(req.path)) {
      return res.status(404).json({ error: `API route ${req.path} not found` });
    }
    const index = path.join(CONFIG.STATIC_DIR, 'index.html');
    fs.existsSync(index)
      ? res.sendFile(index)
      : res.status(404).send(`Frontend not found \u2014 expected at ${CONFIG.STATIC_DIR}`);
  });
  logger.info(`Serving static files from ${CONFIG.STATIC_DIR}`);
} else {
  logger.warn(`Static dir not found: ${CONFIG.STATIC_DIR} \u2014 UI will not be served`);
  app.get('/', (_req, res) => res.json({ status: 'PIRX backend running', ui: 'not found' }));
}

// ─── WebSocket — /ws/traffic ──────────────────────────────────────────────────

const wss = new WebSocket.Server({ server, path: '/ws/traffic' });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  logger.info(`WS client connected: ${ip}  (total: ${wss.clients.size})`);
  sendTracks(ws);   // send current snapshot immediately

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
  logger.info('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  logger.info('  PIRX Radar Backend  |  iCAS2 ADS-B + Audio + FFT');
  logger.info('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
  logger.info(`  HTTP    -> http://0.0.0.0:${CONFIG.HTTP_PORT}`);
  logger.info(`  WS      -> ws://0.0.0.0:${CONFIG.HTTP_PORT}/ws/traffic`);
  logger.info(`  Audio   -> http://0.0.0.0:${CONFIG.HTTP_PORT}/audio/stream?freq=<kHz>&gain=<0-50>`);
  logger.info(`  FFT     -> http://0.0.0.0:${CONFIG.HTTP_PORT}/audio/fft?bins=512&gain=40`);
  logger.info(`  Freqs   -> http://0.0.0.0:${CONFIG.HTTP_PORT}/audio/freqs`);
  logger.info(`  Beast   -> ${CONFIG.BEAST_HOST}:${CONFIG.BEAST_PORT}`);
  logger.info(`  UI      -> ${CONFIG.STATIC_DIR}`);
  logger.info(`  AudSrc  -> ${CONFIG.AUDIO_SOURCE}  dongle:${CONFIG.RTL_DEVICE}  gain:${CONFIG.RTL_GAIN}dB`);
  logger.info(`  FFT     -> ${CONFIG.FFT_MIN_MHZ}-${CONFIG.FFT_MAX_MHZ} MHz`);
  logger.info('\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550');
});

connectBeast();

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown(signal) {
  logger.info(`${signal} \u2014 shutting down \u2026`);
  clearInterval(broadcastInterval);
  clearTimeout(reconnectTimer);
  // Stop all audio processes and release the dongle cleanly
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
