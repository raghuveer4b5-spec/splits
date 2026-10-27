const { isNum, mean, sd, clamp, round, addDays, daysBetween } = require('./stats');
const { loadSummary, ratioScore } = require('./load');

const DEFAULT_CONFIG = {
  maxHr: 190,
  restHrFallback: 55,
  baselineDays: 30,
  minHistoryDays: 14,
  sleepTargetHours: 8,
  weights: { hrv: 0.3, sleep: 0.25, load: 0.25, rhr: 0.15, bodyBattery: 0.05 },
};

const SUGGESTIONS = {
  High: 'Good day for intervals or a time trial.',
  Moderate: 'Planned session is fine; keep hard efforts controlled, or swap to easy if you feel off.',
  Low: 'Keep it easy and short, or cross-train.',
  Poor: 'Rest, or a gentle walk.',
};

function bandFor(score) {
  if (score >= 75) return 'High';
  if (score >= 50) return 'Moderate';
  if (score >= 25) return 'Low';
  return 'Poor';
}

function history(days, date, field, window) {
  return days
    .filter((d) => d.date < date && daysBetween(d.date, date) <= window && isNum(d[field]))
    .map((d) => d[field]);
}

function earliestDate(data) {
  const dates = [
    ...data.days.map((d) => d.date),
    ...(data.activities || []).map((a) => a.start.slice(0, 10)),
  ].sort();
  return dates[0] || null;
}

function formatHours(h) {
  const whole = Math.floor(h);
  return `${whole}h${String(Math.round((h - whole) * 60)).padStart(2, '0')}`;
}

function limiterText(key, inputs) {
  switch (key) {
    case 'hrv':
      return `HRV below your normal (${inputs.hrv} vs ${inputs.hrvBaseline} ms)`;
    case 'rhr':
      return `resting HR above normal (${inputs.rhr} vs ${Math.round(inputs.rhrBaseline)} bpm)`;
    case 'sleep': {
      const parts = [];
      if (isNum(inputs.sleepHours)) parts.push(formatHours(inputs.sleepHours));
      if (isNum(inputs.sleepScore)) parts.push(`score ${inputs.sleepScore}`);
      return `short or poor sleep${parts.length ? ` (${parts.join(', ')})` : ''}`;
    }
    case 'load': {
      const spike = isNum(inputs.loadRatio) && inputs.loadRatio > 1.3;
      const hard = inputs.hardDaysAgo === 1 ? 'hard session yesterday' : inputs.hardDaysAgo === 2 ? 'hard session 2 days ago' : null;
      const parts = [];
      if (spike) parts.push(`training load ${inputs.loadRatio}x your 4-week average`);
      if (hard) parts.push(hard);
      return parts.join(' + ') || 'training load';
    }
    case 'bodyBattery':
      return `low Body Battery (${inputs.bodyBattery})`;
    default:
      return key;
  }
}

