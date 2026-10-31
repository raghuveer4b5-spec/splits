// A small FIT decoder (Garmin's activity file format) and a run summary built from it.
// Decodes only what Headroom uses; field numbers, scales and offsets follow Garmin's FIT profile.
// The summary leaves out GPS positions on purpose: it gets logged and shown, the track doesn't.

const FIT_EPOCH = 631065600; // 1989-12-31T00:00:00Z, in Unix seconds

const CRC_TABLE = [0x0000, 0xcc01, 0xd801, 0x1400, 0xf001, 0x3c00, 0x2800, 0xe401, 0xa001, 0x6c00, 0x7800, 0xb401, 0x5000, 0x9c01, 0x8801, 0x4400];

function crc16(buf, start = 0, end = buf.length) {
  let crc = 0;
  for (let i = start; i < end; i++) {
    for (const nibble of [buf[i] & 0xf, buf[i] >> 4]) {
      const tmp = CRC_TABLE[crc & 0xf];
      crc = ((crc >> 4) & 0x0fff) ^ tmp ^ CRC_TABLE[nibble];
    }
  }
  return crc;
}

// Base type number (low 5 bits) -> [size, reader name, invalid value].
const BASE_TYPES = {
  0: [1, 'UInt8', 0xff], 1: [1, 'Int8', 0x7f], 2: [1, 'UInt8', 0xff], 3: [2, 'Int16', 0x7fff],
  4: [2, 'UInt16', 0xffff], 5: [4, 'Int32', 0x7fffffff], 6: [4, 'UInt32', 0xffffffff], 7: [1, 'string', null],
  8: [4, 'Float', null], 9: [8, 'Double', null], 10: [1, 'UInt8', 0], 11: [2, 'UInt16', 0],
  12: [4, 'UInt32', 0], 13: [1, 'UInt8', 0xff], 14: [8, 'BigInt64', null], 15: [8, 'BigUInt64', null], 16: [8, 'BigUInt64', null],
};

function readField(buf, p, size, base, big) {
  const [width, reader, invalid] = BASE_TYPES[base] || [1, 'UInt8', 0xff];
  if (reader === 'string') {
    const raw = buf.subarray(p, p + size);
    const nul = raw.indexOf(0);
    const s = raw.toString('utf8', 0, nul < 0 ? raw.length : nul);
    return s || undefined;
  }
  const one = (q) => {
    const name = `read${reader}${width > 1 ? (big ? 'BE' : 'LE') : ''}`;
    let v = buf[name](q);
    if (typeof v === 'bigint') v = Number(v);
    if (invalid !== null && v === invalid) return null;
    if (Number.isNaN(v)) return null;
    return v;
  };
  if (size === width) return one(p) ?? undefined;
  const values = [];
  for (let q = p; q + width <= p + size; q += width) values.push(one(q));
  return values.some((v) => v !== null) ? values : undefined;
}

// Returns { [globalMessageNumber]: [ { [fieldNumber]: rawValue } ] }. Raw values are unscaled.
function decodeFit(buf) {
  if (buf.length < 14 || buf.toString('latin1', 8, 12) !== '.FIT') throw new Error('not a FIT file');
  const headerSize = buf[0];
  const end = headerSize + buf.readUInt32LE(4);
  if (end + 2 > buf.length) throw new Error('FIT file is truncated');
  if (crc16(buf, 0, end) !== buf.readUInt16LE(end)) throw new Error('FIT file failed its checksum');

  const defs = {};
  const messages = {};
  let last = 0;
  let p = headerSize;

  const readData = (local, ts) => {
    const def = defs[local];
    if (!def) throw new Error(`FIT data before its definition (local ${local})`);
    const msg = {};
    for (const f of def.fields) {
      const v = readField(buf, p, f.size, f.base, def.big);
      if (v !== undefined) msg[f.num] = v;
      p += f.size;
    }
    p += def.devSize;
    if (ts !== null) msg[253] = ts;
    if (typeof msg[253] === 'number') last = msg[253];
    (messages[def.num] = messages[def.num] || []).push(msg);
  };

  while (p < end) {
    const h = buf[p++];
    if (h & 0x80) {
      // Compressed timestamp header: a 5-bit offset from the last full timestamp.
      const offset = h & 0x1f;
      let ts = last - (last & 0x1f) + offset;
      if (offset < (last & 0x1f)) ts += 0x20;
      readData((h >> 5) & 0x3, ts);
    } else if (h & 0x40) {
      const big = buf[p + 1] === 1;
      const num = big ? buf.readUInt16BE(p + 2) : buf.readUInt16LE(p + 2);
      const count = buf[p + 4];
      p += 5;
      const fields = [];
      for (let i = 0; i < count; i++, p += 3) fields.push({ num: buf[p], size: buf[p + 1], base: buf[p + 2] & 0x1f });
      let devSize = 0;
      if (h & 0x20) {
        const devCount = buf[p++];
        for (let i = 0; i < devCount; i++, p += 3) devSize += buf[p + 1];
      }
      defs[h & 0x0f] = { num, big, fields, devSize };
    } else {
      readData(h & 0x0f, null);
    }
  }
  return messages;
}

