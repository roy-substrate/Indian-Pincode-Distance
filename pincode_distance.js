#!/usr/bin/env node
/**
 * Calculate road (transport) distance between Indian pincodes.
 *
 * Default backend: OpenRouteService Matrix API (free tier).
 *     https://openrouteservice.org/dev/#/signup
 *
 * Modes
 * -----
 * Single lookup:
 *     node pincode_distance.js 560076 560103
 *
 * Batch lookup (CSV with `from,to` columns -> writes results CSV):
 *     node pincode_distance.js --batch pairs.csv results.csv
 *
 * Configuration via environment variables
 * ---------------------------------------
 * ORS_API_KEY   Your free OpenRouteService API key (required for default backend).
 *               Get one at https://openrouteservice.org/dev/#/signup
 *
 * BACKEND       "ors" (default) or "osrm". Switch to "osrm" to use OSRM instead.
 *
 * OSRM_BASE     OSRM endpoint when BACKEND=osrm. Defaults to the public demo:
 *               https://router.project-osrm.org/route/v1/driving
 *               For unlimited free use, self-host OSRM (see docker-compose.yml)
 *               and set OSRM_BASE=http://localhost:5000/route/v1/driving
 *
 * ORS_DELAY     Seconds to sleep between ORS calls in batch mode. Default 1.6.
 * OSRM_DELAY    Seconds to sleep between OSRM calls in batch mode. Default 1.0.
 *
 * CACHE_DB      Path to the JSON cache file. Defaults to .pincode_cache.json
 *               Cached results are reused forever, so re-runs are free.
 *
 * PINCODE_CSV   Path to the dataset (default: pincode_data.csv).
 *
 * Requirements
 * ------------
 * Node.js 14 or newer. Uses only built-in modules — no `npm install` required.
 */

'use strict';

const fs = require('fs');
const https = require('https');
const http = require('http');
const { URL } = require('url');

// ---------- config ----------

const CSV_PATH = process.env.PINCODE_CSV || 'pincode_data.csv';
const BACKEND = (process.env.BACKEND || 'ors').toLowerCase();

const ORS_API_KEY = process.env.ORS_API_KEY || '';
const ORS_URL = 'https://api.openrouteservice.org/v2/matrix/driving-car';
const ORS_DELAY_MS = parseFloat(process.env.ORS_DELAY || '1.6') * 1000;
const ORS_MAX_LOCATIONS = 50;

const OSRM_BASE =
  process.env.OSRM_BASE || 'https://router.project-osrm.org/route/v1/driving';
const OSRM_DELAY_MS = parseFloat(process.env.OSRM_DELAY || '1.0') * 1000;

const CACHE_PATH = process.env.CACHE_DB || '.pincode_cache.json';
const USER_AGENT = 'indian-pincode-distance/1.0';


// ---------- CSV parser (quoted fields + embedded commas) ----------

function parseCSV(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
        } else {
          inQuotes = false;
          i++;
        }
      } else {
        field += c;
        i++;
      }
    } else if (c === '"') {
      inQuotes = true;
      i++;
    } else if (c === ',') {
      row.push(field);
      field = '';
      i++;
    } else if (c === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      i++;
    } else if (c === '\r') {
      i++;
    } else {
      field += c;
      i++;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}


// ---------- pincode -> coordinates ----------

function loadPincodeCoords(csvPath = CSV_PATH) {
  const text = fs.readFileSync(csvPath, 'utf8');
  const rows = parseCSV(text);
  if (rows.length === 0) return new Map();
  const header = rows[0];
  const idx = {};
  header.forEach((h, i) => {
    idx[h] = i;
  });

  const coords = new Map();
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (row.length < header.length) continue;
    const pin = (row[idx.pincode] || '').trim();
    if (!pin || coords.has(pin)) continue;
    const latS = (row[idx.latitude] || '').trim();
    const lonS = (row[idx.longitude] || '').trim();
    if (!latS || !lonS || latS === 'NA' || lonS === 'NA') continue;
    const lat = parseFloat(latS);
    const lon = parseFloat(lonS);
    if (Number.isNaN(lat) || Number.isNaN(lon)) continue;
    coords.set(pin, {
      lat,
      lon,
      office: row[idx.officename],
      district: row[idx.district],
      state: row[idx.statename],
    });
  }
  return coords;
}


// ---------- HTTP helpers (zero deps) ----------

