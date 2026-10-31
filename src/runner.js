// Browser entry point. The agent's page-script tool returns at most ~1000 characters,
// so results are computed in the page and returned compactly, with paging for long output.
const { computeReadiness, DEFAULT_CONFIG } = require('./core/readiness');
const { isHard, observedMaxHr, ageMaxHr } = require('./core/load');
const { addDays, daysBetween, round } = require('./core/stats');
const { todaySession, compareDay, weekdayOf, buildWeek, WEEKDAYS } = require('./core/plan');
const { DISTANCE_KM, riegel, formatTime } = require('./core/pace');
const { fetchCommon } = require('./adapters/garmin-browser');

const PAGE = 900;
let pending = [];

function localToday() {
  return new Date().toLocaleDateString('en-CA');
}

function paged(text) {
  pending = [];
  for (let i = 0; i < text.length; i += PAGE) pending.push(text.slice(i, i + PAGE));
  if (pending.length <= 1) return text;
  return `${pending[0]}\n[page 1/${pending.length}; call Headroom.more(2)]`;
}

function more(n) {
  const chunk = pending[n - 1];
  if (chunk === undefined) return '[no such page]';
  return n < pending.length ? `${chunk}\n[page ${n}/${pending.length}; call Headroom.more(${n + 1})]` : chunk;
}

const AUTH_MESSAGE = 'Garmin session expired. Reload connect.garmin.com (sign in if asked), then run again.';

function authExpired(data) {
  return data.days.length === 0 && data.warnings.some((w) => /HTTP 40[13]$/.test(w));
}

const UNREACHABLE_MESSAGE = "Garmin Connect didn't respond. The network may still have been waking up.";

function unreachable(data) {
  return data.days.length === 0 && data.warnings.some((w) => /(timed out|network error)$/.test(w));
}

// Start a long call and return at once; result() reports progress, then the answer. This keeps
// every javascript_tool call short, so a slow Garmin response can't hang the tool call itself.
let job = null;

function start(name, args) {
  const fns = { morningCheck, backtest, profile };
  if (!fns[name]) return `unknown: ${name}`;
  job = { name, startedAt: Date.now(), done: false, value: null };
  const current = job;
  Promise.resolve()
    .then(() => fns[name](args))
    .then((v) => { current.value = v; })
    .catch((e) => { current.value = JSON.stringify({ status: 'failed', reason: `script error: ${e.message}` }); })
    .finally(() => { current.done = true; });
  return `started ${name}; call Headroom.result()`;
}

function result() {
  if (!job) return 'nothing started';
  if (!job.done) return `running ${Math.round((Date.now() - job.startedAt) / 1000)}s; call Headroom.result() again`;
  return job.value;
}

// Max HR from setup wins; then the highest HR seen in the fetched activities, then the age estimate.
function resolveConfig(config, activities) {
  const cfg = { ...(config || {}) };
  if (!cfg.maxHr) cfg.maxHr = observedMaxHr(activities) || ageMaxHr(cfg.age) || DEFAULT_CONFIG.maxHr;
  return cfg;
}

// fetchData defaults to the browser session; tools/check.js passes the Personal API adapter instead
// and asks for the plain object (raw) rather than paged text.
async function morningCheck({ date, config, fetchData = fetchCommon, raw = false } = {}) {
  const d = date || localToday();
  const data = await fetchData({ startDate: addDays(d, -31), endDate: d, sleepFrom: addDays(d, -2) });
  const out = (o) => (raw ? o : paged(JSON.stringify(o)));
  if (authExpired(data)) return out({ date: d, status: 'auth-expired', message: AUTH_MESSAGE });
  if (unreachable(data)) return out({ date: d, status: 'unreachable', message: UNREACHABLE_MESSAGE });
  const cfg = resolveConfig(config, data.activities);
  const r = computeReadiness(data, d, cfg);
  const today = cfg.plan ? todaySession(cfg.plan, d, r.status === 'ok' ? r.band : null, cfg.maxHr, { limited: (r.limiters || []).length > 0 }) : null;
  // With a plan, the headline advice follows today's session rather than the score alone.
  const suggestion = today?.advice || r.suggestion;
  const headline = r.suggestion && suggestion !== r.suggestion ? r.message.replace(r.suggestion, suggestion) : r.message;
  const runsWithin = (from, to) => data.activities.filter((a) => {
    const ago = daysBetween(a.start.slice(0, 10), d);
    return a.type.includes('running') && ago >= from && ago <= to;
  });
  const km = (runs) => runs.reduce((s, a) => s + a.distanceM / 1000, 0);
  const yesterday = cfg.plan ? compareDay(cfg.plan, addDays(d, -1), km(runsWithin(1, 1)), cfg.maxHr) : null;
  const message = today ? `${headline} Today: ${today.suggestion}.${yesterday?.note ? ` ${yesterday.note}` : ''}` : r.message;
  // Logged so the Sunday job can plan from what was actually run, and judge beginner progress, without Garmin.
  const runs7d = runsWithin(1, 7).length;
  const recent = { km7d: round(km(runsWithin(1, 7)), 1), longestKm28d: round(runsWithin(1, 28).reduce((m, a) => Math.max(m, a.distanceM / 1000), 0), 1) };
  return out({
    date: r.date,
    status: r.status,
    score: r.score,
    band: r.band,
    source: r.source,
    estimateScore: r.estimateScore,
    message,
    suggestion,
    limiters: r.limiters,
    runs7d,
    recent,
    yesterday,
    today: today && { week: today.week, weekTargetKm: today.weekTargetKm, recoveryWeek: today.recoveryWeek, changed: today.changed, accessory: today.accessory, notes: today.notes },
    components: r.components,
    inputs: r.inputs,
    missing: r.missing,
    warnings: data.warnings.slice(0, 3),
  });
}

