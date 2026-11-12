#!/usr/bin/env node
/* =====================================================================
   update-averages.cjs

   Reads the polls tab of the Google Sheet (set in engine/eestimate.config.json),
   runs the Eestimate engine and writes data/averages.json, which the pages read.

     node engine/update-averages.cjs               # normal run
     node engine/update-averages.cjs --dry-run     # compute and print, write nothing
     node engine/update-averages.cjs --gviz-file saved.json   # use a saved sheet response (testing)

   Needs Node 18+ (built-in fetch). No packages to install.
   Settings live in engine/eestimate.config.json.
   ===================================================================== */
'use strict';
const fs = require('fs');
const path = require('path');
const Engine = require('./eestimate-engine.cjs');

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def; };
const CONFIG_FILE = opt('--config', path.join(__dirname, 'eestimate.config.json'));
const FROZEN_FILE = opt('--frozen', path.join(__dirname, 'frozen-house-effects.json'));
const OUT_FILE = opt('--out', path.join(__dirname, '..', 'data', 'averages.json'));
const GVIZ_FILE = opt('--gviz-file', null);
const DRY = args.includes('--dry-run');

/* ---------- reading the sheet ---------- */

const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const num = v => {
  if (v === null || v === undefined || v === '') return null;
  const x = Number(String(v).trim().replace(',', '.').replace(/%\s*$/, ''));
  return Number.isFinite(x) ? x : null;
};
// cells hold fractions (0.302); a value above 1.5 is taken as already in percent
const pct = v => {
  if (v === null || v === undefined || v === '') return null;
  const hasSign = /%\s*$/.test(String(v).trim());
  const x = num(v);
  return x === null ? null : (!hasSign && Math.abs(x) <= 1.5) ? Math.round(x * 1e8) / 1e6 : x;
};
function toISODate(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return new Date(Date.UTC(1899, 11, 30) + v * 86400000).toISOString().slice(0, 10);
  const s = String(v).trim();
  const g = s.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/);                  // gviz: month is 0-based
  if (g) return new Date(Date.UTC(+g[1], +g[2], +g[3])).toISOString().slice(0, 10);
  const dmy = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{2,4})$/);
  if (dmy) {
    const mon = MONTH_ABBR[dmy[2].slice(0, 3).toLowerCase()];
    let year = +dmy[3]; if (dmy[3].length <= 2) year = year < 30 ? 2000 + year : 1900 + year;
    if (mon !== undefined) return new Date(Date.UTC(year, mon, +dmy[1])).toISOString().slice(0, 10);
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
}
function parseGviz(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('The sheet did not answer with data. Is it still shared as "anyone with the link can view"?');
  const g = JSON.parse(text.slice(a, b + 1));
  if (g.status === 'error') throw new Error('Google Sheets error: ' + JSON.stringify(g.errors));
  return g;
}
async function fetchGviz(sheet) {
  const id = ((String(sheet.url).match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/) || [])[1]) || '';
  if (!id) throw new Error('No spreadsheet id in sheet.url of the config.');
  const url = 'https://docs.google.com/spreadsheets/d/' + id + '/gviz/tq?tqx=out:json&headers=1&range=' +
    encodeURIComponent(sheet.pollsTab + '!' + (sheet.range || 'A:Z'));
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 30000);
  try {
    const r = await fetch(url, { cache: 'no-store', signal: ctl.signal });
    if (!r.ok) throw new Error('Google Sheets answered HTTP ' + r.status + ' for tab "' + sheet.pollsTab + '".');
    return await r.text();
  } finally { clearTimeout(timer); }
}
function pollsFromGviz(g, cfg) {
  const cols = (g.table && g.table.cols) || [], rows = (g.table && g.table.rows) || [];
  const headers = cols.map((c, i) => String(c.label || c.id || '').trim() || ('Column ' + (i + 1)));
  const di = headers.findIndex(h => h.toLowerCase() === 'date');
  const pi = headers.findIndex(h => h.toLowerCase() === 'pollster');
  if (di < 0 || pi < 0) throw new Error('The "' + cfg.sheet.pollsTab + '" tab needs a "date" and a "Pollster" column in row 1.');
  const partyCols = headers.map((h, i) => i).filter(i => i !== di && i !== pi);
  const extra = partyCols.map(i => headers[i]).filter(h => cfg.parties.indexOf(h) < 0);
  if (extra.length) console.warn('! Columns in the polls tab that are not in "parties" of the config (ignored): ' + extra.join(', '));
  const polls = [], seen = new Set();
  for (const row of rows) {
    const c = row.c || [];
    const d = toISODate((c[di] || {}).v !== undefined ? c[di].v : (c[di] || {}).f);
    const pollster = String(((c[pi] || {}).v !== undefined ? c[pi].v : (c[pi] || {}).f) || '').trim();
    if (!d || !pollster) continue;
    const values = {};
    partyCols.forEach(i => { const x = c[i] || {}; values[headers[i]] = pct(x.v !== undefined ? x.v : x.f); });
    const key = d + '|' + pollster;
    if (seen.has(key)) console.warn('! Duplicate row in the polls tab: ' + d + ' ' + pollster + ' (both are used)');
    seen.add(key);
    polls.push({ date: d, pollster, values });
  }
  return polls;
}