function httpRequest(method, urlStr, headers = {}, body = null) {
  return new Promise((resolve, reject) => {
    let u;
    try {
      u = new URL(urlStr);
    } catch (err) {
      reject(err);
      return;
    }
    const lib = u.protocol === 'https:' ? https : http;
    const reqHeaders = { 'User-Agent': USER_AGENT, ...headers };
    if (body != null) {
      reqHeaders['Content-Length'] = Buffer.byteLength(body);
    }
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method,
        headers: reqHeaders,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          resolve({ statusCode: res.statusCode, body: data });
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(60000, () => {
      req.destroy(new Error('request timeout'));
    });
    if (body != null) req.write(body);
    req.end();
  });
}


// ---------- OpenRouteService backend ----------

async function orsMatrix(locations, apiKey = ORS_API_KEY) {
  if (!apiKey) {
    throw new Error(
      'ORS_API_KEY is not set. Get a free key at ' +
        'https://openrouteservice.org/dev/#/signup and: ' +
        'export ORS_API_KEY=your-key-here'
    );
  }
  if (locations.length > ORS_MAX_LOCATIONS) {
    throw new Error(
      `ORS free tier allows up to ${ORS_MAX_LOCATIONS} locations per matrix ` +
        `call (got ${locations.length}).`
    );
  }
  const payload = JSON.stringify({
    locations: locations.map((l) => [l.lon, l.lat]),
    metrics: ['distance', 'duration'],
    units: 'km',
  });
  const res = await httpRequest(
    'POST',
    ORS_URL,
    {
      Authorization: apiKey,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    payload
  );
  if (res.statusCode >= 400) {
    throw new Error(
      `ORS HTTP ${res.statusCode}: ${res.body.slice(0, 500)}`
    );
  }
  return JSON.parse(res.body);
}

async function orsPair(lat1, lon1, lat2, lon2) {
  const data = await orsMatrix([
    { lat: lat1, lon: lon1 },
    { lat: lat2, lon: lon2 },
  ]);
  const dk = data.distances[0][1];
  const ds = data.durations[0][1];
  if (dk == null || ds == null) {
    throw new Error('ORS returned null (no route between points).');
  }
  return { distanceKm: dk, durationMin: ds / 60 };
}


// ---------- OSRM backend ----------

async function osrmPair(lat1, lon1, lat2, lon2) {
  const url = `${OSRM_BASE}/${lon1},${lat1};${lon2},${lat2}?overview=false`;
  const res = await httpRequest('GET', url);
  if (res.statusCode !== 200) {
    throw new Error(
      `OSRM HTTP ${res.statusCode}: ${res.body.slice(0, 200)}`
    );
  }
  const data = JSON.parse(res.body);
  if (data.code !== 'Ok' || !data.routes || data.routes.length === 0) {
    throw new Error(`OSRM error: ${data.message || data.code}`);
  }
  const route = data.routes[0];
  return {
    distanceKm: route.distance / 1000,
    durationMin: route.duration / 60,
  };
}

async function routePair(lat1, lon1, lat2, lon2) {
  if (BACKEND === 'ors') return orsPair(lat1, lon1, lat2, lon2);
  if (BACKEND === 'osrm') return osrmPair(lat1, lon1, lat2, lon2);
  throw new Error(`Unknown BACKEND: ${BACKEND} (use 'ors' or 'osrm')`);
}


// ---------- JSON file cache (symmetric, keyed by backend) ----------

class Cache {
  constructor(filePath = CACHE_PATH) {
    this.path = filePath;
    this.data = {};
    if (fs.existsSync(filePath)) {
      try {
        const raw = fs.readFileSync(filePath, 'utf8');
        if (raw.trim()) this.data = JSON.parse(raw);
      } catch (_e) {
        console.warn(
          `Warning: could not read cache at ${filePath}, starting fresh.`
        );
        this.data = {};
      }
    }
    this.dirty = false;
  }
  _key(a, b) {
    const [x, y] = a <= b ? [a, b] : [b, a];
    return `${BACKEND}|${x}|${y}`;
  }
  get(a, b) {
    return this.data[this._key(a, b)];
  }
  put(a, b, distKm, durMin) {
    this.data[this._key(a, b)] = { d: distKm, t: durMin };
    this.dirty = true;
  }
  save() {
    if (!this.dirty) return;
    fs.writeFileSync(this.path, JSON.stringify(this.data));
    this.dirty = false;
  }
}


// ---------- formatters ----------

function formatDuration(minutes) {
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  return h ? `${h}h ${m}m` : `${m}m`;
}

function sleep(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function csvEscape(value) {
  if (value === undefined || value === null) return '';
  const v = String(value);
  if (v.includes(',') || v.includes('"') || v.includes('\n')) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}


// ---------- single mode ----------

async function singleLookup(pinFrom, pinTo) {
  console.log(`Loading ${CSV_PATH} ...`);
  const coords = loadPincodeCoords();
  console.log(
    `Loaded ${coords.size.toLocaleString('en-IN')} pincodes with valid ` +
      `coordinates.`
  );
  console.log(`Backend: ${BACKEND.toUpperCase()}\n`);

  const missing = [pinFrom, pinTo].filter((p) => !coords.has(p));
  if (missing.length > 0) {
    console.log(
      `Pincode(s) not found or missing coordinates: ${missing.join(', ')}`
    );
    process.exit(2);
  }

  const a = coords.get(pinFrom);
  const b = coords.get(pinTo);
  console.log(`From: ${pinFrom}  ${a.office}, ${a.district}, ${a.state}`);
  console.log(`To  : ${pinTo}  ${b.office}, ${b.district}, ${b.state}\n`);

  const cache = new Cache();
  const cached = cache.get(pinFrom, pinTo);
  let distanceKm;
  let durationMin;
  let source;
  if (cached) {
    distanceKm = cached.d;
    durationMin = cached.t;
    source = 'cache';
  } else {
    try {
      ({ distanceKm, durationMin } = await routePair(
        a.lat,
        a.lon,
        b.lat,
        b.lon
      ));
    } catch (err) {
      console.log(`${BACKEND.toUpperCase()} request failed: ${err.message}`);
      process.exit(3);
    }
    cache.put(pinFrom, pinTo, distanceKm, durationMin);
    cache.save();
    source = BACKEND.toUpperCase();
  }

  console.log(
    `Road distance (${source})  : ${distanceKm.toFixed(2)} km`
  );
  console.log(
    `Estimated driving time   : ${formatDuration(durationMin)}`
  );
}


// ---------- batch mode ----------

async function batchLookup(inputCsv, outputCsv) {
  console.log(`Loading ${CSV_PATH} ...`);
  const coords = loadPincodeCoords();
  console.log(
    `Loaded ${coords.size.toLocaleString('en-IN')} pincodes with valid ` +
      `coordinates.`
  );
  console.log(`Backend: ${BACKEND.toUpperCase()}`);

  const text = fs.readFileSync(inputCsv, 'utf8');
  const rows = parseCSV(text);
  if (rows.length < 2) {
    console.log('Input CSV is empty.');
    process.exit(2);
  }
  const header = rows[0];
  const fromIdx = header.indexOf('from');
  const toIdx = header.indexOf('to');
  if (fromIdx < 0 || toIdx < 0) {
    console.log('Input CSV must have headers: from,to');
    process.exit(2);
  }

  const pairs = rows
    .slice(1)
    .filter((r) => r.length >= 2 && r[fromIdx] && r[toIdx])
    .map((r) => ({ from: r[fromIdx].trim(), to: r[toIdx].trim() }));
  console.log(
    `Read ${pairs.length.toLocaleString('en-IN')} pairs from ${inputCsv}`
  );
  console.log(`Cache file: ${CACHE_PATH}\n`);

  const cache = new Cache();

  let cacheHits = 0;
  let failures = 0;
  const enriched = [];

  for (const pair of pairs) {
    const rec = { from: pair.from, to: pair.to };
    if (!coords.has(pair.from) || !coords.has(pair.to)) {
      rec.status = 'missing_coords';
      enriched.push({ rec, needLookup: false });
      failures++;
      continue;
    }
    const a = coords.get(pair.from);
    const b = coords.get(pair.to);
    rec.from_office = a.office;
    rec.from_district = a.district;
    rec.from_state = a.state;
    rec.to_office = b.office;
    rec.to_district = b.district;
    rec.to_state = b.state;

    const cached = cache.get(pair.from, pair.to);
    if (cached) {
      rec.road_km = cached.d.toFixed(3);
      rec.duration_min = cached.t.toFixed(1);
      rec.status = 'ok_cached';
      cacheHits++;
      enriched.push({ rec, needLookup: false });
    } else {
      enriched.push({ rec, needLookup: true, a, b });
    }
  }

  const uncached = enriched.filter((e) => e.needLookup);
  console.log(
    `Cache hits: ${cacheHits.toLocaleString('en-IN')}  |  ` +
      `Need fresh lookups: ${uncached.length.toLocaleString('en-IN')}`
  );

  let liveRoutes = 0;
  let apiCalls = 0;
  const started = Date.now();

  if (BACKEND === 'ors') {
    let chunkPairs = [];
    let unique = new Map(); // pincode -> {lat, lon}

    const flush = async () => {
      if (chunkPairs.length === 0) return;
      const locItems = [...unique.entries()];
      const locIndex = new Map();
      locItems.forEach(([pin, _], i) => locIndex.set(pin, i));
      const locList = locItems.map(([_, ll]) => ll);
      try {
        const data = await orsMatrix(locList);
        apiCalls++;
        for (const cp of chunkPairs) {
          const i = locIndex.get(cp.rec.from);
          const j = locIndex.get(cp.rec.to);
          const dk = data.distances[i][j];
          const ds = data.durations[i][j];
          if (dk == null || ds == null) {
            cp.rec.status = 'no_route';
            failures++;
          } else {
            const dm = ds / 60;
            cp.rec.road_km = dk.toFixed(3);
            cp.rec.duration_min = dm.toFixed(1);
            cp.rec.status = 'ok';
            cache.put(cp.rec.from, cp.rec.to, dk, dm);
            liveRoutes++;
          }
        }
      } catch (err) {
        const errMsg = `ors_error: ${err.message}`;
        for (const cp of chunkPairs) {
          cp.rec.status = errMsg;
          failures++;
        }
      }
      await sleep(ORS_DELAY_MS);
    };

    for (const e of uncached) {
      const pf = e.rec.from;
      const pt = e.rec.to;
      const needNew =
        (unique.has(pf) ? 0 : 1) + (unique.has(pt) ? 0 : 1);
      if (unique.size + needNew > ORS_MAX_LOCATIONS) {
        await flush();
        unique = new Map();
        chunkPairs = [];
      }
      if (!unique.has(pf)) unique.set(pf, { lat: e.a.lat, lon: e.a.lon });
      if (!unique.has(pt)) unique.set(pt, { lat: e.b.lat, lon: e.b.lon });
      chunkPairs.push(e);

      if (chunkPairs.length % 100 === 0) {
        const done = cacheHits + liveRoutes + failures;
        const elapsed = ((Date.now() - started) / 1000).toFixed(1);
        console.log(
          `  pairs queued=${done}  api_calls=${apiCalls}  live=${liveRoutes}  ` +
            `failed=${failures}  (${elapsed}s elapsed)`
        );
      }
    }
    await flush();
  } else {
    // OSRM: sequential
    for (let i = 0; i < uncached.length; i++) {
      const e = uncached[i];
      try {
        const { distanceKm, durationMin } = await osrmPair(
          e.a.lat,
          e.a.lon,
          e.b.lat,
          e.b.lon
        );
        e.rec.road_km = distanceKm.toFixed(3);
        e.rec.duration_min = durationMin.toFixed(1);
        e.rec.status = 'ok';
        cache.put(e.rec.from, e.rec.to, distanceKm, durationMin);
        liveRoutes++;
        await sleep(OSRM_DELAY_MS);
      } catch (err) {
        e.rec.status = `osrm_error: ${err.message}`;
        failures++;
      }
      if ((i + 1) % 50 === 0) {
        console.log(
          `  osrm ${i + 1}/${uncached.length} live=${liveRoutes} ` +
            `failed=${failures}`
        );
      }
    }
  }

  const outFields = [
    'from',
    'to',
    'from_office',
    'from_district',
    'from_state',
    'to_office',
    'to_district',
    'to_state',
    'road_km',
    'duration_min',
    'status',
  ];
  const lines = [outFields.join(',')];
  for (const { rec } of enriched) {
    lines.push(outFields.map((f) => csvEscape(rec[f])).join(','));
  }
  fs.writeFileSync(outputCsv, lines.join('\n') + '\n');
  cache.save();

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `\nDone in ${elapsed}s. cached=${cacheHits} live=${liveRoutes} ` +
      `api_calls=${apiCalls} failed=${failures} -> ${outputCsv}`
  );
}


// ---------- entry ----------

const HELP = `
Calculate road (transport) distance between Indian pincodes.

Default backend: OpenRouteService Matrix API (free tier).
    https://openrouteservice.org/dev/#/signup

Modes
-----
Single lookup:
    node pincode_distance.js 560076 560103

Batch lookup (CSV with 'from,to' columns -> writes results CSV):
    node pincode_distance.js --batch pairs.csv results.csv

Environment variables
---------------------
ORS_API_KEY   Your free OpenRouteService API key (default backend).
BACKEND       "ors" (default) or "osrm".
OSRM_BASE     OSRM endpoint when BACKEND=osrm.
ORS_DELAY     Seconds between ORS calls (default 1.6).
OSRM_DELAY    Seconds between OSRM calls (default 1.0).
CACHE_DB      Path to the JSON cache file (default .pincode_cache.json).
PINCODE_CSV   Path to the dataset (default pincode_data.csv).
`;

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 2 && args[0] !== '--batch') {
    await singleLookup(args[0].trim(), args[1].trim());
  } else if (args.length === 3 && args[0] === '--batch') {
    await batchLookup(args[1], args[2]);
  } else {
    console.log(HELP);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
