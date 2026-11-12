#!/usr/bin/env node
// Regenerates eestimate-embed.png and the social-preview tags in index.html
// from data/averages.json.

import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { Resvg } from "@resvg/resvg-js";

// ---- Config: mirrors the constants in index.html ----------------------
const DATA_FILE = new URL("./data/averages.json", import.meta.url);
const SITE_URL = "https://bananasareviolet.github.io/eestimate/";
const OUT_IMAGE_NAME = "eestimate-embed.png";
const NEXT_ELECTION_DATE = Date.UTC(2027, 2, 7); // 7 March 2027
const LOESS_SPAN = 0.03;

const TITLE_FONT_CANDIDATES = ["VCR_OSD_MONO_1.001.ttf", "VCR_OSD_MONO.woff2"];
const TITLE_FONT_FAMILY = "VCR OSD Mono";

const PARTY_COLOURS = {
  Reform: "#f4dd52", EKRE: "#8e7b6d", Centre: "#58a367", E200: "#6c5db7",
  SDE: "#d34564", Isamaa: "#6396e8", VL: "#b064a5", Koos: "#55c0c9",
  PP: "#e88743", Greens: "#98C62B", ERK: "#d7c262", Free: "#b6d3dd",
  "EÜRP": "#b5651d", Coalition: "#044999", "Res Publica": "#ff7750",
  "Ind.": "#8a8d91"
};

export function loessSmooth(values, span = LOESS_SPAN, floor = 0) {
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

// ---- Read + compute the full smoothed history, same as the page --------
async function fetchPollHistory() {
  const d = JSON.parse(await readFile(DATA_FILE, "utf8"));
  if (!d || !Array.isArray(d.dates) || !Array.isArray(d.average) || !Array.isArray(d.parties) || !d.dates.length) {
    throw new Error("data/averages.json is missing or empty");
  }
  const keys = d.parties;
  const latestRows = d.dates.map((iso, i) => {
    const [y, m, day] = iso.split("-").map(Number);
    const rec = { date: new Date(Date.UTC(y, m - 1, day)) };
    keys.forEach((k, j) => {
      const v = d.average[i][j];
      rec[k] = (v === null || v === undefined || !Number.isFinite(v)) ? null : Math.round(v * 1e8) / 1e6;
    });
    return rec;
  });

  const smoothedRows = latestRows.map(r => ({ date: r.date }));
  for (const key of keys) {
    const smooth = loessSmooth(latestRows.map(r => r[key]));
    smooth.forEach((value, i) => { smoothedRows[i][key] = value; });
  }
  const lastSmoothed = smoothedRows.at(-1);
  const lastDate = latestRows.at(-1).date;

  // Same selection the bar version used: current (latest smoothed) support,
  // one row per party — this is what decides which 7 parties get a line.
  const latestPoll = keys
    .map(name => ({ name, colour: PARTY_COLOURS[name] || "#777", support: lastSmoothed[name] }))
    .filter(p => p.support !== null && Number.isFinite(p.support));

  return { smoothedRows, keys, latestPoll, lastDate };
}

// ---- Text: lead line + days-until-election, matching the page's copy ---
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

// ---- Image: title + 7 polling-average lines, coloured by party, no labels
function buildSvg({ smoothedRows, latestPoll }, { titleFontFamily } = {}) {
  const top7 = [...latestPoll].sort((a, b) => b.support - a.support).slice(0, 7);
  const top7Names = new Set(top7.map(p => p.name));
  const W = 1200, H = 630, BG = "#313d4e";
  const xLeft = 70, xRight = 1130, yTop = 210, yBase = 560;
  const areaW = xRight - xLeft, areaH = yBase - yTop;

  const t0 = smoothedRows[0].date.getTime();
  const t1 = smoothedRows.at(-1).date.getTime();
  const tSpan = Math.max(1, t1 - t0);


  let maxSupport = 1;
  for (const row of smoothedRows) {
    for (const name of top7Names) {
      const v = row[name];
      if (Number.isFinite(v)) maxSupport = Math.max(maxSupport, v);
    }
  }
  const yScale = (areaH * 0.92) / maxSupport;
  const xOf = ms => xLeft + ((ms - t0) / tSpan) * areaW;
  const yOf = v => yBase - v * yScale;

  // Draw lowest-support line first, leader last, so the leading party's
  // trend reads as the foreground line where paths cross.
  const linesInDrawOrder = [...top7].sort((a, b) => a.support - b.support);

  const lines = linesInDrawOrder.map(party => {
    let d = "", drawing = false;
    for (const row of smoothedRows) {
      const v = row[party.name];
      if (!Number.isFinite(v)) { drawing = false; continue; }
      const x = xOf(row.date.getTime()).toFixed(1), y = yOf(v).toFixed(1);
      d += drawing ? ` L${x},${y}` : `${d ? " " : ""}M${x},${y}`;
      drawing = true;
    }
    return `<path d="${d}" fill="none" stroke="${party.colour}" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>`;
  }).join("\n");

  const fontFamily = `${titleFontFamily ? `"${titleFontFamily}", ` : ""}"Arial Black", Arial, sans-serif`;

  return `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg">
  <rect x="0" y="0" width="${W}" height="${H}" fill="${BG}"/>
  <text x="${W / 2}" y="130" text-anchor="middle" font-family='${fontFamily}' font-weight="900" font-size="72" letter-spacing="6" fill="#ffffff">EESTIMATE</text>
  ${lines}
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

export async function buildEmbedAssets(history, { htmlPath, outDir }) {
  const { latestPoll } = history;
  const description = buildDescription(latestPoll);
  const title = "Eestimate, a Riigikogu polling tracker";
  const imageUrl = new URL(OUT_IMAGE_NAME, SITE_URL).toString();

  // Reuse the repo's VCR OSD Mono font file for the title, if one of the
  // known filenames is sitting next to index.html. Falls back to a bold
  // sans-serif otherwise.
  const htmlDir = path.dirname(htmlPath);
  const foundFontName = TITLE_FONT_CANDIDATES.find(name => existsSync(path.join(htmlDir, name)));
  const fontPath = foundFontName ? path.join(htmlDir, foundFontName) : null;
  const fontAvailable = fontPath !== null;
  if (!fontAvailable) {
    console.warn(`Note: none of [${TITLE_FONT_CANDIDATES.join(", ")}] found next to ${htmlPath} — title will use the sans-serif fallback instead.`);
  }

  const svg = buildSvg(history, { titleFontFamily: fontAvailable ? TITLE_FONT_FAMILY : null });
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
  console.log("Reading data/averages.json…");
  const history = await fetchPollHistory();
  console.log(`Loaded ${history.latestPoll.length} parties, ${history.smoothedRows.length} dated rows, latest: ${history.lastDate.toISOString().slice(0, 10)}`);
  const result = await buildEmbedAssets(history, { htmlPath, outDir: "." });
  console.log("Wrote", OUT_IMAGE_NAME);
  console.log("Description:", result.description);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(e => { console.error(e); process.exit(1); });
}
