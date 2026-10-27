// Renders the morning update as an email: subject, HTML (email-safe: tables, inline styles,
// no images or scripts) and a plain-text alternative. Pure function of the morning result + config.
const { buildWeek, todaySession, shortLabel, weekdayOf, WEEKDAYS } = require('../core/plan');
const { addDays, round } = require('../core/stats');
const { INK, MUTED, FONT, esc, longDate, card, label, page } = require('./style');

const BAND_COLOR = { High: '#1D9E75', Moderate: '#BA7517', Low: '#D85A30', Poor: '#A32D2D' };

function hours(h) {
  const whole = Math.floor(h);
  return `${whole}h${String(Math.round((h - whole) * 60)).padStart(2, '0')}`;
}

function componentRows(components, inputs) {
  const rows = [];
  if (components.hrv !== undefined) rows.push(['HRV', components.hrv, `${inputs.hrv} ms vs your ${inputs.hrvBaseline} ms normal`]);
  if (components.sleep !== undefined) {
    const parts = [];
    if (inputs.sleepHours) parts.push(hours(inputs.sleepHours));
    if (inputs.sleepScore) parts.push(`score ${inputs.sleepScore}`);
    rows.push(['Sleep', components.sleep, parts.join(' · ') || 'last 3 nights']);
  }
  if (components.load !== undefined) {
    const parts = [inputs.loadRatio ? `${inputs.loadRatio}x your 4-week average` : 'building history'];
    if (inputs.hardDaysAgo) parts.push(`hard session ${inputs.hardDaysAgo === 1 ? 'yesterday' : '2 days ago'}`);
    rows.push(['Training load', components.load, parts.join(', ')]);
  }
  if (components.rhr !== undefined) rows.push(['Resting HR', components.rhr, `${inputs.rhr} bpm vs ${Math.round(inputs.rhrBaseline)} normal`]);
  if (components.bodyBattery !== undefined) rows.push(['Body Battery', components.bodyBattery, `${inputs.bodyBattery} at wake-up`]);
  return rows;
}

const barColor = (v) => (v >= 70 ? '#1D9E75' : v >= 50 ? '#BA7517' : '#D85A30');

// Gmail drops empty divs and CSS-only backgrounds (especially in dark mode), so bars and
// highlights are table cells with bgcolor attributes and a non-breaking space inside.
function bar(value) {
  const pct = Math.max(4, Math.min(100, value));
  const cell = (w, color) => `<td width="${w}%" bgcolor="${color}" style="background:${color};height:8px;font-size:1px;line-height:1px">&nbsp;</td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-radius:4px;overflow:hidden"><tr>${cell(pct, barColor(value))}${pct < 100 ? cell(100 - pct, '#D9DDE3') : ''}</tr></table>`;
}

function weekStrip(plan, date, band, maxHr, swap) {
  const week = buildWeek(plan, date, maxHr);
  const todayWd = weekdayOf(date);
  const todayIndex = WEEKDAYS.indexOf(todayWd);
  const monday = addDays(date, -todayIndex);
  return WEEKDAYS.map((wd, i) => {
    const day = week.days[wd];
    const isToday = wd === todayWd;
    const short = { easy: 'Easy', long: 'Long', intervals: 'Int', tempo: 'Tempo', runwalk: 'Run' };
    let run = day.run ? short[day.run.type] : day.strength ? 'Gym' : 'Rest';
    // Second line: "5.5 km" for regular runs, "4x4 min" for beginner run/walk sessions.
    let detail = day.run ? (day.run.type === 'runwalk' ? day.run.short : `${day.run.km} km`) : '';
    if (isToday && day.run && band === 'Low') {
      if (day.run.type === 'runwalk') detail = day.run.easierShort;
      else {
        run = 'Easy';
        const km = shortLabel(day, band).match(/Easy ([\d.]+)/)?.[1];
        if (km) detail = `${km} km`;
      }
    }
    if (isToday && band === 'Poor') {
      run = 'Rest';
      detail = '';
    }
    // When today's long or hard run can move into tomorrow's rest day, both cells show the choice.
    let note = day.run && day.strength ? '+ gym' : '';
    if (swap && isToday) note = 'or swap';
    if (swap && i === todayIndex + 1) {
      const planned = week.days[todayWd].run;
      detail = `or ${short[planned.type]}`;
      note = `${planned.km} km`;
    }
    return { wd, date: addDays(monday, i), isToday, run, detail, note };
  });
}

