#!/usr/bin/env node


import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";


const GOOGLE_SHEET_ID = "1gGBmEUW5bwp23602WfQF4eciRrZT4M-VrAz1r5M2JHU";
const SHEET_NAME = "EEavg2";
const SHEET_RANGE = "A:M";
const SITE_URL = "https://bananasareviolet.github.io/eestimate/";
const OUT_IMAGE_NAME = "eestimate-embed.png";
const NEXT_ELECTION_DATE = Date.UTC(2027, 2, 7); // 7 March 2027
const LOESS_SPAN = 0.03;


const TITLE_FONT_FILENAME = "VCR_OSD_MONO.woff2";
const TITLE_FONT_FAMILY = "VCR OSD Mono";

const PARTY_COLOURS = {
  Reform: "#f4dd52", EKRE: "#8e7b6d", Centre: "#58a367", E200: "#6c5db7",
  SDE: "#d34564", Isamaa: "#6396e8", VL: "#b064a5", Koos: "#55c0c9",
  PP: "#e88743", Greens: "#98C62B", ERK: "#d7c262", Free: "#b6d3dd",
  "EÜRP": "#b5651d", Coalition: "#044999", "Res Publica": "#ff7750",
  "Ind.": "#8a8d91"
};


const n = v => { const x = Number(String(v).replace(",", ".")); return Number.isFinite(x) ? x : null; };
const pct = v => {
  if (v === null || v === undefined || v === "") return null;
  const hasPercentSign = /%\s*$/.test(String(v).trim());
  const x = n(v);
  return x === null ? null : (!hasPercentSign && Math.abs(x) <= 1.5) ? x * 100 : x;
};
const MONTH_ABBR = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const dt = v => {
  if (v === null || v === undefined || v === "") return null;
  if (typeof v === "number") return new Date(Date.UTC(1899, 11, 30) + v * 86400000);
  const s = String(v).trim();
  const gviz = s.match(/^Date\((\d{4}),(\d{1,2}),(\d{1,2})/);
  if (gviz) return new Date(Date.UTC(+gviz[1], +gviz[2], +gviz[3]));
  const dmy = s.match(/^(\d{1,2})[-\/ ]([A-Za-z]{3,})[-\/ ](\d{2,4})$/);
  if (dmy) {
    const day = +dmy[1], mon = MONTH_ABBR[dmy[2].slice(0, 3).toLowerCase()];
    let year = +dmy[3]; if (dmy[3].length <= 2) year = year < 30 ? 2000 + year : 1900 + year;
    if (mon !== undefined) return new Date(Date.UTC(year, mon, day));
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
};
function parseGviz(t) {
  const a = t.indexOf("{"), b = t.lastIndexOf("}");
  if (a < 0 || b <= a) throw new Error("No response from database, hm.");
  return JSON.parse(t.slice(a, b + 1));
}
function loessSmooth(values, span = LOESS_SPAN, floor = 0) {
  const clamp = v => (Number.isFinite(v) && floor !== null) ? Math.max(floor, v) : v;
  const points = [];
  values.forEach((value, index) => { if (Number.isFinite(value)) points.push({ x: index, y: value }); });
  if (points.length < 4) return values.map(v => Number.isFinite(v) ? clamp(v) : null);
  const k = Math.max(4, Math.min(points.length, Math.ceil(points.length * span)));
  const out = values.slice();
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i])) { out[i] = null; continue; }
    let nearest = points.map(p => ({ p, dist: Math.abs(p.x - i) })).sort((a, b) => a.dist - b.dist).slice(0, k);
    const maxDist = nearest.at(-1).dist || 1;
    let Sw = 0, Sx = 0, Sy = 0, Sxx = 0, Sxy = 0;
    for (const { p, dist } of nearest) {
      const u = Math.min(1, dist / maxDist);
      const w = Math.pow(1 - Math.pow(u, 3), 3);
      Sw += w; Sx += w * p.x; Sy += w * p.y; Sxx += w * p.x * p.x; Sxy += w * p.x * p.y;
    }
    const denom = Sw * Sxx - Sx * Sx;
    if (Math.abs(denom) < 1e-12) { out[i] = clamp(Sw ? Sy / Sw : values[i]); continue; }
    const beta = (Sw * Sxy - Sx * Sy) / denom;
    const alpha = (Sy - beta * Sx) / Sw;
    out[i] = clamp(alpha + beta * i);
  }
  return out;
}


async function fetchLatestPoll() {
  const u = `https://docs.google.com/spreadsheets/d/${GOOGLE_SHEET_ID}/gviz/tq?tqx=out:json&headers=1&range=${encodeURIComponent(`${SHEET_NAME}!${SHEET_RANGE}`)}`;
  const r = await fetch(u, { cache: "no-store" });
  if (!r.ok) throw new Error(`Sheet HTTP ${r.status}`);
  const g = parseGviz(await r.text());
  const cols = g.table?.cols || [], rows = g.table?.rows || [];
  const headers = cols.map((c, i) => String(c.label || c.id || "").trim() || `Column ${i + 1}`);
  const di = headers.findIndex(h => h.toLowerCase() === "date");
  if (di < 0) throw new Error("No date column found in sheet");

  let latestRows = [];
  for (const row of rows) {
    const c = row.c || [], dc = c[di] || {}, d = dt(dc.v !== undefined ? dc.v : dc.f);
    if (!d) continue;
    const rec = { date: d };
    headers.forEach((h, i) => { if (i !== di) { const x = c[i] || {}; rec[h] = pct(x.v !== undefined ? x.v : x.f); } });
    latestRows.push(rec);
  }
  latestRows.sort((a, b) => a.date - b.date);
  if (!latestRows.length) throw new Error("No dated rows found in sheet");

  const keys = headers.filter(h => h !== headers[di]);
  const smoothedRows = latestRows.map(r => ({ date: r.date }));
  for (const key of keys) {
    const smooth = loessSmooth(latestRows.map(r => r[key]));
    smooth.forEach((value, i) => { smoothedRows[i][key] = value; });
  }
  const lastSmoothed = smoothedRows.at(-1);
  const lastDate = latestRows.at(-1).date;

  const latestPoll = keys
    .map(name => ({ name, colour: PARTY_COLOURS[name] || "#777", support: lastSmoothed[name] }))
    .filter(p => p.support !== null && Number.isFinite(p.support));

  return { latestPoll, lastDate };
}