// Garmin's 1-10 RPE is stored as 10-100; workout feel is 0, 25, 50, 75 or 100.
const FEEL = { 0: 'very weak', 25: 'weak', 50: 'normal', 75: 'strong', 100: 'very strong' };
const LAP_TRIGGER = ['manual', 'time', 'distance', 'position', 'position', 'position', 'position', 'session end', 'equipment'];
const INTENSITY = ['active', 'rest', 'warmup', 'cooldown', 'recovery', 'interval', 'other'];

const num = (v) => (typeof v === 'number' ? v : null);
const scaled = (v, scale, offset = 0) => (typeof v === 'number' ? v / scale - offset : null);
const r1 = (v) => (v === null ? null : Math.round(v * 10) / 10);
const r2 = (v) => (v === null ? null : Math.round(v * 100) / 100);
const avg = (xs) => {
  const v = xs.filter((x) => typeof x === 'number');
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null;
};

function pace(secPerKm) {
  if (!secPerKm || !Number.isFinite(secPerKm)) return null;
  const s = Math.round(secPerKm);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
const paceFromSpeed = (mps) => (mps ? pace(1000 / mps) : null);

function localIso(ts, offsetS) {
  if (typeof ts !== 'number') return null;
  return new Date((ts + FIT_EPOCH + offsetS) * 1000).toISOString().slice(0, 19);
}

// Timer stop -> start pairs, so paused time isn't counted in a split.
function pauses(events) {
  const out = [];
  let stoppedAt = null;
  for (const e of (events || []).filter((x) => x[0] === 0).sort((a, b) => a[253] - b[253])) {
    if (e[1] === 1 || e[1] === 4) stoppedAt = stoppedAt ?? e[253];
    else if (e[1] === 0 && stoppedAt !== null) { out.push([stoppedAt, e[253]]); stoppedAt = null; }
  }
  return out;
}

function pausedWithin(list, a, b) {
  return list.reduce((s, [x, y]) => s + Math.max(0, Math.min(b, y) - Math.max(a, x)), 0);
}

function record(m) {
  const cadence = num(m[4]);
  return {
    t: m[253],
    distanceM: scaled(m[5], 100),
    hr: num(m[3]),
    spm: cadence === null ? null : (cadence + (scaled(m[53], 128) || 0)) * 2,
    speed: scaled(m[73], 1000),
    gapSpeed: scaled(m[140], 1000), // undocumented: grade-adjusted speed, mm/s
    powerW: num(m[7]),
    gctMs: scaled(m[41], 10),
    voCm: scaled(m[39], 100), // stored in mm x 10
    vrPct: scaled(m[83], 100),
    stepM: scaled(m[85], 10000), // stored in mm x 10
    tempC: num(m[13]),
    bodyBattery: num(m[143]), // undocumented: Body Battery during the activity
  };
}

function bucketStats(rs) {
  const hrs = rs.map((r) => r.hr).filter((x) => x !== null);
  return {
    avgHr: hrs.length ? Math.round(avg(hrs)) : null,
    maxHr: hrs.length ? Math.max(...hrs) : null,
    cadenceSpm: rs.length ? Math.round(avg(rs.map((r) => r.spm))) || null : null,
    gctMs: Math.round(avg(rs.map((r) => r.gctMs))) || null,
    voCm: r1(avg(rs.map((r) => r.voCm))),
    vrPct: r1(avg(rs.map((r) => r.vrPct))),
    stepM: r2(avg(rs.map((r) => r.stepM))),
    powerW: Math.round(avg(rs.map((r) => r.powerW))) || null,
    gapPace: paceFromSpeed(avg(rs.map((r) => r.gapSpeed))),
  };
}

// Per-km splits from the per-second records. Watch laps follow the workout's steps, which may
// not be what was run, so splits are cut by distance instead.
function kmSplits(rs, paused) {
  const out = [];
  let bucket = [];
  let startT = rs.length ? rs[0].t : 0;
  let startD = 0;
  let prev = null;
  for (const r of rs) {
    if (r.distanceM === null) continue;
    const boundary = (out.length + 1) * 1000;
    if (r.distanceM >= boundary && prev) {
      const frac = (boundary - prev.distanceM) / Math.max(r.distanceM - prev.distanceM, 1e-6);
      const endT = prev.t + frac * (r.t - prev.t);
      const timeS = endT - startT - pausedWithin(paused, startT, endT);
      out.push({ km: out.length + 1, timeS: Math.round(timeS), pace: pace(timeS), ...bucketStats(bucket) });
      bucket = [];
      startT = endT;
      startD = boundary;
    }
    bucket.push(r);
    prev = r;
  }
  const restM = prev ? prev.distanceM - startD : 0;
  if (restM >= 100) {
    const timeS = prev.t - startT - pausedWithin(paused, startT, prev.t);
    out.push({ km: r2(prev.distanceM / 1000), timeS: Math.round(timeS), pace: pace((timeS * 1000) / restM), ...bucketStats(bucket) });
  }
  return out;
}

// Signs of a wrist-HR cadence lock: how often HR sits on cadence, and the sharpest rise within a
// minute (a lock that lets go shows as a jump from the 150s to the 170s). The first five minutes
// are skipped, since HR climbs quickly at the start of any run.
function hrCheck(rs) {
  const t0 = rs.length ? rs[0].t : 0;
  const moving = rs.filter((r) => r.t - t0 >= 300 && r.hr !== null && r.spm !== null && (r.speed || 0) > 1.5);
  if (moving.length < 60) return null;
  const onCadence = moving.filter((r) => Math.abs(r.hr - r.spm) <= 2).length;
  let rise = { bpm: 0, fromHr: null, toHr: null, atKm: null };
  for (let i = 0, j = 0; i < moving.length; i++) {
    for (j = Math.max(j, i); j + 1 < moving.length && moving[j + 1].t - moving[i].t <= 60; j++);
    for (let k = i + 1; k <= j; k++) {
      const d = moving[k].hr - moving[i].hr;
      if (d > rise.bpm) rise = { bpm: d, fromHr: moving[i].hr, toHr: moving[k].hr, atKm: r2((moving[k].distanceM || 0) / 1000) };
    }
  }
  return { onCadencePct: Math.round((100 * onCadence) / moving.length), biggestRise60s: rise };
}

function runSummary(buf) {
  const m = decodeFit(buf);
  const session = (m[18] || [])[0] || {};
  const activity = (m[34] || [])[0] || {};
  const offsetS = typeof activity[5] === 'number' && typeof activity[253] === 'number' ? Math.round((activity[5] - activity[253]) / 900) * 900 : 0;
  const rs = (m[20] || []).filter((x) => typeof x[253] === 'number').map(record).sort((a, b) => a.t - b.t);
  const paused = pauses(m[21]);
  const vo2raw = ((m[140] || [])[0] || {})[7]; // undocumented: VO2max x 65536 / 3.5
  const zones = (m[216] || []).find((z) => z[0] === 18) || null;
  const battery = rs.map((r) => r.bodyBattery).filter((x) => x !== null);
  const temps = rs.map((r) => r.tempC).filter((x) => x !== null);
  const avgSpeed = scaled(session[124], 1000);
  const cadence = num(session[18]);

  return {
    start: localIso(session[2], offsetS),
    sport: session[5] === 1 ? 'running' : session[5] ?? null,
    distanceKm: r2(scaled(session[9], 100) / 1000),
    timeS: Math.round(scaled(session[8], 1000) || 0),
    elapsedS: Math.round(scaled(session[7], 1000) || 0),
    pace: paceFromSpeed(avgSpeed),
    gapPace: paceFromSpeed(scaled(session[211], 1000)),
    avgHr: num(session[16]),
    maxHr: num(session[17]),
    cadenceSpm: cadence === null ? null : Math.round((cadence + (scaled(session[92], 128) || 0)) * 2),
    powerW: num(session[20]),
    ascentM: num(session[22]),
    form: {
      gctMs: Math.round(scaled(session[91], 10)) || null,
      voCm: r1(scaled(session[89], 100)),
      vrPct: r1(scaled(session[132], 100)),
      stepM: r2(scaled(session[134], 10000)),
    },
    vo2max: typeof vo2raw === 'number' ? r1((vo2raw * 3.5) / 65536) : null,
    trainingEffect: { aerobic: r1(scaled(session[24], 10)), anaerobic: r1(scaled(session[137], 10)) },
    rpe: typeof session[193] === 'number' ? session[193] / 10 : null,
    feel: FEEL[session[192]] ?? null,
    sweatMl: num(session[178]), // undocumented: estimated sweat loss
    temperatureC: temps.length ? { avg: Math.round(avg(temps)), max: Math.max(...temps) } : null,
    bodyBattery: battery.length ? { start: battery[0], end: battery[battery.length - 1], change: battery[battery.length - 1] - battery[0] } : null,
    hrZones: zones ? {
      seconds: (zones[2] || []).map((s) => Math.round((s || 0) / 1000)),
      highBoundaries: zones[6] || null,
      watchMaxHr: num(zones[11]),
      watchRestingHr: num(zones[12]),
    } : null,
    splits: kmSplits(rs, paused),
    laps: (m[19] || []).map((l, i) => ({
      lap: i + 1,
      distanceKm: r2(scaled(l[9], 100) / 1000),
      timeS: Math.round(scaled(l[8], 1000) || 0),
      pace: paceFromSpeed(scaled(l[110], 1000)),
      avgHr: num(l[15]),
      maxHr: num(l[16]),
      intensity: INTENSITY[l[23]] ?? null,
      trigger: LAP_TRIGGER[l[24]] ?? null,
    })),
    hrCheck: hrCheck(rs),
  };
}

module.exports = { decodeFit, runSummary, crc16, FIT_EPOCH };
