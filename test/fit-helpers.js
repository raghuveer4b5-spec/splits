// Builds small synthetic FIT files and zips for tests, so no real activity file is ever committed.
const zlib = require('zlib');
const { crc16, FIT_EPOCH } = require('../src/adapters/fit');

const WIDTH = { 0: 1, 1: 1, 2: 1, 3: 2, 4: 2, 5: 4, 6: 4, 0x84: 2, 0x83: 2, 0x85: 4, 0x86: 4 };
const WRITE = { 1: 'Int8', 3: 'Int16', 5: 'Int32', 0x83: 'Int16', 0x85: 'Int32' };

// messages: [{ num, fields: { fieldNum: [baseType, value | value[]] }, big, compressedTs }]
// baseType is the FIT base type byte (0x02 uint8, 0x84 uint16, 0x86 uint32, 0x85 sint32, 0x01 sint8).
function encodeFit(messages) {
  const chunks = [];
  let lastShape = null;
  for (const m of messages) {
    const entries = Object.entries(m.fields).map(([n, [base, value]]) => {
      const values = Array.isArray(value) ? value : [value];
      return { n: Number(n), base, values, size: WIDTH[base] * values.length };
    });
    const local = m.compressedTs !== undefined ? 1 : 0;
    const shape = JSON.stringify([m.num, m.big, local, entries.map((e) => [e.n, e.base, e.size])]);
    if (shape !== lastShape) {
      const def = Buffer.alloc(6 + entries.length * 3);
      def[0] = 0x40 | local;
      def[2] = m.big ? 1 : 0;
      if (m.big) def.writeUInt16BE(m.num, 3); else def.writeUInt16LE(m.num, 3);
      def[5] = entries.length;
      entries.forEach((e, i) => { def[6 + i * 3] = e.n; def[7 + i * 3] = e.size; def[8 + i * 3] = e.base; });
      chunks.push(def);
      lastShape = shape;
    }
    const data = Buffer.alloc(1 + entries.reduce((s, e) => s + e.size, 0));
    data[0] = m.compressedTs !== undefined ? 0x80 | (local << 5) | (m.compressedTs & 0x1f) : local;
    let p = 1;
    for (const e of entries) {
      for (const v of e.values) {
        const w = WIDTH[e.base];
        const kind = WRITE[e.base] || (w === 1 ? 'UInt8' : w === 2 ? 'UInt16' : 'UInt32');
        const fn = `write${kind}${w > 1 ? (m.big ? 'BE' : 'LE') : ''}`;
        data[fn](v, p);
        p += w;
      }
    }
    chunks.push(data);
  }
  const body = Buffer.concat(chunks);
  const header = Buffer.alloc(14);
  header[0] = 14;
  header[1] = 0x20;
  header.writeUInt16LE(2100, 2);
  header.writeUInt32LE(body.length, 4);
  header.write('.FIT', 8, 'latin1');
  header.writeUInt16LE(crc16(header, 0, 12), 12);
  const file = Buffer.concat([header, body, Buffer.alloc(2)]);
  file.writeUInt16LE(crc16(file, 0, file.length - 2), file.length - 2);
  return file;
}

// A one-file zip, deflated, the way Garmin's download endpoint sends activities.
function zipOne(name, content) {
  const data = zlib.deflateRawSync(content);
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = local.length + nameBuf.length + data.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, data, central, nameBuf, eocd]);
}

const fitTime = (iso) => Math.round(Date.parse(iso) / 1000) - FIT_EPOCH;

// A synthetic 2.5 km run at 5:00/km starting 07:00 UTC (08:00 local, UTC+1), with a 60-second
// pause in the second km. Options shape the heart rate to test the cadence-lock check.
function syntheticRun({ hrAt = () => 150 } = {}) {
  const t0 = fitTime('2026-10-31T07:00:00Z');
  const speed = 1000 / 300;
  const msgs = [
    { num: 0, fields: { 0: [0x00, 4], 4: [0x86, t0] } },
    { num: 21, fields: { 253: [0x86, t0], 0: [0x00, 0], 1: [0x00, 0] } },
  ];
  let moving = 0;
  for (let t = t0; moving <= 750; t++) {
    if (t - t0 === 450) {
      msgs.push({ num: 21, fields: { 253: [0x86, t], 0: [0x00, 0], 1: [0x00, 4] } });
      msgs.push({ num: 21, fields: { 253: [0x86, t + 60], 0: [0x00, 0], 1: [0x00, 0] } });
      t += 60;
    }
    const fields = {
      0: [0x85, 500000000], 1: [0x85, 40000000],
      3: [0x02, hrAt(moving)], 4: [0x02, 82], 5: [0x86, Math.round(moving * speed * 100)],
      7: [0x84, 350], 13: [0x01, 15], 39: [0x84, 950], 41: [0x84, 2700], 73: [0x86, Math.round(speed * 1000)],
      83: [0x84, 820], 85: [0x84, 12200], 140: [0x86, Math.round(speed * 1000)], 143: [0x02, 60 - Math.floor(moving / 150)],
    };
    // Every 100th record uses a compressed timestamp header instead of a full timestamp.
    if (moving % 100 === 50) msgs.push({ num: 20, fields, compressedTs: t & 0x1f });
    else msgs.push({ num: 20, fields: { 253: [0x86, t], ...fields } });
    moving++;
  }
  const end = t0 + moving + 60;
  msgs.push(
    { num: 19, big: true, fields: { 253: [0x86, end], 2: [0x86, t0], 8: [0x86, 750000], 9: [0x86, 250000], 15: [0x02, 150], 16: [0x02, 152], 23: [0x00, 0], 24: [0x00, 7], 110: [0x86, 3333] } },
    { num: 216, fields: { 253: [0x86, end], 0: [0x84, 18], 1: [0x84, 0], 2: [0x86, [0, 60000, 690000, 0, 0, 0]], 6: [0x02, [99, 118, 138, 158, 177, 199]], 11: [0x02, 197], 12: [0x02, 55] } },
    { num: 140, fields: { 253: [0x86, end], 7: [0x86, Math.round((50.2 * 65536) / 3.5)] } },
    {
      num: 18,
      fields: {
        253: [0x86, end], 2: [0x86, t0], 5: [0x00, 1], 7: [0x86, 810000], 8: [0x86, 750000], 9: [0x86, 250000],
        16: [0x02, 150], 17: [0x02, 152], 18: [0x02, 82], 20: [0x84, 350], 24: [0x02, 32], 137: [0x02, 4],
        89: [0x84, 950], 91: [0x84, 2700], 132: [0x84, 820], 134: [0x84, 12200], 124: [0x86, 3333], 211: [0x86, 3333],
        178: [0x84, 300], 192: [0x02, 75], 193: [0x02, 60],
      },
    },
    { num: 34, fields: { 253: [0x86, end], 5: [0x86, end + 3600] } },
  );
  return encodeFit(msgs);
}

module.exports = { encodeFit, zipOne, syntheticRun, fitTime };