function buildDescription(latestPoll) {
  const sorted = [...latestPoll].sort((a, b) => b.support - a.support);
  const [first, second] = sorted;
  const now = new Date();
  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const daysLeft = Math.max(0, Math.floor((NEXT_ELECTION_DATE - today) / 86400000));
  const r1 = Math.round(first.support * 10) / 10, r2 = Math.round(second.support * 10) / 10;
  const leadLine = r1 === r2
    ? `${first.name} and ${second.name} are tied.`
    : `${first.name} is leading ${second.name} by ${(r1 - r2).toFixed(1)} points.`;
  const electionLine = `There are ${daysLeft.toLocaleString("en-GB")} days or fewer until the next Riigikogu election.`;
  return `Eestimate is an Estonian party preference polling tracker and aggregator. ${leadLine} ${electionLine}`;
}


function buildSvg(latestPoll, { titleFontFamily } = {}) {
  const top7 = [...latestPoll].sort((a, b) => b.support - a.support).slice(0, 7);
  const W = 1200, H = 630, BG = "#313d4e";
  const yTop = 210, yBase = 560, areaH = yBase - yTop;
  const maxSupport = Math.max(...top7.map(p => p.support), 1);
  const leftMargin = 80, gap = 24;
  const barW = (W - 2 * leftMargin - gap * (top7.length - 1)) / top7.length;

  const bars = top7.map((p, i) => {
    const h = Math.max(4, (p.support / maxSupport) * areaH);
    const x = leftMargin + i * (barW + gap);
    const y = yBase - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" fill="${p.colour}"/>`;
  }).join("\n");

  const fontFamily = `${titleFontFamily ? `"${titleFontFamily}", ` : ""}"Arial Black", Arial, sans-serif`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="130" text-anchor="middle" font-family='${fontFamily}' font-weight="900" font-size="72" letter-spacing="6" fill="#ffffff">EESTIMATE</text>
  ${bars}
</svg>`;
}

function escapeAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function buildMetaBlock({ title, description, imageUrl, pageUrl }) {
  return `<!-- EESTIMATE_OG_START (regenerated by generate-embed.mjs — do not hand-edit) -->
  <meta property="og:type" content="website">
  <meta property="og:url" content="${escapeAttr(pageUrl)}">
  <meta property="og:title" content="${escapeAttr(title)}">
  <meta property="og:description" content="${escapeAttr(description)}">
  <meta property="og:image" content="${escapeAttr(imageUrl)}">
  <meta property="og:image:width" content="1200">
  <meta property="og:image:height" content="630">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:title" content="${escapeAttr(title)}">
  <meta name="twitter:description" content="${escapeAttr(description)}">
  <meta name="twitter:image" content="${escapeAttr(imageUrl)}">
  <!-- EESTIMATE_OG_END -->`;
}

async function updateHtml(htmlPath, metaBlock) {
  const html = await readFile(htmlPath, "utf8");
  const re = /<!-- EESTIMATE_OG_START[\s\S]*?EESTIMATE_OG_END -->/;
  if (!re.test(html)) throw new Error("Could not find EESTIMATE_OG_START/END markers in " + htmlPath);
  await writeFile(htmlPath, html.replace(re, metaBlock), "utf8");
}

export async function buildEmbedAssets(latestPoll, { htmlPath, outDir }) {
  const description = buildDescription(latestPoll);
  const title = "Eestimate — Riigikogu polling tracker";
  const imageUrl = new URL(OUT_IMAGE_NAME, SITE_URL).toString();


  const fontPath = path.join(path.dirname(htmlPath), TITLE_FONT_FILENAME);
  const fontAvailable = existsSync(fontPath);
  if (!fontAvailable) {
    console.warn(`Note: ${TITLE_FONT_FILENAME} not found next to ${htmlPath} — title will use the sans-serif fallback instead.`);
  }

  const svg = buildSvg(latestPoll, { titleFontFamily: fontAvailable ? TITLE_FONT_FAMILY : null });
  const resvgOpts = {
    fitTo: { mode: "width", value: 1200 },
    font: fontAvailable
      ? { fontFiles: [fontPath], loadSystemFonts: true, defaultFontFamily: TITLE_FONT_FAMILY }
      : { loadSystemFonts: true }
  };
  const png = new Resvg(svg, resvgOpts).render().asPng();
  await writeFile(`${outDir}/${OUT_IMAGE_NAME}`, png);
  await updateHtml(htmlPath, buildMetaBlock({ title, description, imageUrl, pageUrl: SITE_URL }));
  return { description, title, imageUrl };
}

async function main() {
  const htmlPath = process.argv[2] || "index.html";
  console.log("Fetching latest poll data…");
  const { latestPoll, lastDate } = await fetchLatestPoll();
  console.log(`Loaded ${latestPoll.length} parties, latest row: ${lastDate.toISOString().slice(0, 10)}`);
  const result = await buildEmbedAssets(latestPoll, { htmlPath, outDir: "." });
  console.log("Wrote", OUT_IMAGE_NAME);
  console.log("Description:", result.description);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
