// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages using native Notion tables.
//
// BVP tomorrow and SB tomorrow pages are written with a NORMALIZED, FIXED schema
// so that rotowire-projected.js can do exact header matching:
//   BVP:  Player | #AB | QAB% | HH% | HRF
//   SB:   Player | SB%
//
// Player keys are stored as name-only (e.g. "m betts") — FIC game cells give the
// matchup (BOS @ NYY) but not which side the batter plays for, so team-prefixed
// keys were unreliable. Name-only keys are unambiguous in practice and match how
// rotowire-projected.js already falls back.
//
// FIC player cells contain the name followed by position/hand/injury in sibling spans.
// playerNameFromCell() extracts only the name (first <a> or first text node).

import axios from "axios";
import * as cheerio from "cheerio";
import { Client as NotionClient } from "@notionhq/client";
import {
  NOTION_TOKEN,
  BROWSERLESS_TOKEN,
  FIC_BVP_TODAY_PAGE_ID,
  FIC_BVP_TOMORROW_PAGE_ID,
  FIC_SB_TODAY_PAGE_ID,
  FIC_SB_TOMORROW_PAGE_ID,
  requireEnv,
} from "./config.js";
import { logRun } from "./notion.js";
import { overwritePageWithTable } from "./notiontables.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("BROWSERLESS_TOKEN", BROWSERLESS_TOKEN);
requireEnv("FIC_BVP_TODAY_PAGE_ID", FIC_BVP_TODAY_PAGE_ID);
requireEnv("FIC_BVP_TOMORROW_PAGE_ID", FIC_BVP_TOMORROW_PAGE_ID);
requireEnv("FIC_SB_TODAY_PAGE_ID", FIC_SB_TODAY_PAGE_ID);
requireEnv("FIC_SB_TOMORROW_PAGE_ID", FIC_SB_TOMORROW_PAGE_ID);

const BVP_BASE = "https://www.fantasyinfocentral.com/mlb/daily-matchups";
const SB_BASE  = "https://www.fantasyinfocentral.com/betting/mlb/sb-predictions";

// ── Fixed output schemas ──────────────────────────────────────────────────────
const BVP_COLUMNS = ["Player", "#AB", "QAB%", "HH%", "HRF"];
const SB_COLUMNS  = ["Player", "SB%"];

// ── Date helpers (Mountain Time) ─────────────────────────────────────────────

function getMtDate(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

export function todayDate()    { return getMtDate(0); }
export function tomorrowDate() { return getMtDate(1); }

function buildUrl(base, date) {
  return `${base}?date=${date}`;
}

// ── Name normalization ────────────────────────────────────────────────────────

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Player name extractor ────────────────────────────────────────────────────
// FIC player cells look like:
//   <td><a href="...">M. Betts</a><span>SS</span><span>R</span><span>IL</span></td>
// We want ONLY the player name, not position/hand/injury.
// Strategy: take the text of the first <a> if present, else the first non-empty text node.

function playerNameFromCell($, cellEl) {
  const firstA = $(cellEl).find("a").first();
  if (firstA.length) {
    const t = firstA.text().trim();
    if (t) return t;
  }
  let name = "";
  $(cellEl).contents().each((_, node) => {
    if (name) return false;
    if (node.type === "text") {
      const t = (node.data || "").trim();
      if (t) name = t;
    }
  });
  return name;
}

// ── Game cell text extractor ────────────────────────────────────────────────
// FIC game cells use <img> tags for team logos. cheerio .text() returns only "@ ".
// This walks child nodes and collects img alt (preferred) or src filename stem
// alongside literal text, producing e.g. "BOS @ NYY".
// Kept for raw today-page scraping (writeRawTablePageToNotion).

function cellText($, cellEl) {
  const parts = [];
  $(cellEl).contents().each((_, node) => {
    if (node.type === "text") {
      const t = (node.data || "").trim();
      if (t) parts.push(t);
    } else if (node.type === "tag" && node.name === "img") {
      const el = $(node);
      const alt = (el.attr("alt") || "").trim();
      if (alt) { parts.push(alt); return; }
      const src = (el.attr("src") || "").trim();
      if (src) {
        const stem = src.split("/").pop().split(".")[0];
        if (stem) parts.push(stem.toUpperCase());
      }
    } else {
      const t = $(node).text().trim();
      if (t) parts.push(t);
    }
  });
  return parts.join(" ").replace(/\s+/g, " ").trim();
}

// ── Browserless helper ───────────────────────────────────────────────────────

async function fetchRenderedHtml(url) {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: "table", timeout: 20000 },
      rejectResourceTypes: ["image", "font", "media"],
    },
    {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      timeout: 40000,
      responseType: "text",
    }
  );
  return response.data;
}

