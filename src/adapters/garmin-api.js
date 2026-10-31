// Garmin's official Personal API (personal.connectapi.garmin.com), using the user's own key from
// ~/.headroom/garmin.key. Returns the same common format as garmin-browser.js. Read-only.
// Node only: not part of the page script.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { addDays } = require('../core/stats');
const { wakeLevel, toActivity, hrvFields, ranges } = require('./garmin-browser');

const BASE = 'https://personal.connectapi.garmin.com';
const KEY_FILE = path.join(os.homedir(), '.headroom', 'garmin.key');
const TIMEOUT_MS = 15000;

function readKey(file = KEY_FILE) {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

// Same policy as the browser adapter: a timeout and one retry on network errors, none on HTTP errors.
async function request(fetchImpl, url, init, retries = 1) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(url, { ...init, signal: ctrl.signal });
  } catch (e) {
    if (retries > 0) return request(fetchImpl, url, init, retries - 1);
    throw new Error(e.name === 'AbortError' ? 'timed out' : 'network error');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

// The key is swapped for an access token (valid 24 hours). The endpoint answers with the bare
// token as its body; JSON is accepted too in case that changes. Never log either value.
async function connect({ key = readKey(), fetchImpl = fetch } = {}) {
  if (!key) throw new Error('no key');
  const res = await request(fetchImpl, `${BASE}/personalapitoken-service/personal-api/personal-api-key/token`, {
    method: 'POST',
    headers: { Authorization: `ApiKey ${key}` },
  });
  let token = (await res.text()).trim();
  try {
    const j = JSON.parse(token);
    token = j.access_token || j.accessToken || j.token || null;
  } catch {}
  if (!token) throw new Error('no token in response');
  const headers = { Authorization: `Bearer ${token}`, Accept: 'application/json' };
  return {
    async get(p) {
      const text = await (await request(fetchImpl, BASE + p, { headers })).text();
      return text ? JSON.parse(text) : null;
    },
    // Downloads answer 406 to an Accept: application/json header.
    async getBuffer(p) {
      const res = await request(fetchImpl, BASE + p, { headers: { Authorization: headers.Authorization, Accept: '*/*' } });
      return Buffer.from(await res.arrayBuffer());
    },
  };
}

async function fetchCommon(api, { startDate, endDate, sleepFrom }) {
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date });
    return days.get(date);
  };
  const warnings = [];
  const safe = (p, label) => p.catch((e) => { warnings.push(`${label}: ${e.message}`); return null; });

  for (const [s, e] of ranges(startDate, endDate)) {
    const hrv = await safe(api.get(`/hrv-service/hrv/daily/${s}/${e}`), 'hrv');
    for (const x of hrv?.hrvSummaries || []) Object.assign(day(x.calendarDate), hrvFields(x));
    const sums = await safe(api.get(`/usersummary-service/v2/dailysummaries?startDate=${s}&endDate=${e}`), 'rhr');
    for (const x of sums?.data || []) {
      if (typeof x.heartRate?.restingValue === 'number') day(x.calendarDate).restingHr = x.heartRate.restingValue;
    }
  }

  // Longer sleep ranges come back empty, so ask a week at a time.
  const sleepEnd = {};
  for (const [s, e] of ranges(sleepFrom, endDate, 7)) {
    const list = await safe(api.get(`/sleep-service/sleep/dailySleepSummariesByDate?startDate=${s}&endDate=${e}`), 'sleep');
    for (const x of Array.isArray(list) ? list : []) {
      if (!x.sleepTimeSeconds) continue;
      Object.assign(day(x.calendarDate), { sleepSeconds: x.sleepTimeSeconds, sleepScore: x.sleepScores?.overall?.value ?? null });
      sleepEnd[x.calendarDate] = x.sleepEndTimestampGMT || null;
    }
  }

  for (const [s, e] of ranges(sleepFrom, endDate)) {
    const bb = await safe(api.get(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${e}`), 'bodyBattery');
    for (const x of bb || []) {
      const level = wakeLevel(x.bodyBatteryValuesArray, sleepEnd[x.date]);
      if (level !== null) day(x.date).bodyBatteryWake = level;
    }
  }

  // Garmin Training Readiness isn't offered by the Personal API, so watches that have it get the
  // Headroom estimate on this path.
  const activities = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await safe(
      api.get(`/activitylist-service/activities/search/activities?startDate=${startDate}&endDate=${endDate}&limit=100&start=${offset}`),
      'activities',
    );
    for (const a of page || []) activities.push(toActivity(a));
    if (!page || page.length < 100) break;
  }

  return {
    source: 'garmin',
    days: [...days.values()].sort((a, b) => (a.date < b.date ? -1 : 1)),
    activities,
    warnings,
  };
}

// The download endpoint returns a zip holding one .fit file.
function unzipFit(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('not a zip file');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad zip directory');
    const method = buf.readUInt16LE(p + 10);
    const size = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);
    if (!/\.fit$/i.test(name)) continue;
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    if (method === 0) return data;
    if (method === 8) return zlib.inflateRawSync(data);
    throw new Error(`unsupported zip compression ${method}`);
  }
  throw new Error('no .fit file in zip');
}

async function downloadFit(api, activityId) {
  return unzipFit(await api.getBuffer(`/download-service/files/activity/${activityId}`));
}

// Latest activity of a type (default running) on or before a date, from the last 30 days.
async function findActivity(api, { date, type = 'running' } = {}) {
  const end = date || new Date().toLocaleDateString('en-CA');
  const list = await api.get(`/activitylist-service/activities/search/activities?startDate=${addDays(end, -30)}&endDate=${end}&limit=100&start=0`);
  return (list || []).find((a) => (a.activityType?.typeKey || '').includes(type)) || null;
}

module.exports = { BASE, KEY_FILE, readKey, connect, fetchCommon, unzipFit, downloadFit, findActivity };
