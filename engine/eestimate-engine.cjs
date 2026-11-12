/* =====================================================================
   Eestimate engine — builds the polling average, the pollster comparison,
   the house effects and the government/opposition lines from the individual
   polls alone.

   Pipeline:
     polls -> 30-day weighted average -> leave-one-out average per pollster
           -> each poll against the smoothed leave-one-out average
           -> house effects per pollster, party and polling year
           -> polls adjusted for house effects -> final average
           -> government / opposition lines

   Pure JavaScript, no dependencies; runs in Node and in a browser.

   All percentages inside the engine are in percentage points (31.2),
   shares in the output are fractions (0.312).
   ===================================================================== */
const EestimateEngine = (function () {
  'use strict';

  /* --------------------------------------------------------------
     CONFIG — everything adjustable lives here (and in engine/eestimate.config.json)
     -------------------------------------------------------------- */
  const DEFAULTS = {
    parties: ['Reform', 'EKRE', 'Centre', 'E200', 'SDE', 'Isamaa', 'VL', 'Koos', 'PP', 'Greens', 'ERK', 'Free'],

    // Start of the series = the 2023 election, which acts as a full-strength
    // "poll" on day 0 (weight 1). Values in percent.
    startDate: '2023-03-05',
    election: { Reform: 31.2, EKRE: 16.1, Centre: 15.3, E200: 13.3, SDE: 9.3, Isamaa: 8.2, VL: 2.4, PP: 2.3, Greens: 1.0 },

    // Poll weight per pollster. Names are the ones used in the polls tab.
    strength: { 'Emor': 1, 'Norstat': 0.2, 'Turu-uuringute AS': 0.7 },
    // Alternative spellings -> canonical name
    aliases: { 'Kantar Emor': 'Emor' },

    windowDays: 30,           // weights 30,29,...,1 over the last 30 days

    // Polling years run 5 March -> 4 March (same rule as pollster-bias-yearly.html)
    periodStartMonth: 2, periodStartDay: 5,   // month is 0-based (2 = March)
    firstPeriodYear: 2023,

    // Pollster comparison settings (same as on pollster-bias-yearly.html)
    loessSpan: 0.03,
    dateMatchToleranceDays: 3,
    minPollsForBias: 3,       // below this the page prints "low sample"
    aggregateDecimals: 4,     // leave-one-out averages are rounded to 4 decimals before smoothing

    // Which house-effect cells are carried into the average:
    //   'strict' -> only cells with n >= minPollsForBias; fewer polls = blank = no adjustment.
    //               Matches the page's "AT A GLANCE" table, which prints "low sample" instead of a number.
    //   'all'    -> every cell with at least 1 poll (what the dot-strip panels show)
        cellRule: 'strict',

    // Cabinets. Each entry produces its own 3 lines on the government chart:
    //   government  = parties in the cabinet
    //   opposition  = parliamentary opposition
    //   (the rest, i.e. 1 - government - opposition, is the extra-parliamentary opposition)
    // A cabinet runs from `from` until the day before the next entry's `from` (or an explicit `to`).
    // To switch to new lines: add an entry with a later `from`. To change who counts as what, edit the
    // lists: the whole span is recomputed on the next run.
    // `marker` (optional) draws a labelled vertical line on the charts; `cabinetEt` is the Estonian
    // cabinet name used in Estonian chart labels (defaults to `cabinet`).
    governments: [
      { cabinet: 'Kallas III', from: '2023-04-17',
        government: ['Reform', 'E200', 'SDE'], opposition: ['EKRE', 'Centre', 'Isamaa'],
        marker: { date: '2023-04-17', en: "Kallas' third cabinet", et: 'Kallase III valitsus' } },
      { cabinet: 'Michal I w/ SDE', cabinetEt: 'Michal I koos SDE-ga', from: '2024-07-22',
        government: ['Reform', 'E200', 'SDE'], opposition: ['EKRE', 'Centre', 'Isamaa'],
        marker: { date: '2024-07-23', en: "Michal's cabinet", et: 'Michali valitsus' } },
      { cabinet: 'Michal I', from: '2025-03-10',
        government: ['Reform', 'E200'], opposition: ['EKRE', 'Centre', 'SDE', 'Isamaa'],
        marker: { date: '2025-03-10', en: 'SDE expelled from cabinet', et: 'SDE eemaldati valitsusest' } }
    ],

    // Completed polling years are pinned to their house-effect numbers (1 decimal),
    // so the history never moves when a poll is added:
    //   frozen: { '2023-24': { Norstat:[12 numbers|null], Emor:[...], 'Turu-uuringute AS':[...] }, ... }
    // Any year not listed here is computed live from the polls.
    frozen: {},

    outputDecimals: 4,        // averages in the output are rounded to 4 decimals

    // A party that was not in the 2023 election has no values (blank, not 0) before its first poll;
    // the page's LOESS then ignores those days. By default a column starts on the date of the first
    // poll that reports the party above 0. Override per party to pin a start date
    // (Free starts on 24 Aug 2024, a day before the first poll above 0).
    partyStart: { Free: '2024-08-24' }
  };

  /* --------------------------------------------------------------
     Small helpers
     -------------------------------------------------------------- */
  const DAY = 86400000;
  const isNum = v => typeof v === 'number' && Number.isFinite(v);
  const utc = (y, m, d) => Date.UTC(y, m, d);
  const parseISO = s => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s); return utc(+m[1], +m[2] - 1, +m[3]); };
  const toISO = ms => new Date(ms).toISOString().slice(0, 10);
  // Rounds on the first 15 significant digits, so exact ties (0.25735 -> 0.2574)
  // always round up instead of depending on floating-point noise.
  const roundTo = (v, d) => { const k = Math.pow(10, d); return Math.round(Number((v * k).toPrecision(15))) / k; };
  // identical to fmtSigned() in pollster-bias-yearly.html (one decimal, JS rounding rules)
  const round1 = v => { const r = Math.round(v * 10) / 10; return r === 0 ? 0 : r; };

  function merge(base, over) {
    const out = Object.assign({}, base);
    for (const k in (over || {})) out[k] = over[k];
    return out;
  }

  /* --------------------------------------------------------------
     LOESS — same maths as loessSmooth() in index.html and
     pollster-bias-yearly.html (tricube weights, local linear fit,
     k = ceil(span * N) nearest points, min 4).

     Identical results, but finds the k nearest points with two
     pointers instead of sorting all N points for every i.
     (Ties go to the lower x, which is what the pages' stable sort does.)
     `floor`: null = no clamp (bias page), 0 = clamp at 0 (index.html).
     -------------------------------------------------------------- */
  function loessSmooth(values, span, floor) {
    if (span === undefined) span = 0.03;
    if (floor === undefined) floor = null;
    const clamp = v => (Number.isFinite(v) && floor !== null ? Math.max(floor, v) : v);
    const px = [], py = [];
    values.forEach((v, i) => { if (Number.isFinite(v)) { px.push(i); py.push(v); } });
    const n = px.length;
    if (n < 4) return values.map(v => (Number.isFinite(v) ? clamp(v) : null));
    const k = Math.max(4, Math.min(n, Math.ceil(n * span)));
    const out = values.slice();
    let pos = 0;                                  // first point with x >= i
    for (let i = 0; i < values.length; i++) {
      if (!Number.isFinite(values[i])) { out[i] = null; continue; }
      while (pos < n && px[pos] < i) pos++;
      let lo = pos - 1, hi = pos;
      const sel = [];
      while (sel.length < k) {
        const dl = lo >= 0 ? i - px[lo] : Infinity;
        const dh = hi < n ? px[hi] - i : Infinity;
        if (dl <= dh) { sel.push(lo); lo--; } else { sel.push(hi); hi++; }
      }
      // sort the chosen points in original order so sums add up exactly like the pages' code
      sel.sort((a, b) => a - b);
      let maxDist = 0;
      for (const j of sel) maxDist = Math.max(maxDist, Math.abs(px[j] - i));
      maxDist = maxDist || 1;
      let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
      for (const j of sel) {
        const dist = Math.abs(px[j] - i);
        const u = Math.min(1, dist / maxDist);
        const w = Math.pow(1 - Math.pow(u, 3), 3);
        Sw += w; Sx += w * px[j]; Sy += w * py[j]; Sxx += w * px[j] * px[j]; Sxy += w * px[j] * py[j];
      }
      const denom = Sw * Sxx - Sx * Sx;
      if (Math.abs(denom) < 1e-12) { out[i] = clamp(Sw ? Sy / Sw : values[i]); continue; }
      const beta = (Sw * Sxy - Sx * Sy) / denom;
      const alpha = (Sy - beta * Sx) / Sw;
      out[i] = clamp(alpha + beta * i);
    }
    return out;
  }

  /* --------------------------------------------------------------
     Polling years
     -------------------------------------------------------------- */
  function buildPeriods(cfg, lastDayMs) {
    const out = [];
    for (let y = cfg.firstPeriodYear; ; y++) {
      const start = utc(y, cfg.periodStartMonth, cfg.periodStartDay);
      if (start > lastDayMs) break;
      out.push({ index: out.length, start, endExclusive: utc(y + 1, cfg.periodStartMonth, cfg.periodStartDay), key: y + '-' + String((y + 1) % 100).padStart(2, '0') });
    }
    return out;
  }
  const periodOf = (periods, ms) => { for (const p of periods) if (ms >= p.start && ms < p.endExclusive) return p.index; return -1; };

  /* --------------------------------------------------------------
     Normalise raw input rows.
     rows: [{date:'2026-11-08', pollster:'Norstat', values:{Reform:11.2,...}}]
     (values in percent, missing/blank = null/undefined)
     -------------------------------------------------------------- */
  function normalisePolls(rows, cfg) {
    const polls = [];
    for (const r of rows) {
      const name = cfg.aliases[r.pollster] || r.pollster;
      const ms = parseISO(r.date);
      const v = cfg.parties.map(p => (isNum(r.values[p]) ? r.values[p] : null));
      polls.push({ ms, date: toISO(ms), pollster: name, v });
    }
    polls.sort((a, b) => a.ms - b.ms);
    return polls;
  }

  /* --------------------------------------------------------------
     The 30-day weighted average

     For each day t:   sum over polls p dated t-29..t of
                        strength * (30 - age) * value
     divided by the sum of all those numerators.
     A pollster's blank party counts as 0 and
     "Others" = max(0, 100 - sum of parties) is part of every poll.
     `adjust(poll, j, v)` lets the house-effect step change a value first.
     Returns shares as fractions: out[t][j]
     -------------------------------------------------------------- */
  function weightedShares(cfg, days, polls, strengthOf, adjust) {
    const T = days.length, J = cfg.parties.length, W = cfg.windowDays;
    const num = Array.from({ length: T }, () => new Float64Array(J + 1));
    const t0 = days[0];
    const addPoll = (ms, s, vals) => {
      if (!s) return;
      const day = Math.round((ms - t0) / DAY);
      if (day < 0 || day >= T) return;
      let sum = 0;
      for (let j = 0; j < J; j++) sum += vals[j];
      const others = Math.max(0, 100 - sum);
      for (let t = day; t < Math.min(T, day + W); t++) {
        const w = s * (W - (t - day));
        const row = num[t];
        for (let j = 0; j < J; j++) row[j] += w * vals[j];
        row[J] += w * others;
      }
    };
    // election result on day 0, full strength, never adjusted
    addPoll(t0, 1, cfg.parties.map(p => cfg.election[p] || 0));
    for (const poll of polls) {
      const s = strengthOf(poll.pollster);
      if (!s) continue;
      const vals = poll.v.map((v, j) => (v === null ? 0 : adjust ? adjust(poll, j, v) : v));
      addPoll(poll.ms, s, vals);
    }
    return num.map(row => {
      let den = 0;
      for (let j = 0; j <= J; j++) den += row[j];
      return Array.from({ length: J }, (_, j) => (den > 0 ? row[j] / den : null));
    });
  }

  /* --------------------------------------------------------------
     Whole pipeline
     -------------------------------------------------------------- */
  function run(rawRows, options) {
    const cfg = merge(DEFAULTS, options);
    const parties = cfg.parties, J = parties.length;
    const pollsters = Object.keys(cfg.strength);
    const polls = normalisePolls(rawRows, cfg);
    // a pollster with no entry in cfg.strength would be silently ignored, so report it
    const unknownPollsters = Array.from(new Set(polls.map(p => p.pollster).filter(n => !(n in cfg.strength))));
    const t0 = parseISO(cfg.startDate);
    const lastMs = Math.max.apply(null, polls.map(p => p.ms));
    const days = [];
    for (let t = t0; t <= lastMs; t += DAY) days.push(t);
    const periods = buildPeriods(cfg, lastMs);
    const strengthOf = name => cfg.strength[name] || 0;

    // 1) plain 30-day average
    const plain = weightedShares(cfg, days, polls, strengthOf, null);

    // 2) leave-one-out averages: same thing with one pollster's strength set to 0
    const loo = {};
    for (const name of pollsters) {
      loo[name] = weightedShares(cfg, days, polls, n => (n === name ? 0 : strengthOf(n)), null)
        .map(row => row.map(v => (v === null ? null : roundTo(v, cfg.aggregateDecimals))));
    }

    // 3) pollster-bias-yearly.html: LOESS(leave-one-out) vs each poll, averaged per polling year
    const smoothedLoo = {};
    for (const name of pollsters) {
      smoothedLoo[name] = parties.map((_, j) => loessSmooth(loo[name].map(r => (r[j] === null ? null : r[j] * 100)), cfg.loessSpan, null));
    }
    const dayIndex = new Map(days.map((d, i) => [d, i]));
    const nearest = ms => {
      if (dayIndex.has(ms)) return dayIndex.get(ms);
      let best = -1, bd = Infinity;
      days.forEach((d, i) => { const diff = Math.abs(d - ms); if (diff < bd) { bd = diff; best = i; } });
      return bd > cfg.dateMatchToleranceDays * DAY ? -1 : best;
    };
    const stats = {};   // stats[pollster][periodIndex][partyIndex] = {n, sum, records}
    const biasRecords = [];   // [pollster, party, periodIndex, date, pollValue, leaveOneOutAverage] for the bias page
    for (const poll of polls) {
      const pi = periodOf(periods, poll.ms);
      if (pi < 0 || !smoothedLoo[poll.pollster]) continue;
      const di = nearest(poll.ms);
      if (di < 0) continue;
      for (let j = 0; j < J; j++) {
        if (poll.v[j] === null) continue;
        const agg = smoothedLoo[poll.pollster][j][di];
        if (!isNum(agg)) continue;
        const byP = (stats[poll.pollster] = stats[poll.pollster] || {});
        const byJ = (byP[pi] = byP[pi] || []);
        const cell = (byJ[j] = byJ[j] || { n: 0, sum: 0, records: [] });
        const bias = poll.v[j] - agg;
        cell.n++; cell.sum += bias; cell.records.push({ date: poll.date, bias });
        biasRecords.push([poll.pollster, parties[j], pi, poll.date, poll.v[j], agg]);
      }
    }
    // table[periodKey][pollster][j] = {n, mean, shown}   (shown = the 1-decimal number the page prints)
    const table = {};
    for (const p of periods) {
      table[p.key] = {};
      for (const name of pollsters) {
        table[p.key][name] = parties.map((_, j) => {
          const c = stats[name] && stats[name][p.index] && stats[name][p.index][j];
          if (!c) return { n: 0, mean: null, shown: null };
          const mean = c.sum / c.n;
          return { n: c.n, mean, shown: round1(mean) };
        });
      }
    }

    // 4) house effects: per-year bias figures (pinned for finished years), then each value minus the average over all pollsters
    const effects = {};   // effects[periodKey][pollster][j] = number | null
    const rawCells = {};  // the per-pollster bias figures (1 decimal) the effects are based on
    for (const p of periods) {
      const raw = {};
      for (const name of pollsters) {
        if (cfg.frozen[p.key] && cfg.frozen[p.key][name]) raw[name] = cfg.frozen[p.key][name].slice();
        else raw[name] = table[p.key][name].map(c => {
          if (c.n === 0) return null;
          if (cfg.cellRule === 'strict' && c.n < cfg.minPollsForBias) return null;
          return c.shown;
        });
      }
      rawCells[p.key] = raw;
      const mean = parties.map((_, j) => pollsters.reduce((s, n) => s + (raw[n][j] === null ? 0 : raw[n][j]), 0) / pollsters.length);
      effects[p.key] = {};
      for (const name of pollsters) effects[p.key][name] = raw[name].map((v, j) => (v === null ? null : v - mean[j]));
    }

    // 5) subtract each pollster's effect from its polls (floor 0), re-average
    const adjust = (poll, j, v) => {
      const pi = periodOf(periods, poll.ms);
      if (pi < 0) return v;
      const e = effects[periods[pi].key][poll.pollster];
      const he = e && e[j] !== null ? e[j] : 0;
      return Math.max(0, v - he);
    };
    const adjusted = weightedShares(cfg, days, polls, strengthOf, adjust);

    // first day each party column has a value (election parties: day 0)
    const startMs = parties.map(p => {
      if (cfg.election[p] !== undefined) return t0;
      if (cfg.partyStart[p]) return parseISO(cfg.partyStart[p]);
      const first = polls.find(q => q.v[parties.indexOf(p)] > 0);
      return first ? first.ms : Infinity;
    });
    const od = cfg.outputDecimals;
    const finalAvg = days.map((d, t) => ({ date: toISO(d), values: adjusted[t].map((v, j) => (v === null || d < startMs[j] ? null : roundTo(v, od))) }));
    const leaveOneOut = {};
    for (const name of pollsters) leaveOneOut[name] = days.map((d, t) => ({ date: toISO(d), values: loo[name][t] }));

    // 6) government chart: bloc sums of the (unrounded) adjusted shares, one set of 3 lines per cabinet
    const cabinets = resolveCabinets(cfg);
    const ROLES = [
      ['government', 'Government parties', 'Valitsuserakonnad'],
      ['opposition', 'Parliamentary opposition', 'Parlamentaarne opositsioon'],
      ['extra', 'Extraparliamentary opposition', 'Parlamendiväline opositsioon']
    ];
    const govtLines = [];
    for (const c of cabinets.slice().reverse()) {          // newest cabinet first
      const fromMs = parseISO(c.from), toMs = c.to === null ? Infinity : parseISO(c.to);
      const sums = days.map((d, t) => {
        if (d < fromMs || d > toMs) return null;
        const sum = list => list.reduce((s2, p) => s2 + adjusted[t][parties.indexOf(p)], 0);
        const gv = sum(c.government), op = sum(c.opposition);
        return [gv, op, 1 - gv - op];
      });
      ROLES.forEach(([role, en, et], r) => {
        govtLines.push({
          key: en + ' (' + c.cabinet + ')', role, cabinet: c.cabinet,
          labelEn: en + ' (' + c.cabinet + ')', labelEt: et + ' (' + (c.cabinetEt || c.cabinet) + ')',
          from: c.from, to: c.to,
          parties: r === 0 ? c.government : r === 1 ? c.opposition : null,
          values: sums.map(x => (x === null ? null : roundTo(x[r], od)))
        });
      });
    }
    const markers = cabinets.filter(c => c.marker).map(c => ({ date: c.marker.date, en: c.marker.en, et: c.marker.et || c.marker.en }));

    // 7) house-effect statistics per polling year (what the pages print), unrounded means
    const houseStats = {};
    for (const p of periods) {
      houseStats[p.key] = {};
      for (const name of pollsters) {
        const o = {};
        table[p.key][name].forEach((c, j) => { if (c.n > 0) o[parties[j]] = { n: c.n, mean: roundTo(c.mean, 6) }; });
        if (Object.keys(o).length) houseStats[p.key][name] = o;
      }
    }
    return { cfg, parties, pollsters, periods: periods.map(p => ({ key: p.key, start: toISO(p.start), end: toISO(p.endExclusive - DAY) })),
             days: days.map(toISO), polls, plain, finalAvg, leaveOneOut, govtLines, cabinets, markers, biasRecords, houseStats,
             table, rawCells, effects, unknownPollsters };
  }

  // Validates the cabinet list and fills in each `to` (day before the next cabinet starts).
  function resolveCabinets(cfg) {
    const list = cfg.governments.slice().sort((a, b) => parseISO(a.from) - parseISO(b.from));
    list.forEach((c, i) => {
      const where = 'governments[' + i + '] (' + c.cabinet + ')';
      [].concat(c.government, c.opposition).forEach(p => { if (cfg.parties.indexOf(p) < 0) throw new Error(where + ': unknown party "' + p + '"'); });
      c.government.forEach(p => { if (c.opposition.indexOf(p) >= 0) throw new Error(where + ': "' + p + '" is in both government and opposition'); });
    });
    return list.map((c, i) => {
      const next = list[i + 1];
      const to = c.to || (next ? toISO(parseISO(next.from) - DAY) : null);
      return Object.assign({}, c, { to });
    });
  }

  /* --------------------------------------------------------------
     What index.html does to the final average: LOESS (span .03, floor 0)
     per party, latest value = last row.
     -------------------------------------------------------------- */
  function displaySeries(avgRows, parties, span) {
    const out = {};
    parties.forEach((p, j) => { out[p] = loessSmooth(avgRows.map(r => r.values[j]), span === undefined ? 0.03 : span, 0); });
    return out;
  }

  /* --------------------------------------------------------------
     The single data file the two pages read (data/averages.json).
     Dates are ISO strings, shares are fractions (4 decimals), polls and
     bias figures are in percent, blank = null.
     -------------------------------------------------------------- */
  function buildOutput(res) {
    const cfg = res.cfg;
    return {
      meta: {
        schema: 1,
        firstDate: res.days[0],
        lastPollDate: res.days[res.days.length - 1],
        minPollsForBias: cfg.minPollsForBias,
        dateMatchToleranceDays: cfg.dateMatchToleranceDays,
        strength: cfg.strength,
        pollsters: res.pollsters
      },
      parties: res.parties,
      dates: res.days,
      // house-effect-adjusted 30-day average; null before a party's first poll
      average: res.finalAvg.map(r => r.values),
      government: {
        lines: res.govtLines,
        markers: res.markers
      },
      periods: res.periods,
      polls: res.polls.map(p => ({
        date: p.date, pollster: p.pollster,
        values: Object.fromEntries(res.parties.map((q, j) => [q, p.v[j]]))
      })),
      // per poll and party: the poll, and the pollster's own leave-one-out LOESS average on that date
      biasRecords: {
        fields: ['pollster', 'party', 'period', 'date', 'poll', 'average'],
        rows: res.biasRecords.map(r => [r[0], r[1], r[2], r[3], roundTo(r[4], 6), roundTo(r[5], 6)])
      },
      houseEffects: res.houseStats
    };
  }

  return { DEFAULTS, run, buildOutput, resolveCabinets, loessSmooth, displaySeries, weightedShares, normalisePolls, buildPeriods, parseISO, toISO, round1, roundTo };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = EestimateEngine;