/* ---------- main ---------- */

async function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const frozenFile = fs.existsSync(FROZEN_FILE) ? JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8')) : { years: {} };
  const frozen = frozenFile.years || {};

  const text = GVIZ_FILE ? fs.readFileSync(GVIZ_FILE, 'utf8') : await fetchGviz(cfg.sheet);
  const polls = pollsFromGviz(parseGviz(text), cfg);
  if (!polls.length) throw new Error('No poll rows found in the polls tab.');

  const options = {};
  ['parties', 'strength', 'aliases', 'governments', 'partyStart', 'cellRule', 'startDate', 'election', 'minPollsForBias']
    .forEach(k => { if (cfg[k] !== undefined) options[k] = cfg[k]; });
  options.frozen = frozen;
  const res = Engine.run(polls, options);

  if (res.unknownPollsters.length) {
    throw new Error('The polls tab has pollster(s) with no weight: ' + res.unknownPollsters.join(', ') +
      '. Add them to "strength" (and "aliases" if spelled differently) in engine/eestimate.config.json.');
  }

  // a polling year that has finished and is not pinned yet gets pinned now
  const newlyFrozen = [];
  for (const p of res.periods.slice(0, -1)) {
    if (!frozen[p.key]) { frozen[p.key] = res.rawCells[p.key]; newlyFrozen.push(p.key); }
  }

  const out = Engine.buildOutput(res);
  const previous = fs.existsSync(OUT_FILE) ? JSON.parse(fs.readFileSync(OUT_FILE, 'utf8')) : null;
  const strip = o => JSON.stringify(Object.assign({}, o, { meta: Object.assign({}, o.meta, { generatedAt: null }) }));
  const unchanged = previous && strip(previous) === strip(out);
  out.meta.generatedAt = unchanged ? previous.meta.generatedAt : new Date().toISOString();

  // ----- report
  const counts = {}; polls.forEach(p => { counts[p.pollster] = (counts[p.pollster] || 0) + 1; });
  console.log('Polls read: ' + polls.length + '  (' + Object.keys(counts).map(k => k + ' ' + counts[k]).join(', ') + ')');
  console.log('Series: ' + out.meta.firstDate + ' to ' + out.meta.lastPollDate + ' (' + out.dates.length + ' days)');
  if (previous) console.log('Since last file: ' + (polls.length - previous.polls.length) + ' new poll(s), last poll ' + previous.meta.lastPollDate + ' -> ' + out.meta.lastPollDate);
  const shown = Engine.displaySeries(res.finalAvg, res.parties);
  console.log('Latest, as index.html will show it (LOESS):');
  console.log('  ' + res.parties.map((p, j) => [p, shown[p].at(-1)]).filter(x => x[1] !== null && x[1] > 0.0005)
    .sort((a, b) => b[1] - a[1]).map(x => x[0] + ' ' + (x[1] * 100).toFixed(1)).join(' | '));
  if (newlyFrozen.length) console.log('Pinned finished polling year(s) in frozen-house-effects.json: ' + newlyFrozen.join(', '));

  if (DRY) { console.log('--dry-run: nothing written.'); return; }
  if (unchanged) { console.log('No change in the data; ' + path.relative(process.cwd(), OUT_FILE) + ' left as it was.'); }
  else {
    fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
    fs.writeFileSync(OUT_FILE, JSON.stringify(out));
    console.log('Wrote ' + path.relative(process.cwd(), OUT_FILE) + ' (' + (fs.statSync(OUT_FILE).size / 1024).toFixed(0) + ' KB)');
  }
  if (newlyFrozen.length) fs.writeFileSync(FROZEN_FILE, JSON.stringify(Object.assign({}, frozenFile, { years: frozen }), null, 1));
}

main().catch(e => { console.error('\nERROR: ' + e.message); process.exit(1); });