function dayFlag(activities, date, maxHr) {
  const todays = activities.filter((a) => a.start.startsWith(date));
  if (todays.some((a) => isHard(a, { maxHr }))) return 'h';
  if (todays.some((a) => a.type.includes('running'))) return 'r';
  return todays.length ? 'x' : '';
}

async function backtest({ endDate, days = 60, config } = {}) {
  const end = endDate || localToday();
  const first = addDays(end, -(days - 1));
  const data = await fetchCommon({ startDate: addDays(first, -31), endDate: end, sleepFrom: addDays(first, -2) });
  if (authExpired(data)) return AUTH_MESSAGE;
  const cfg = resolveConfig(config, data.activities);
  const rows = [];
  for (let d = first; d <= end; d = addDays(d, 1)) {
    const r = computeReadiness(data, d, cfg);
    const score = r.score === null ? '--' : String(r.score);
    rows.push(`${d.slice(5).replace('-', '')}:${score}${r.band ? r.band[0] : ''}${dayFlag(data.activities, d, cfg.maxHr)}`);
  }
  const legend = 'MMDD:score, band H/M/L/P, then activity that day: h hard, r run, x other';
  return paged(`${legend}\n${rows.join(' ')}`);
}

// For setup: what Headroom can see in the last 90 days, to pre-fill the questionnaire.
async function profile({ days = 90, fetchData = fetchCommon, raw = false } = {}) {
  const end = localToday();
  const data = await fetchData({ startDate: addDays(end, -(days - 1)), endDate: end, sleepFrom: end });
  const out = (o) => (raw ? o : JSON.stringify(o));
  if (authExpired(data)) return out({ status: 'auth-expired', message: AUTH_MESSAGE });
  if (unreachable(data)) return out({ status: 'unreachable', message: UNREACHABLE_MESSAGE });
  const withHrv = data.days.filter((d) => typeof d.hrvLastNight === 'number').length;
  const recent = data.activities.filter((a) => daysBetween(a.start.slice(0, 10), end) < 28);
  const recentRuns = recent.filter((a) => a.type.includes('running'));
  const runKm = recentRuns.reduce((s, a) => s + a.distanceM / 1000, 0);
  const longestRunKm = recentRuns.reduce((m, a) => Math.max(m, a.distanceM / 1000), 0);
  const liftCounts = {};
  for (const a of recent.filter((x) => x.type.includes('strength'))) {
    const wd = weekdayOf(a.start.slice(0, 10));
    liftCounts[wd] = (liftCounts[wd] || 0) + 1;
  }
  // Current race times, estimated from the best recent run of 3 km or more (Riegel). These
  // pre-fill the questionnaire; the user confirms or corrects them.
  const estimates = {};
  for (const [goal, km] of Object.entries(DISTANCE_KM)) {
    if (goal === 'fitness') continue;
    const best = data.activities
      .filter((a) => a.type.includes('running') && a.distanceM >= 3000 && (a.movingS || a.durationS))
      .map((a) => riegel(a.distanceM / 1000, a.movingS || a.durationS, km))
      .sort((x, y) => x - y)[0];
    if (best) estimates[goal] = formatTime(best);
  }
  return out({
    status: 'ok',
    estimatedTimes: estimates,
    weeklyRunKm4w: round(runKm / 4, 1),
    longestRunKm4w: round(longestRunKm, 1),
    usualLiftDays: Object.keys(liftCounts).filter((wd) => liftCounts[wd] >= 2),
    observedMaxHr: observedMaxHr(data.activities),
    activities: data.activities.length,
    runs: data.activities.filter((a) => a.type.includes('running')).length,
    daysWithHrv: withHrv,
    readyToScore: withHrv >= 14,
  });
}

// This week's plan as compact text. Pure: needs the config, not Garmin data.
function planWeek({ config, date } = {}) {
  const cfg = resolveConfig(config, []);
  if (!cfg.plan) return 'No plan in config. Run setup first.';
  const d = date || localToday();
  const w = buildWeek(cfg.plan, d, cfg.maxHr);
  const label = (x) => {
    const parts = [];
    if (x.run) parts.push(x.run.type === 'runwalk' ? `run/walk ${x.run.text}` : `${x.run.type} ${x.run.km} km`);
    if (x.strength) parts.push('strength');
    if (x.accessory) parts.push('runner block');
    return parts.join(' + ') || 'rest';
  };
  const lines = WEEKDAYS.map((wd) => `${wd}: ${label(w.days[wd])}`);
  const head = w.beginner
    ? `Week ${w.week}, stage ${w.beginner.stage} of ${w.beginner.of}`
    : `Week ${w.week}${w.recovery ? ' (lighter week)' : ''}, ${w.targetKm} km planned`;
  return paged([head, ...lines, ...w.notes.map((n) => `note: ${n}`)].join('\n'));
}

module.exports = { morningCheck, backtest, profile, planWeek, more, start, result, unreachable, computeReadiness, fetchCommon, authExpired, resolveConfig };
