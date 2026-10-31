const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE, connect, fetchCommon, unzipFit, downloadFit } = require('../src/adapters/garmin-api');
const { syntheticRun, zipOne } = require('./fit-helpers');

const TOKEN_PATH = '/personalapitoken-service/personal-api/personal-api-key/token';

// A fake Garmin: routes by path prefix, records requests, answers with canned bodies.
function fakeGarmin(routes, tokenBody = 'header.payload.signature') {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const p = url.replace(BASE, '');
    calls.push({ path: p, init });
    if (p === TOKEN_PATH) {
      if (init.headers.Authorization !== 'ApiKey test-key') return { ok: false, status: 401 };
      return { ok: true, status: 200, text: async () => tokenBody };
    }
    const hit = Object.keys(routes).find((prefix) => p.startsWith(prefix));
    if (!hit) return { ok: false, status: 404 };
    const body = routes[hit];
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify(body),
      arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
    };
  };
  return { fetchImpl, calls };
}

test('the key is swapped for a token, sent as a Bearer header, and a bad key is reported', async () => {
  const g = fakeGarmin({ '/hrv-service': { hrvSummaries: [] } });
  const api = await connect({ key: 'test-key', fetchImpl: g.fetchImpl });
  await api.get('/hrv-service/hrv/daily/2026-10-01/2026-10-28');
  assert.equal(g.calls[0].init.method, 'POST');
  assert.equal(g.calls[1].init.headers.Authorization, 'Bearer header.payload.signature');

  const json = fakeGarmin({ '/hrv-service': {} }, JSON.stringify({ access_token: 'from-json' }));
  await (await connect({ key: 'test-key', fetchImpl: json.fetchImpl })).get('/hrv-service/x');
  assert.equal(json.calls[1].init.headers.Authorization, 'Bearer from-json');

  await assert.rejects(connect({ key: 'wrong', fetchImpl: g.fetchImpl }), /HTTP 401/);
  await assert.rejects(connect({ key: null, fetchImpl: g.fetchImpl }), /no key/);
});

test('Personal API responses map to the common data format', async () => {
  const g = fakeGarmin({
    '/hrv-service/hrv/daily/': { hrvSummaries: [{ calendarDate: '2026-10-31', lastNightAvg: 52, weeklyAvg: 55, status: 'BALANCED', baseline: { balancedLow: 49, balancedUpper: 64 } }] },
    '/usersummary-service/v2/dailysummaries': { data: [{ calendarDate: '2026-10-31', heartRate: { restingValue: 56 } }, { calendarDate: '2026-10-30', heartRate: {} }] },
    '/sleep-service/sleep/dailySleepSummariesByDate': [{ calendarDate: '2026-10-31', sleepTimeSeconds: 26100, sleepEndTimestampGMT: 5400000, sleepScores: { overall: { value: 81 } } }],
    // Wake level is the first reading from 30 minutes before sleep ended.
    '/wellness-service/wellness/bodyBattery/reports/daily': [{ date: '2026-10-31', bodyBatteryValuesArray: [[1000, 40], [3700000, 67], [9000000, 50]] }],
    '/activitylist-service/': [{ startTimeLocal: '2026-10-31 08:00:00', activityType: { typeKey: 'running' }, distance: 6000, duration: 2100, averageHR: 150, maxHR: 160 }],
  });
  const api = await connect({ key: 'test-key', fetchImpl: g.fetchImpl });
  const data = await fetchCommon(api, { startDate: '2026-09-30', endDate: '2026-10-31', sleepFrom: '2026-10-29' });
  const day = data.days.find((d) => d.date === '2026-10-31');
  assert.deepEqual(day, {
    date: '2026-10-31', hrvLastNight: 52, hrvWeeklyAvg: 55, hrvStatus: 'BALANCED', hrvBalancedLow: 49, hrvBalancedHigh: 64,
    restingHr: 56, sleepSeconds: 26100, sleepScore: 81, bodyBatteryWake: 67,
  });
  assert.equal(data.activities[0].distanceM, 6000);
  assert.deepEqual(data.warnings, []);
  assert.ok(g.calls.every((c) => c.path === TOKEN_PATH || c.init.headers.Authorization.startsWith('Bearer ')));
});

test("an endpoint that fails becomes a warning, not a crash", async () => {
  const g = fakeGarmin({ '/hrv-service/hrv/daily/': { hrvSummaries: [] } });
  const api = await connect({ key: 'test-key', fetchImpl: g.fetchImpl });
  const data = await fetchCommon(api, { startDate: '2026-10-25', endDate: '2026-10-31', sleepFrom: '2026-10-29' });
  assert.ok(data.warnings.some((w) => /^sleep: HTTP 404$/.test(w)));
});

test('an activity download is unzipped to its FIT file', async () => {
  const fit = syntheticRun();
  const zip = zipOne('123_ACTIVITY.fit', fit);
  assert.deepEqual(unzipFit(zip), fit);
  assert.throws(() => unzipFit(Buffer.from('not a zip')), /not a zip/);

  const g = fakeGarmin({ '/download-service/files/activity/123': zip });
  const api = await connect({ key: 'test-key', fetchImpl: g.fetchImpl });
  assert.deepEqual(await downloadFit(api, 123), fit);
  assert.equal(g.calls[1].init.headers.Accept, '*/*', 'downloads must not ask for JSON (Garmin answers 406)');
});