function computeReadiness(data, date, config = {}) {
  const cfg = { ...DEFAULT_CONFIG, ...config, weights: { ...DEFAULT_CONFIG.weights, ...(config.weights || {}) } };
  const days = data.days || [];
  const byDate = new Map(days.map((d) => [d.date, d]));
  const today = byDate.get(date) || { date };
  const components = {};
  const inputs = {};
  const caps = [];
  const missing = ['hrvLastNight', 'restingHr', 'sleepScore'].filter((f) => !isNum(today[f]));

  const hrvHist = history(days, date, 'hrvLastNight', cfg.baselineDays);
  if (isNum(today.hrvLastNight) && hrvHist.length >= cfg.minHistoryDays) {
    const logs = hrvHist.map(Math.log);
    const m = mean(logs);
    const s = Math.max(sd(logs), 0.05);
    let sub = clamp(70 + (20 * (Math.log(today.hrvLastNight) - m)) / s);
    if (isNum(today.hrvWeeklyAvg) && isNum(today.hrvBalancedLow) && today.hrvWeeklyAvg < today.hrvBalancedLow) {
      sub = clamp(sub - 15);
    }
    components.hrv = Math.round(sub);
    inputs.hrv = today.hrvLastNight;
    inputs.hrvBaseline = Math.round(Math.exp(m));
  }
  if (['LOW', 'POOR'].includes(today.hrvStatus)) caps.push(`HRV status ${today.hrvStatus.toLowerCase()}`);

  const rhrHist = history(days, date, 'restingHr', cfg.baselineDays);
  const rhrBase = rhrHist.length ? mean(rhrHist) : null;
  if (isNum(today.restingHr) && rhrHist.length >= cfg.minHistoryDays) {
    const s = Math.max(sd(rhrHist), 1.5);
    components.rhr = Math.round(clamp(70 + (20 * (rhrBase - today.restingHr)) / s));
    inputs.rhr = today.restingHr;
    inputs.rhrBaseline = round(rhrBase, 1);
    if (today.restingHr >= rhrBase + 7) caps.push('resting HR well above normal');
  }

  const nights = [0, 1, 2].map((k) => byDate.get(addDays(date, -k))).filter((d) => d && isNum(d.sleepSeconds));
  if (isNum(today.sleepScore) || nights.length) {
    const durationPart = nights.length
      ? clamp((mean(nights.map((n) => n.sleepSeconds / 3600)) / cfg.sleepTargetHours) * 100)
      : null;
    let quality;
    if (isNum(today.sleepScore) && durationPart !== null) quality = 0.6 * today.sleepScore + 0.4 * durationPart;
    else quality = isNum(today.sleepScore) ? today.sleepScore : durationPart;
    // A decent night (quality ~80) maps to an average day (70); great nights score above it.
    components.sleep = Math.round(clamp(70 + (quality - 80) * 1.5));
    inputs.sleepScore = isNum(today.sleepScore) ? today.sleepScore : null;
    inputs.sleepHours = isNum(today.sleepSeconds) ? round(today.sleepSeconds / 3600, 2) : null;
  }

  const load = loadSummary(data.activities || [], date, {
    maxHr: cfg.maxHr,
    restHr: rhrBase ?? cfg.restHrFallback,
    coverageStart: earliestDate(data),
  });
  const penalty = load.hardDaysAgo === 1 ? 20 : load.hardDaysAgo === 2 ? 10 : 0;
  components.load = Math.round(clamp((load.ratio === null ? 70 : ratioScore(load.ratio)) - penalty));
  inputs.loadRatio = load.ratio === null ? null : round(load.ratio, 2);
  inputs.hardDaysAgo = load.hardDaysAgo;

  if (isNum(today.bodyBatteryWake)) {
    components.bodyBattery = Math.round(clamp(today.bodyBatteryWake - 5));
    inputs.bodyBattery = today.bodyBatteryWake;
  }

  const base = { date, components, inputs, missing, caps };
  const keys = Object.keys(components);
  const ownAvailable = components.hrv !== undefined || components.rhr !== undefined;
  let estimateScore = null;
  let converged = false;
  if (ownAvailable) {
    const weightSum = keys.reduce((s, k) => s + cfg.weights[k], 0);
    estimateScore = keys.reduce((s, k) => s + components[k] * cfg.weights[k], 0) / weightSum;
    if (caps.length) estimateScore = Math.min(estimateScore, 30);
    // When all three recovery signals are down together, a normal training load shouldn't
    // average them back up to Moderate: load says what you did, not how you've recovered.
    if (['hrv', 'rhr', 'sleep'].every((k) => components[k] !== undefined && components[k] < 50)) {
      estimateScore = Math.min(estimateScore, 49);
      if (!caps.length) converged = true;
    }
    estimateScore = Math.round(estimateScore);
  }

  // The watch's own readiness score wins when it has one; ours stays as the explanation
  // and as a comparison point for tuning.
  const device = cfg.useDeviceReadiness === false ? null : today.deviceReadiness;
  const useDevice = Boolean(device && isNum(device.score));

  if (!useDevice && !ownAvailable) {
    const status = hrvHist.length < cfg.minHistoryDays && rhrHist.length < cfg.minHistoryDays ? 'calibrating' : 'no-sync';
    return { ...base, status, score: null, band: null, source: null, estimateScore, limiters: [], suggestion: null, message: statusMessage(status) };
  }

  const score = useDevice ? Math.round(clamp(device.score)) : estimateScore;
  const band = bandFor(score);
  const source = useDevice ? device.source || 'device' : 'Headroom estimate';
  const limiters = [
    ...caps,
    ...(converged && !useDevice ? ['HRV, resting HR and sleep all below your normal'] : []),
    ...keys
      .filter((k) => components[k] < 60)
      .sort((a, b) => components[a] - components[b])
      .slice(0, 2)
      .map((k) => limiterText(k, inputs)),
  ];
  const suggestion = SUGGESTIONS[band];
  const label = useDevice ? ` (${source})` : '';
  const message = `Readiness ${score} · ${band}${label}. ${suggestion}${limiters.length ? ` ${useDevice ? 'Worth knowing' : 'Lowering the score'}: ${limiters.join('; ')}.` : ''}`;
  return { ...base, status: 'ok', score, band, source, estimateScore, limiters, suggestion, message };
}

function statusMessage(status) {
  if (status === 'calibrating') return 'Readiness is calibrating: it needs about 14 days of HRV and resting HR history.';
  return "Today's overnight data hasn't synced yet. Open Garmin Connect on your phone to sync, then try again.";
}

module.exports = { DEFAULT_CONFIG, computeReadiness, bandFor };
