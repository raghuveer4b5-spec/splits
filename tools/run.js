#!/usr/bin/env node
// One run in detail, from its FIT file through Garmin's Personal API: per-km splits, form,
// heart-rate check, VO2max, training effect, RPE and feel. No GPS track in the output.
// Usage: node tools/run.js [activityId | YYYY-MM-DD] [--type running]
// With no argument it takes the latest run up to today. The FIT file is read in memory, never saved.
const { connect, downloadFit, findActivity } = require('../src/adapters/garmin-api');
const { runSummary } = require('../src/adapters/fit');

const args = process.argv.slice(2);
const t = args.indexOf('--type');
const type = t >= 0 ? args[t + 1] : 'running';
const target = args.find((a, n) => !a.startsWith('--') && !(t >= 0 && n === t + 1));

async function main() {
  const api = await connect();
  let id = target && /^\d+$/.test(target) ? Number(target) : null;
  let name = null;
  if (!id) {
    const a = await findActivity(api, { date: target, type });
    if (!a) return { status: 'none', message: `No ${type} activity in the 30 days up to ${target || 'today'}.` };
    id = a.activityId;
    name = a.activityName || null;
  }
  return { status: 'ok', activityId: id, name, ...runSummary(await downloadFit(api, id)) };
}

main()
  .then((r) => console.log(JSON.stringify(r)))
  .catch((e) => console.log(JSON.stringify({ status: 'failed', message: e.message === 'no key' ? 'No Garmin API key at ~/.headroom/garmin.key.' : e.message })));
