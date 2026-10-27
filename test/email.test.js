const test = require('node:test');
const assert = require('node:assert/strict');
const { renderEmail } = require('../src/email/render');

const CONFIG = {
  maxHr: 196,
  plan: { goal: '5k', runsPerWeek: 3, longRunDay: 'sat', liftDays: ['mon', 'wed', 'fri'], priority: 'balanced', startDate: '2026-10-19', baseWeeklyKm: 9, baseLongKm: 10 },
};

const RESULT = {
  date: '2026-10-24',
  status: 'ok',
  score: 44,
  band: 'Low',
  source: 'Headroom estimate',
  estimateScore: 44,
  suggestion: 'Keep it easy and short, or cross-train.',
  limiters: ['short or poor sleep (5h10, score 58)'],
  components: { hrv: 52, rhr: 60, sleep: 31, load: 70, bodyBattery: 50 },
  inputs: { hrv: 55, hrvBaseline: 63, rhr: 55, rhrBaseline: 54, sleepScore: 58, sleepHours: 5.17, loadRatio: 1.1, hardDaysAgo: null, bodyBattery: 55 },
};

test('subject carries the score, band and adjusted workout', () => {
  const { subject } = renderEmail(RESULT, CONFIG);
  assert.equal(subject, 'Take it easy: Easy 4 km (was long run) · Readiness 44');
});

test('HTML is email-safe and shows the workout, the reasons and the week', () => {
  const { html } = renderEmail(RESULT, CONFIG);
  assert.doesNotMatch(html, /<script|<img|<link|class="/i);
  assert.match(html, /TODAY'S WORKOUT/);
  assert.match(html, /instead of the planned long run/);
  assert.match(html, /Planned: Long easy run 7 km/);
  assert.match(html, /WHAT SHAPED THE SCORE/);
  assert.match(html, /5h10 · score 58/);
  assert.match(html, /THIS WEEK/);
  assert.doesNotMatch(html, /<div style="[^"]*height:8px/, 'bars must not be empty divs (Gmail drops them)');
  assert.match(html, /bgcolor="#D85A30"/, "today's highlight uses a bgcolor attribute");
  assert.ok(html.length < 12000, `html ${html.length} bytes`);
});

test('user text is escaped', () => {
  const { html } = renderEmail({ ...RESULT, limiters: ['<b>x</b>'] }, CONFIG);
  assert.match(html, /&lt;b&gt;x&lt;\/b&gt;/);
});

test('a failed check still sends a short, clear email', () => {
  const r = renderEmail({ date: '2026-10-24', status: 'no-sync', message: "Today's overnight data hasn't synced yet." }, CONFIG);
  assert.equal(r.subject, 'No check today: sync your watch');
  assert.match(r.text, /hasn't synced/);
});

test('each band gets its own call to action, and the preview says it is from Headroom', () => {
  const at = (band, score) => renderEmail({ ...RESULT, band, score }, CONFIG).subject;
  assert.match(at('High', 82), /^Go for it: .* · Readiness 82$/);
  assert.match(at('Moderate', 62), /^Steady day: .* · Readiness 62$/);
  assert.equal(at('Poor', 18), 'Rest day: recovery comes first · Readiness 18');
  const strengthDay = renderEmail({ ...RESULT, date: '2026-10-21', band: 'Moderate', score: 62 }, CONFIG).subject;
  assert.equal(strengthDay, 'Steady day: strength day · Readiness 62');
  assert.match(renderEmail(RESULT, CONFIG).html, /Headroom morning check\. Lowering the score: short or poor sleep/);
  assert.equal(renderEmail({ date: '2026-10-24', status: 'auth-expired', message: 'x' }, CONFIG).subject, 'No check today: sign in to Garmin Connect');
});

test('without a plan the email still works', () => {
  const r = renderEmail(RESULT, { maxHr: 196 });
  assert.equal(r.subject, 'Take it easy · Readiness 44');
  assert.doesNotMatch(r.html, /THIS WEEK/);
});

test('the headline follows the plan, not just the score: no intervals on a strength or easy day', () => {
  const at = (date, band, score) => renderEmail({ ...RESULT, date, band, score, limiters: [], suggestion: 'Good day for intervals or a time trial.' }, CONFIG);
  const strength = at('2026-10-23', 'High', 81);
  assert.equal(strength.subject, 'Go for it: strength day · Readiness 81');
  assert.doesNotMatch(strength.html, /intervals/i);
  assert.match(strength.html, /good day to push in the gym/);
  assert.doesNotMatch(at('2026-10-22', 'High', 81).text, /intervals or a time trial/, 'easy-run day stays easy');
  assert.match(renderEmail({ ...RESULT, limiters: [], suggestion: 'Good day for intervals or a time trial.', band: 'High', score: 81 }, { maxHr: 196 }).text, /intervals/, 'without a plan the score advice stands');
});

test('the week strip shows the rest-day swap the workout offers', () => {
  const low = renderEmail({ ...RESULT, date: '2026-10-24', band: 'Low', score: 49 }, CONFIG);
  assert.match(low.text, /or move the long run to tomorrow/);
  assert.match(low.html, />or swap</);
  assert.match(low.html, />or Long</);
  assert.doesNotMatch(renderEmail({ ...RESULT, date: '2026-10-24', band: 'High', score: 80 }, CONFIG).html, /or swap/);
});
