// Runs inside a logged-in connect.garmin.com tab. Uses the same JSON endpoints the
// Garmin Connect web app calls, with the user's own session. Read-only.
const { addDays } = require('../core/stats');

// A request that never answers (network still down after the Mac wakes, say) would hang the
// whole check, so each one gets a timeout and one retry. HTTP errors are not retried.
const TIMEOUT_MS = 15000;

async function gget(path, retries = 1) {
  const token = document.querySelector('meta[name="csrf-token"]')?.content;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res;
  try {
    res = await fetch(`/gc-api${path}`, {
      credentials: 'include',
      headers: { 'connect-csrf-token': token, accept: 'application/json' },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (retries > 0) return gget(path, retries - 1);
    throw new Error(e.name === 'AbortError' ? 'timed out' : 'network error');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

function ranges(start, end, size = 28) {
  const out = [];
  for (let s = start; s <= end; s = addDays(s, size)) {
    const e = addDays(s, size - 1);
    out.push([s, e < end ? e : end]);
  }
  return out;
}

function dateList(start, end) {
  const out = [];
  for (let d = start; d <= end; d = addDays(d, 1)) out.push(d);
  return out;
}

async function inBatches(items, size, fn) {
  const results = [];
  for (let i = 0; i < items.length; i += size) {
    results.push(...(await Promise.all(items.slice(i, i + size).map(fn))));
  }
  return results;
}

function wakeLevel(values, sleepEndGmt) {
  const points = (values || []).filter((p) => Array.isArray(p) && typeof p[1] === 'number');
  if (!points.length) return null;
  if (sleepEndGmt) {
    const after = points.find((p) => p[0] >= sleepEndGmt - 30 * 60000);
    if (after) return after[1];
  }
  return Math.max(...points.map((p) => p[1]));
}

// One night's HRV summary in the shape the scoring code uses. Shared with garmin-api.js.
function hrvFields(x) {
  return {
    hrvLastNight: x.lastNightAvg ?? null,
    hrvWeeklyAvg: x.weeklyAvg ?? null,
    hrvStatus: x.status ?? null,
    hrvBalancedLow: x.baseline?.balancedLow ?? null,
    hrvBalancedHigh: x.baseline?.balancedUpper ?? null,
  };
}

// One Garmin activity in the shape the scoring code uses.
function toActivity(a) {
  const zones = [1, 2, 3, 4, 5].map((i) => a[`hrTimeInZone_${i}`]);
  // Editing an activity's time in Garmin updates duration but leaves moving time as recorded,
  // so a duration longer than the elapsed time means moving time is stale.
  const edited = a.elapsedDuration && a.duration > a.elapsedDuration + 60;
  return {
    start: String(a.startTimeLocal).replace(' ', 'T'),
    type: a.activityType?.typeKey || 'unknown',
    durationS: Math.round(a.duration || 0),
    movingS: a.movingDuration && !edited ? Math.round(a.movingDuration) : null,
    distanceM: Math.round(a.distance || 0),
    avgHr: a.averageHR ?? null,
    maxHr: a.maxHR ?? null,
    aerobicTe: a.aerobicTrainingEffect ?? null,
    label: a.trainingEffectLabel ?? null,
    zoneSeconds: zones.some((z) => typeof z === 'number') ? zones.map((z) => Math.round(z || 0)) : null,
  };
}

async function fetchCommon({ startDate, endDate, sleepFrom }) {
  if (!location.hostname.endsWith('connect.garmin.com')) {
    throw new Error('Open connect.garmin.com in this tab first.');
  }
  const days = new Map();
  const day = (date) => {
    if (!days.has(date)) days.set(date, { date });
    return days.get(date);
  };
  const warnings = [];
  const safe = (p, label) => p.catch((e) => { warnings.push(`${label}: ${e.message}`); return null; });

  // One cheap request first: if Garmin doesn't answer, stop in ~30 s instead of timing out every call.
  const profile = await safe(gget('/userprofile-service/socialProfile'), 'profile');
  if (!profile && /(timed out|network error)$/.test(warnings[0] || '')) return { days: [], activities: [], warnings };

  for (const [s, e] of ranges(startDate, endDate)) {
    const hrv = await safe(gget(`/hrv-service/hrv/daily/${s}/${e}`), 'hrv');
    for (const x of hrv?.hrvSummaries || []) Object.assign(day(x.calendarDate), hrvFields(x));
    const rhr = await safe(gget(`/usersummary-service/stats/heartRate/daily/${s}/${e}`), 'rhr');
    for (const x of rhr || []) {
      if (typeof x.values?.restingHR === 'number') day(x.calendarDate).restingHr = x.values.restingHR;
    }
  }

  const sleepEnd = {};
  if (profile?.displayName) {
    const name = encodeURIComponent(profile.displayName);
    await inBatches(dateList(sleepFrom, endDate), 6, async (date) => {
      const j = await safe(gget(`/wellness-service/wellness/dailySleepData/${name}?date=${date}&nonSleepBufferMinutes=60`), `sleep ${date}`);
      const dto = j?.dailySleepDTO;
      if (!dto || !dto.sleepTimeSeconds) return;
      Object.assign(day(date), {
        sleepSeconds: dto.sleepTimeSeconds,
        sleepScore: dto.sleepScores?.overall?.value ?? null,
      });
      sleepEnd[date] = dto.sleepEndTimestampGMT || null;
    });
  }

  for (const [s, e] of ranges(sleepFrom, endDate)) {
    const bb = await safe(gget(`/wellness-service/wellness/bodyBattery/reports/daily?startDate=${s}&endDate=${e}`), 'bodyBattery');
    for (const x of bb || []) {
      const level = wakeLevel(x.bodyBatteryValuesArray, sleepEnd[x.date]);
      if (level !== null) day(x.date).bodyBatteryWake = level;
    }
  }

  // Garmin's own Training Readiness (Forerunner 265 and up, Fenix, Epix...). Returns [] on
  // watches without it, so only fetch the other days when today has a score.
  const readinessOn = async (date) => {
    const list = await safe(gget(`/metrics-service/metrics/trainingreadiness/${date}`), `readiness ${date}`);
    const entries = (Array.isArray(list) ? list : []).filter((x) => typeof x?.score === 'number');
    if (!entries.length) return false;
    const latest = entries.sort((a, b) => String(a.timestamp || '').localeCompare(String(b.timestamp || ''))).pop();
    day(date).deviceReadiness = { score: latest.score, level: latest.level ?? null, source: 'Garmin Training Readiness' };
    return true;
  };
  if (await readinessOn(endDate)) {
    await inBatches(dateList(sleepFrom, addDays(endDate, -1)), 6, readinessOn);
  }

  const activities = [];
  for (let offset = 0; offset < 1000; offset += 100) {
    const page = await safe(
      gget(`/activitylist-service/activities/search/activities?startDate=${startDate}&endDate=${endDate}&limit=100&start=${offset}`),
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

module.exports = { fetchCommon, wakeLevel, toActivity, hrvFields, ranges, dateList };