// ── HTML table → row-array parser ──────────────────────────────────────────────
// Uses cellText() for all cells so img alt/src values are captured.

function parseHtmlTable($, tableEl) {
  const rows = [];
  $(tableEl).find("tr").each((_, tr) => {
    const cells = [];
    $(tr).find("th, td").each((_, cell) => {
      cells.push(cellText($, cell));
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

// ── Rich table parser — for normalizers that need per-cell cheerio access ────────
// Returns rows as arrays of cheerio cell elements (not text strings),
// so normalizers can call playerNameFromCell() on the name column.

function parseHtmlTableRich($, tableEl) {
  const rows = [];
  $(tableEl).find("tr").each((_, tr) => {
    const cells = [];
    $(tr).find("th, td").each((_, cell) => {
      cells.push(cell);
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

async function scrapeTablesFromUrl(url) {
  const html = await fetchRenderedHtml(url);
  const $ = cheerio.load(html);
  const tables = [];
  $("table").each((_, tableEl) => {
    const textRows = parseHtmlTable($, tableEl);
    const richRows = parseHtmlTableRich($, tableEl);
    if (textRows.length > 1) tables.push({ textRows, richRows, $ });
  });
  return tables;
}

// ── Column finder ────────────────────────────────────────────────────────────────

function findCol(header, matchers) {
  return header.findIndex((h) => {
    const lh = h.toLowerCase().trim();
    return matchers.some((m) =>
      typeof m === "function" ? m(lh) : lh === m || lh.startsWith(m) || lh.includes(m)
    );
  });
}

// ── BVP normalizer ────────────────────────────────────────────────────────────
// Uses name-only keys (e.g. "m betts") — no team prefix.
// FIC gives the matchup (BOS @ NYY) not the player's actual team, so team-prefixed
// keys were unreliable. Name-only is unambiguous in practice.

function normalizeBvpTables(tables) {
  const seen = new Set();
  const out = [];

  for (const { textRows, richRows, $ } of tables) {
    if (!textRows || textRows.length < 2) continue;
    const header = textRows[0].map((h) => h.toLowerCase().trim());

    const iName = findCol(header, [
      "batter", "player", "hitter", "name",
      (h) => h.startsWith("batter") || h.startsWith("player") || h.startsWith("hitter"),
    ]);
    if (iName === -1) {
      console.log("[fic] BVP: skipping table — no name column. Headers:", header);
      continue;
    }

    // Use exact-match lambda for AB — the old "ab" string matched "qab%" via includes,
    // and "#ab" string still matched "#ab%" (a QAB%-formatted column on fIC). Exact only.
    const iAb  = findCol(header, ["at bats", "atbats", (h) => h === "ab" || h === "#ab" || h === "# ab"]);
    const iQab = findCol(header, ["qab%", "qab #", "qab", (h) => h.startsWith("qab")]);
    const iHh  = findCol(header, ["hh%", "hh", "hard hit%", "hard hit", (h) => h.includes("hh") || h.includes("hard hit")]);
    const iHrf = findCol(header, ["hrf", "hr/f", "hr f", "hrfb", "hr f%", (h) => h.startsWith("hrf") || h.startsWith("hr/f") || h.startsWith("hr f")]);

    console.log(`[fic] BVP table (${textRows.length - 1} rows): name:${iName} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

    for (let i = 1; i < richRows.length; i++) {
      const richRow = richRows[i];
      const textRow = textRows[i];

      const rawName = playerNameFromCell($, richRow[iName]);
      if (!rawName) continue;

      const key = normalizeName(rawName);
      if (!key) continue;

      if (seen.has(key)) continue;
      seen.add(key);

      out.push([
        key,
        iAb  >= 0 ? (textRow[iAb]  || "") : "",
        iQab >= 0 ? (textRow[iQab] || "") : "",
        iHh  >= 0 ? (textRow[iHh]  || "") : "",
        iHrf >= 0 ? (textRow[iHrf] || "") : "",
      ]);
    }
  }

  console.log(`[fic] BVP normalized: ${out.length} rows`);
  return out;
}

// ── SB normalizer ─────────────────────────────────────────────────────────────
// Same approach: name-only keys, no team prefix.

function normalizeSbTables(tables) {
  const seen = new Set();
  const out = [];

  for (const { textRows, richRows, $ } of tables) {
    if (!textRows || textRows.length < 2) continue;
    const header = textRows[0].map((h) => h.toLowerCase().trim());

    const iName = findCol(header, [
      "player", "batter", "hitter", "name", "runner",
      (h) => h.startsWith("player") || h.startsWith("batter") || h.startsWith("hitter"),
    ]);
    if (iName === -1) {
      console.log("[fic] SB: skipping table — no name column. Headers:", header);
      continue;
    }

    const iSb = findCol(header, [
      "sb%", "steal%", "sb probability", "steal probability",
      (h) => h.includes("sb") || h.includes("steal") || h.includes("prob"),
    ]);
    if (iSb === -1) {
      console.log("[fic] SB: skipping table — no SB% column. Headers:", header);
      continue;
    }

    console.log(`[fic] SB table (${textRows.length - 1} rows): name:${iName} sb:${iSb}`);

    for (let i = 1; i < richRows.length; i++) {
      const richRow = richRows[i];
      const textRow = textRows[i];

      const rawName = playerNameFromCell($, richRow[iName]);
      if (!rawName) continue;

      const key = normalizeName(rawName);
      if (!key) continue;

      if (seen.has(key)) continue;
      seen.add(key);

      out.push([key, textRow[iSb] || ""]);
    }
  }

  console.log(`[fic] SB normalized: ${out.length} rows`);
  return out;
}

// ── Timestamp helper ─────────────────────────────────────────────────────────

function getMtTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

// ── Write normalized table to Notion ──────────────────────────────────────────

async function writeNormalizedTableToNotion(pageId, label, date, columns, rows, sourceUrl) {
  const ts = getMtTimestamp();
  const headerLines = [
    label,
    `Date: ${date}`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
    `Columns: ${columns.join(" | ")}`,
  ];
  if (!rows || rows.length === 0) {
    await overwritePageWithTable(pageId, headerLines, columns, [["(no data)", ...Array(columns.length - 1).fill("")]]);
    return;
  }
  await overwritePageWithTable(pageId, headerLines, columns, rows);
}

// ── Write raw scraped tables to Notion (today pages) ──────────────────────────

async function writeRawTablePageToNotion(pageId, label, date, tables, sourceUrl) {
  const ts = getMtTimestamp();
  const headerLines = [
    label,
    `Date: ${date}`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];
  const textTables = tables.map((t) => t.textRows);
  if (!textTables || textTables.length === 0) {
    await overwritePageWithTable(pageId, headerLines, ["(no data)"], []);
    return;
  }
  if (textTables.length === 1) {
    const [header, ...dataRows] = textTables[0];
    await overwritePageWithTable(pageId, headerLines, header, dataRows);
  } else {
    const maxCols = Math.max(...textTables.map((t) => (t[0] || []).length));
    function padRow(row, len) {
      const r = [...row];
      while (r.length < len) r.push("");
      return r;
    }
    const unifiedHeader = padRow(textTables[0][0], maxCols);
    const allDataRows = [];
    textTables.forEach((tableRows, idx) => {
      const [, ...dataRows] = tableRows;
      if (idx > 0) {
        allDataRows.push(padRow([], maxCols));
        allDataRows.push(padRow([`── Table ${idx + 1} ──`], maxCols));
      }
      for (const row of dataRows) allDataRows.push(padRow(row, maxCols));
    });
    await overwritePageWithTable(pageId, headerLines, unifiedHeader, allDataRows);
  }
}

// ── Public sync functions ────────────────────────────────────────────────────

export async function runBvpTodaySync() {
  const date = todayDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeRawTablePageToNotion(FIC_BVP_TODAY_PAGE_ID, "Batter vs Pitcher — Today", date, tables, url);
  await logRun({ name: `FIC BvP Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.textRows.length, 0) };
}

export async function runBvpTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const normalizedRows = normalizeBvpTables(tables);
  await writeNormalizedTableToNotion(
    FIC_BVP_TOMORROW_PAGE_ID,
    "Batter vs Pitcher — Tomorrow",
    date,
    BVP_COLUMNS,
    normalizedRows,
    url
  );
  await logRun({ name: `FIC BvP Tomorrow (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, normalizedRows: normalizedRows.length };
}

export async function runSbTodaySync() {
  const date = todayDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeRawTablePageToNotion(FIC_SB_TODAY_PAGE_ID, "Steal Probability — Today", date, tables, url);
  await logRun({ name: `FIC SB Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.textRows.length, 0) };
}

export async function runSbTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const normalizedRows = normalizeSbTables(tables);
  await writeNormalizedTableToNotion(
    FIC_SB_TOMORROW_PAGE_ID,
    "Steal Probability — Tomorrow",
    date,
    SB_COLUMNS,
    normalizedRows,
    url
  );
  await logRun({ name: `FIC SB Tomorrow (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, normalizedRows: normalizedRows.length };
}

export async function runAllFicSyncs() {
  const [bvpToday, bvpTomorrow, sbToday, sbTomorrow] = await Promise.allSettled([
    runBvpTodaySync(),
    runBvpTomorrowSync(),
    runSbTodaySync(),
    runSbTomorrowSync(),
  ]);
  return { bvpToday, bvpTomorrow, sbToday, sbTomorrow };
}