// Subjects lead with what to do today, then the session, then the score.
const VERDICT = { High: 'Go for it', Moderate: 'Steady day', Low: 'Take it easy', Poor: 'Rest day' };
const FAILED_SUBJECT = {
  'no-sync': 'No check today: sync your watch',
  'auth-expired': 'No check today: sign in to Garmin Connect',
  unreachable: "No check today: Garmin Connect didn't respond",
  failed: "No check today: Headroom couldn't read Garmin Connect",
  calibrating: 'Headroom is calibrating: a few more nights of data',
};

function dailySubject(result, today) {
  const score = `Readiness ${result.score}`;
  const verdict = VERDICT[result.band] || 'Today';
  if (result.band === 'Poor') return `${verdict}: recovery comes first · ${score}`;
  if (!today) return `${verdict} · ${score}`;
  if (today.short === 'Rest') return `Rest day · ${score}`;
  if (today.short === 'Strength') return `${verdict}: strength day · ${score}`;
  return `${verdict}: ${today.short} · ${score}`;
}

function renderEmail(result, config = {}) {
  const date = result.date;
  const plan = config.plan;
  const maxHr = config.maxHr || 190;

  if (result.status !== 'ok') {
    const subject = FAILED_SUBJECT[result.status] || 'No readiness check today';
    const text = `${result.message}\n\nNothing else to do; tomorrow's check runs as usual.`;
    const html = `<div style="font-family:${FONT};color:${INK};max-width:560px;margin:0 auto;padding:24px">
<p style="margin:0 0 4px;color:${MUTED};font-size:13px">Headroom · ${esc(longDate(date))}</p>
<h1 style="margin:0 0 12px;font-size:20px;font-weight:600">No readiness score today</h1>
<p style="margin:0;font-size:15px;line-height:1.6">${esc(result.message)}</p></div>`;
    return { subject, html, text };
  }

  const color = BAND_COLOR[result.band] || INK;
  const today = plan ? todaySession(plan, date, result.band, maxHr, { limited: (result.limiters || []).length > 0 }) : null;
  const subject = dailySubject(result, today);
  const advice = (today && today.advice) || result.suggestion || '';
  const rows = componentRows(result.components || {}, result.inputs || {});
  const limiters = result.limiters || [];
  const fromDevice = result.source && result.source !== 'Headroom estimate';
  const sourceLine = fromDevice
    ? `${esc(result.source)}${result.estimateScore !== null && result.estimateScore !== undefined ? ` · Headroom estimate ${result.estimateScore}` : ''}`
    : 'Headroom estimate from your Garmin data';
  // The inbox preview line says who it's from, since self-sent mail shows up as "me".
  const preheader = `Headroom morning check. ${limiters.length ? `${fromDevice ? 'Worth knowing' : 'Lowering the score'}: ${limiters[0]}.` : advice}`;

  const hero = card(`<table role="presentation" cellpadding="0" cellspacing="0" width="100%"><tr>
<td width="84" valign="middle"><table role="presentation" cellpadding="0" cellspacing="0"><tr><td width="72" height="72" align="center" valign="middle" bgcolor="${color}" style="width:72px;height:72px;border-radius:36px;background:${color};color:#FFFFFF;font-size:30px;font-weight:700;text-align:center">${result.score}</td></tr></table></td>
<td valign="middle" style="padding-left:12px"><p style="margin:0;font-size:22px;font-weight:700;color:${color}">${esc(result.band)}</p>
<p style="margin:4px 0 0;font-size:12px;color:${MUTED}">${sourceLine}</p></td></tr></table>
<p style="margin:16px 0 0;font-size:16px;line-height:1.55;color:${INK}">${esc(advice)}</p>`);

  let workout = '';
  if (today) {
    const changed = today.changed && today.planned ? `<p style="margin:8px 0 0;font-size:13px;color:${MUTED}">Adjusted for today's readiness. Planned: ${esc(today.planned)}</p>` : '';
    const accessory = today.accessory
      ? `<p style="margin:14px 0 0;font-size:13px;line-height:1.6;color:${INK};background:#F6F7F9;border-radius:8px;padding:10px 12px">${esc(today.accessory)}</p>`
      : '';
    const note = result.yesterday && result.yesterday.note
      ? `<p style="margin:12px 0 0;font-size:13px;line-height:1.55;color:${MUTED}">${esc(result.yesterday.note)}</p>`
      : '';
    workout = card(`${label("TODAY'S WORKOUT")}<p style="margin:0;font-size:17px;line-height:1.5;font-weight:600;color:${INK}">${esc(today.suggestion)}</p>${changed}${accessory}${note}`, `;border-left:4px solid ${color}`);
  }

  const bars = rows
    .map(([name, value, detail]) => `<tr>
<td style="padding:7px 0;font-size:14px;color:${INK};width:110px" valign="top">${name}</td>
<td style="padding:12px 10px 7px" valign="top">${bar(value)}
<p style="margin:6px 0 0;font-size:12px;color:${MUTED}">${esc(detail)}</p></td>
<td style="padding:7px 0;font-size:14px;font-weight:600;color:${INK};width:30px;text-align:right" valign="top">${value}</td></tr>`)
    .join('');
  const why = rows.length
    ? card(`${label('WHAT SHAPED THE SCORE')}<table role="presentation" width="100%" cellpadding="0" cellspacing="0">${bars}</table>
<p style="margin:10px 0 0;font-size:12px;color:${MUTED}">Each scored 0-100 against your own 30-day normal. About 70 is a normal day.</p>${
        limiters.length ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.55;color:${INK}"><strong>${fromDevice ? 'Worth knowing' : 'Lowering the score'}:</strong> ${esc(limiters.join('; '))}</p>` : ''
      }`)
    : '';

  let week = '';
  if (plan) {
    const strip = weekStrip(plan, date, result.band, maxHr, today && today.swap);
    const cells = strip
      .map((d) => {
        const fg = d.isToday ? '#FFFFFF' : INK;
        const sub = d.isToday ? '#FFFFFF' : MUTED;
        const bg = d.isToday ? ` bgcolor="${color}"` : '';
        return `<td width="14%" valign="top" align="center"${bg} style="padding:8px 2px;text-align:center;border-radius:8px;${d.isToday ? `background:${color};` : ''}color:${fg}">
<p style="margin:0;font-size:11px;font-weight:600;color:${sub}">${d.wd.charAt(0).toUpperCase() + d.wd.slice(1)}</p>
<p style="margin:5px 0 0;font-size:12px;font-weight:600;color:${fg}">${esc(d.run)}</p>
<p style="margin:1px 0 0;font-size:11px;color:${sub}">${d.detail ? esc(d.detail) : '&nbsp;'}</p>${d.note ? `<p style="margin:1px 0 0;font-size:10px;color:${sub}">${esc(d.note)}</p>` : ''}</td>`;
      })
      .join('');
    const w = today;
    week = card(`${label(w.beginner ? `THIS WEEK · STAGE ${w.beginner.stage} OF ${w.beginner.of}` : `THIS WEEK · WEEK ${w.week}${w.recoveryWeek ? ' (LIGHTER)' : ''} · ${round(w.weekTargetKm, 1)} KM`)}<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>${cells}</tr></table>`);
  }

  const html = page({
    preheader,
    dateLine: longDate(date),
    body: `${hero}${workout}${why}${week}`,
    footer: 'An estimate for training decisions, not medical advice. To change the time, notifications or your plan, ask Claude to set up Headroom again.',
  });

  const textLines = [
    `Readiness ${result.score} · ${result.band} (${fromDevice ? result.source : 'Headroom estimate'})`,
    advice,
    today ? `\nToday: ${today.suggestion}` : '',
    today && today.accessory ? today.accessory : '',
    today && result.yesterday && result.yesterday.note ? result.yesterday.note : '',
    rows.length ? `\nWhat shaped the score:\n${rows.map(([n, v, d]) => `- ${n}: ${v} (${d})`).join('\n')}` : '',
    limiters.length ? `\n${fromDevice ? 'Worth knowing' : 'Lowering the score'}: ${limiters.join('; ')}` : '',
  ];
  return { subject, html, text: textLines.filter(Boolean).join('\n') };
}

module.exports = { renderEmail };
