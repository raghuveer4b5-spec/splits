const test = require('node:test');
const assert = require('node:assert/strict');
const { decodeFit, runSummary } = require('../src/adapters/fit');
const { syntheticRun, fitTime } = require('./fit-helpers');

test('a FIT file decodes, including compressed timestamps and big-endian messages', () => {
  const m = decodeFit(syntheticRun());
  const records = m[20];
  assert.equal(records.length, 751);
  // Record 50 used a compressed timestamp header; it lands one second after record 49.
  assert.equal(records[50][253], records[49][253] + 1);
  assert.equal(m[19][0][9], 250000, 'big-endian lap distance');
});

test('a damaged or non-FIT file is rejected, not half-read', () => {
  const buf = syntheticRun();
  buf[buf.length - 40] ^= 0xff;
  assert.throws(() => decodeFit(buf), /checksum/);
  assert.throws(() => decodeFit(Buffer.from('PK not a fit file at all')), /not a FIT file/);
  assert.throws(() => decodeFit(syntheticRun().subarray(0, 500)), /truncated/);
});

test('the run summary has the session extras, including the undocumented fields', () => {
  const s = runSummary(syntheticRun());
  assert.equal(s.start, '2026-10-31T08:00:00', 'local start time');
  assert.equal(s.distanceKm, 2.5);
  assert.equal(s.pace, '5:00');
  assert.equal(s.cadenceSpm, 164);
  assert.equal(s.vo2max, 50.2);
  assert.deepEqual(s.trainingEffect, { aerobic: 3.2, anaerobic: 0.4 });
  assert.equal(s.rpe, 6);
  assert.equal(s.feel, 'strong');
  assert.equal(s.sweatMl, 300);
  assert.deepEqual(s.bodyBattery, { start: 60, end: 55, change: -5 });
  assert.deepEqual(s.form, { gctMs: 270, voCm: 9.5, vrPct: 8.2, stepM: 1.22 });
  assert.equal(s.hrZones.watchMaxHr, 197);
  assert.deepEqual(s.hrZones.seconds, [0, 60, 690, 0, 0, 0]);
  assert.deepEqual(s.laps[0], { lap: 1, distanceKm: 2.5, timeS: 750, pace: '5:00', avgHr: 150, maxHr: 152, intensity: 'active', trigger: 'session end' });
});

test('splits are cut every km from the records, without the paused minute', () => {
  const { splits } = runSummary(syntheticRun());
  assert.deepEqual(splits.map((x) => [x.km, x.timeS, x.pace]), [[1, 300, '5:00'], [2, 300, '5:00'], [2.5, 150, '5:00']]);
  assert.equal(splits[0].gapPace, '5:00');
  assert.equal(splits[1].powerW, 350);
});

test('the summary never carries the GPS track', () => {
  const text = JSON.stringify(runSummary(syntheticRun()));
  assert.doesNotMatch(text, /500000000|40000000|position|lat|long/i);
});

test('the heart-rate check shows a cadence lock letting go', () => {
  // HR sits on cadence (164) from minute 6 to 9, then climbs to 182 within 18 seconds.
  const locked = runSummary(syntheticRun({ hrAt: (s) => (s < 360 ? 150 : s < 540 ? 164 : s < 558 ? 164 + (s - 540) : 182) }));
  assert.ok(locked.hrCheck.onCadencePct >= 40, `on cadence ${locked.hrCheck.onCadencePct}%`);
  assert.equal(locked.hrCheck.biggestRise60s.bpm, 18);
  assert.equal(locked.hrCheck.biggestRise60s.toHr, 182);
  const steady = runSummary(syntheticRun());
  assert.deepEqual(steady.hrCheck, { onCadencePct: 0, biggestRise60s: { bpm: 0, fromHr: null, toHr: null, atKm: null } });
});

test('fitTime helper matches the FIT epoch', () => {
  assert.equal(fitTime('1989-12-31T00:00:00Z'), 0);
});
