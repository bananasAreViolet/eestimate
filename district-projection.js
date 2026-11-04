/*
 * Eestimate – district projection
 * Drop-in module: add  <script src="district-projection.js"></script>  just before </body>
 * (after the main <script> block). It inserts a "DISTRICT PROJECTION" window above the
 * Coalition Builder and re-renders whenever the main page re-renders the seat projection
 * (data load, refresh, language switch).
 *
 * Method
 *  1. Start from the 2023 result in each district.
 *  2. Rescale each party's district numbers so the seat-weighted national figure equals the
 *     current polling average (proportional swing), re-normalise every district to 100%, and
 *     repeat until both constraints hold (iterative proportional fitting / raking).
 *  3. Allocate seats the Estonian way, approximately:
 *       - district mandates: floor(share × district seats) per party above the 5% threshold
 *       - remaining seats: national modified d'Hondt (divisor n^0.9, first divisor 1),
 *         same routine as the page's existing Seat Projection
 *       - each party's compensation seats go to the districts where it has the largest
 *         remainders (fractional quota left over after step one).
 */
(function () {
  "use strict";

  // Must match the page's DISTRICTS / threshold / exponent.
  var SEATS = [10, 13, 8, 16, 6, 5, 6, 7, 7, 8, 8, 7];
  var THRESHOLD = 5;
  var EXPONENT = 0.9;
  var TOTAL_SEATS = 101;
  var FLOOR = 0.05; // keeps zero cells scalable

  // 2023 vote share (%) per district, order No. 1 … No. 12.
  var BASE_2023 = {
    Reform: [31.4, 29.4, 34.7, 40.0, 27.6, 31.1, 14.1, 27.8, 30.4, 35.9, 24.0, 29.5],
    Centre: [20.9, 29.0, 18.9, 10.2, 11.2, 13.4, 25.8, 10.2, 9.2, 7.3, 13.4, 11.4],
    EKRE:   [9.7, 9.1, 11.7, 14.6, 19.4, 20.5, 8.4, 23.3, 19.7, 14.5, 26.5, 26.0],
    Isamaa: [5.6, 5.4, 6.5, 8.3, 7.8, 13.7, 4.0, 11.9, 12.0, 8.6, 8.5, 10.0],
    SDE:    [10.0, 8.6, 8.9, 7.1, 13.9, 7.5, 7.6, 12.9, 9.0, 9.9, 12.3, 6.7],
    E200:   [15.7, 10.9, 14.2, 13.7, 17.1, 8.7, 8.3, 10.7, 14.6, 18.4, 11.5, 12.8],
    Greens: [1.1, 1.0, 1.1, 0.7, 0.9, 0.5, 0.5, 0.8, 1.0, 1.7, 1.3, 0.8],   // 2023 "EER"
    PP:     [2.3, 1.6, 2.1, 3.4, 2.1, 3.0, 1.0, 2.1, 2.6, 2.0, 2.3, 2.2],   // 2023 "Parempoolsed"
    "EÜRP": [3.3, 4.9, 1.9, 1.3, 0.0, 1.5, 14.9, 0.0, 1.5, 1.6, 0.0, 0.7],  // 2023 "EÜVP"
    "Ind.": [0.1, 0.1, 0.0, 0.8, 0.0, 0.2, 15.5, 0.3, 0.0, 0.0, 0.2, 0.0]
  };

  // Parties that did not run in 2023 (VL, Koos, Free, ERK) have no district pattern.
  // By default they are assumed flat (same % everywhere). To borrow another party's
  // 2023 pattern instead, e.g. { VL: "SDE" }, fill this in.
  var PROXY = {};

  function div(n) { return n <= 1 ? 1 : Math.pow(n, EXPONENT); }

  /* ---------- step 1–2: district vote shares ---------- */
  function estimateDistrictShares(national, opts) {
    opts = opts || {};
    var base = opts.base || BASE_2023, seats = opts.seats || SEATS, nd = seats.length;
    var parties = Object.keys(national).filter(function (p) { return Number.isFinite(national[p]); });
    var sum = parties.reduce(function (a, p) { return a + national[p]; }, 0);
    var target = {}, other;
    if (sum > 100) { parties.forEach(function (p) { target[p] = national[p] * 100 / sum; }); other = 0; }
    else { parties.forEach(function (p) { target[p] = national[p]; }); other = 100 - sum; }
    var keys = parties.slice();
    if (other > 1e-9) { target.Other = other; keys.push("Other"); }

    var W = seats.reduce(function (a, b) { return a + b; }, 0);
    var s = [], d, k;
    for (d = 0; d < nd; d++) {
      var row = {};
      parties.forEach(function (p) {
        var src = base[p] ? p : (PROXY[p] && base[PROXY[p]] ? PROXY[p] : null);
        row[p] = src ? Math.max(base[src][d], FLOOR) : Math.max(target[p], FLOOR);
      });
      if (target.Other !== undefined) {
        var o = 0;
        Object.keys(base).forEach(function (b) { if (parties.indexOf(b) < 0) o += base[b][d]; });
        row.Other = Math.max(o, FLOOR);
      }
      s.push(row);
    }
    for (var it = 0; it < 500; it++) {
      var maxErr = 0;
      for (k = 0; k < keys.length; k++) {
        var key = keys[k], m = 0;
        for (d = 0; d < nd; d++) m += seats[d] * s[d][key];
        m /= W;
        if (m <= 0) continue;
        maxErr = Math.max(maxErr, Math.abs(m - target[key]));
        var f = target[key] / m;
        for (d = 0; d < nd; d++) s[d][key] *= f;
      }
      for (d = 0; d < nd; d++) {
        var tot = 0; keys.forEach(function (q) { tot += s[d][q]; });
        keys.forEach(function (q) { s[d][q] *= 100 / tot; });
      }
      if (maxErr < 1e-7) break;
    }
    return { shares: s, target: target, keys: keys };
  }

  /* ---------- step 3: seats ---------- */
  // shares[d][party] in %, natVotes[party] in % (national), returns per-district seats + totals
  function allocateSeats(shares, natVotes, seats) {
    seats = seats || SEATS;
    var nd = seats.length, d;
    var eligible = Object.keys(natVotes).filter(function (p) { return p !== "Other" && natVotes[p] >= THRESHOLD; });
    var dm = [], rem = [], districtSeats = [];
    for (d = 0; d < nd; d++) {
      dm.push({}); rem.push({}); districtSeats.push({});
      eligible.forEach(function (p) {
        var q = shares[d][p] / 100 * seats[d];
        var f = Math.floor(q + 1e-9);
        dm[d][p] = f; rem[d][p] = q - f; districtSeats[d][p] = f;
      });
    }
    var have = {}, comp = {}, left = TOTAL_SEATS;
    eligible.forEach(function (p) {
      have[p] = 0; comp[p] = 0;
      for (d = 0; d < nd; d++) have[p] += dm[d][p];
      left -= have[p];
    });
    while (left > 0 && eligible.length) {
      var win = null, best = -Infinity;
      eligible.forEach(function (p) {
        var z = natVotes[p] / div(have[p] + comp[p] + 1);
        if (z > best + 1e-12 || (Math.abs(z - best) < 1e-12 && win && natVotes[p] > natVotes[win])) { win = p; best = z; }
      });
      if (!win) break;
      comp[win]++; left--;
    }
    eligible.forEach(function (p) {
      var order = []; for (d = 0; d < nd; d++) order.push(d);
      order.sort(function (a, b) { return rem[b][p] - rem[a][p]; });
      for (var i = 0; i < comp[p]; i++) districtSeats[order[i % nd]][p]++;
    });
    var totals = {};
    eligible.forEach(function (p) { totals[p] = have[p] + comp[p]; });
    return { eligible: eligible, districtSeats: districtSeats, totals: totals, districtMandates: dm };
  }

  function projectDistricts(national) {
    var est = estimateDistrictShares(national);
    var alloc = allocateSeats(est.shares, est.target);
    return { shares: est.shares, target: est.target, eligible: alloc.eligible, seats: alloc.districtSeats, totals: alloc.totals };
  }

  var api = { estimateDistrictShares: estimateDistrictShares, allocateSeats: allocateSeats, projectDistricts: projectDistricts, BASE_2023: BASE_2023, SEATS: SEATS };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  if (typeof document === "undefined") return;

  /* ---------- browser: rendering ---------- */
  var STR = {
    en: {
      title: "DISTRICT PROJECTION",
      district: "No.",
      seats: function (n) { return n + (n === 1 ? " seat" : " seats"); },
      others: "Others / below threshold",
      note: function (asAt) {
        return "Latest numbers projected onto the 2023 district results. Each party's 2023 district figures are scaled so that the seat-weighted national total matches the current polling average, and every district is then re-normalised to 100%. Seats: district mandates by simple quota, the rest by national modified d'Hondt, with compensation seats going to the districts with the largest remainders. Parties that did not run in 2023 are assumed to be flat across districts. Districts are weighted by their number of mandates rather than actual turnout, so this is an approximation and may differ by a seat or two from the national Seat Projection above. Final seats per district can differ from the nominal district size because of compensation seats.";
      },
      totals: "Model totals:"
    },
    et: {
      title: "ringkondade prognoos".toUpperCase(),
      district: "Nr",
      seats: function (n) { return n + (n === 1 ? " koht" : " kohta"); },
      others: "Muud / alla valimiskünnise",
      note: function (asAt) {
        return "Viimased numbrid projitseeritud 2023. aasta ringkonnatulemustele. Iga erakonna 2023. aasta ringkonnanäitajad skaleeritakse nii, et kohtadega kaalutud üleriigiline summa vastaks praegusele küsitluste keskmisele, seejärel normaliseeritakse iga ringkond 100%-le. Kohad: ringkonnamandaadid lihtkvoodi alusel, ülejäänud üleriigilise modifitseeritud d'Hondti meetodiga, kompensatsioonimandaadid suurimate jääkidega ringkondadesse. Erakondade puhul, kes 2023. aastal ei kandideerinud, eeldatakse ühtlast toetust kõigis ringkondades. Ringkondi kaalutakse mandaatide arvu, mitte tegeliku osalusmäära järgi, seega on tegu lähendusega ning tulemus võib ülalolevast kohtade prognoosist erineda ühe-kahe koha võrra. Ringkonna lõplik kohtade arv võib kompensatsioonimandaatide tõttu nimiväärtusest erineda.";
      },
      totals: "Mudeli kogusumma:"
    }
  };
  var NAMES = {
    en: ["Haabersti, Põhja-Tallinn and Kristiine", "Kesklinn, Lasnamäe and Pirita", "Mustamäe and Nõmme", "Harju and Rapla", "Hiiu, Lääne and Saare", "Lääne-Viru", "Ida-Viru", "Järva and Viljandi", "Jõgeva and Tartu County", "Tartu city", "Võru, Valga and Põlva", "Pärnu"],
    et: ["Haabersti, Põhja-Tallinn ja Kristiine", "Kesklinn, Lasnamäe ja Pirita", "Mustamäe ja Nõmme", "Harju- ja Raplamaa", "Hiiu-, Lääne- ja Saaremaa", "Lääne-Virumaa", "Ida-Virumaa", "Järva- ja Viljandimaa", "Jõgeva- ja Tartumaa", "Tartu linn", "Võru-, Valga- ja Põlvamaa", "Pärnumaa"]
  };

  function lang() { try { return currentLang === "et" ? "et" : "en"; } catch (e) { return "en"; } }
  function num1(v) { var s = v.toFixed(1); return lang() === "et" ? s.replace(".", ",") : s; }
  function esc2(v) { return String(v).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"); }
  function label(p) { try { return p === "Other" ? STR[lang()].others : partyLabel(p); } catch (e) { return p; } }
  function colour(p) { try { return PARTY_COLOURS[p] || "#777"; } catch (e) { return "#777"; } }
  function order(p) { try { var i = PREFERRED_ORDER.indexOf(p); return i < 0 ? 999 : i; } catch (e) { return 999; } }

  var css = document.createElement("style");
  css.textContent =
    ".dp-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(310px,1fr));gap:16px 18px;padding:4px}" +
    ".dp-panel{width:100%;max-width:460px;margin:0 auto}" +
    ".dp-title{font-family:'VCR OSD Mono',monospace;font-size:15px;margin:0 0 2px}" +
    ".dp-sub{font-size:12px;color:var(--muted);margin:0 0 6px}" +
    ".dp-dots{display:flex;flex-wrap:wrap;gap:2px;margin:0 0 8px}" +
    ".dp-dot{width:12px;height:12px;border:1px solid #000;border-radius:0}" +
    ".dp-row{display:flex;align-items:center;gap:8px;margin-top:4px}" +
    ".dp-row .party-box{width:64px;min-height:20px;font-size:11px;padding:2px 3px;margin:0;border-radius:0;flex:0 0 64px}" +
    ".dp-bar{flex:1;height:12px;background:rgba(128,128,128,.18)}" +
    ".dp-bar span{display:block;height:100%}" +
    ".dp-pct{width:44px;text-align:right;font-weight:700}" +
    ".dp-seat{width:22px;text-align:right;font-weight:700}" +
    ".dp-other{margin-top:6px;font-size:11px;color:var(--muted)}" +
    ".dp-totals{display:flex;flex-wrap:wrap;gap:6px 12px;margin-top:10px;font-size:12px}";
  document.head.appendChild(css);

  var section = document.createElement("section");
  section.className = "window";
  section.innerHTML =
    '<div class="titlebar"><span id="dpTitle">DISTRICT PROJECTION</span></div>' +
    '<div class="window-body"><div class="chart-surface" style="padding-bottom:32px"><div class="dp-grid" id="dpGrid"></div><div class="dp-totals" id="dpTotals"></div>' +
    '<img class="corner-logo" src="https://bananasareviolet.github.io/eestimate/eestimate.png" alt="Eestimate logo"></div>' +
    '<p class="header-note" id="dpNote"></p></div>';
  var anchor = document.getElementById("coalitionSeats");
  anchor = anchor && anchor.closest(".window");
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(section, anchor);
  else document.querySelector(".page").appendChild(section);

  function render() {
    var S = STR[lang()];
    document.getElementById("dpTitle").textContent = S.title;
    var grid = document.getElementById("dpGrid");
    if (typeof latestPoll === "undefined" || !latestPoll || !latestPoll.length) { grid.innerHTML = ""; return; }
    var national = {};
    latestPoll.forEach(function (p) { if (Number.isFinite(p.support)) national[p.key] = p.support; });
    var r = projectDistricts(national);
    var html = "";
    for (var d = 0; d < SEATS.length; d++) {
      var sh = r.shares[d], st = r.seats[d];
      var elig = r.eligible.slice().sort(function (a, b) { return sh[b] - sh[a]; });
      var total = 0; elig.forEach(function (p) { total += st[p]; });
      var dots = "";
      r.eligible.slice().sort(function (a, b) { return order(a) - order(b); }).forEach(function (p) {
        for (var i = 0; i < st[p]; i++) dots += '<span class="dp-dot" style="background:' + esc2(colour(p)) + '" title="' + esc2(label(p)) + '"></span>';
      });
      var rows = elig.map(function (p) {
        return '<div class="dp-row"><span class="party-box" style="background:' + esc2(colour(p)) + '">' + esc2(label(p)) + '</span>' +
          '<div class="dp-bar"><span style="width:' + Math.min(100, sh[p] / 50 * 100).toFixed(1) + '%;background:' + esc2(colour(p)) + '"></span></div>' +
          '<span class="dp-pct">' + num1(sh[p]) + '%</span><span class="dp-seat">' + st[p] + '</span></div>';
      }).join("");
      var rest = 100; elig.forEach(function (p) { rest -= sh[p]; });
      html += '<div class="dp-panel"><div class="dp-title">' + S.district + " " + (d + 1) + " · " + esc2(NAMES[lang()][d]) + '</div>' +
        '<div class="dp-sub">' + S.seats(total) + " (" + SEATS[d] + ')</div><div class="dp-dots">' + dots + '</div>' + rows +
        '<div class="dp-other">' + esc2(S.others) + ": " + num1(Math.max(0, rest)) + '%</div></div>';
    }
    grid.innerHTML = html;
    var tot = r.eligible.slice().sort(function (a, b) { return order(a) - order(b); }).map(function (p) {
      return '<span><b style="color:' + esc2(colour(p)) + '">' + esc2(label(p)) + "</b> " + r.totals[p] + "</span>";
    }).join("");
    document.getElementById("dpTotals").innerHTML = "<b>" + S.totals + "</b> " + tot;
    document.getElementById("dpNote").textContent = S.note();
  }

  // Re-render whenever the page re-renders its main seat projection.
  if (typeof renderProjection === "function") {
    var orig = renderProjection;
    renderProjection = function () { orig.apply(this, arguments); try { render(); } catch (e) { console.error(e); } };
  }
  render();
})();
