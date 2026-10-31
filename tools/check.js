#!/usr/bin/env node
// Morning check (or the setup profile) through Garmin's Personal API, with no browser.
// Usage: node tools/check.js [--date YYYY-MM-DD] [--profile] [config.json]
// Prints the result JSON. The morning check also writes it to ~/.headroom/last.json for tools/email.js.
// Besides the page script's statuses it can return no-key or key-invalid: then use the Chrome path.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { morningCheck, profile } = require('../src/runner');
const { connect, fetchCommon, readKey, KEY_FILE } = require('../src/adapters/garmin-api');

const dir = path.join(os.homedir(), '.headroom');
const args = process.argv.slice(2);
const i = args.indexOf('--date');
const date = i >= 0 ? args[i + 1] : new Date().toLocaleDateString('en-CA');
const configFile = args.find((a, n) => !a.startsWith('--') && !(i >= 0 && n === i + 1)) || path.join(dir, 'config.json');
const config = fs.existsSync(configFile) ? JSON.parse(fs.readFileSync(configFile, 'utf8')) : {};

const KEY_INVALID = "Garmin didn't accept the API key. It may have expired or been deleted: create a new one in Garmin Connect and save it again.";

async function main() {
  const key = readKey();
  if (!key) return { date, status: 'no-key', message: `No Garmin API key at ${KEY_FILE}.` };
  let api;
  try {
    api = await connect({ key });
  } catch (e) {
    if (/HTTP 40[013]$/.test(e.message)) return { date, status: 'key-invalid', message: KEY_INVALID };
    if (/(timed out|network error)$/.test(e.message)) return { date, status: 'unreachable', message: "Garmin's API didn't respond." };
    return { date, status: 'failed', message: `Garmin API: ${e.message}` };
  }
  const fetchData = (range) => fetchCommon(api, range);
  if (args.includes('--profile')) return profile({ fetchData, raw: true });
  const result = await morningCheck({ date, config, fetchData, raw: true });
  if (result.status === 'auth-expired') return { date, status: 'key-invalid', message: KEY_INVALID };
  return result;
}

main()
  .then((result) => {
    if (!args.includes('--profile')) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'last.json'), JSON.stringify(result));
    }
    console.log(JSON.stringify(result));
  })
  .catch((e) => console.log(JSON.stringify({ date, status: 'failed', message: `script error: ${e.message}` })));
