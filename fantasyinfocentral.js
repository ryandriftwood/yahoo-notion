// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages using native Notion tables.
//
// BVP tomorrow and SB tomorrow pages are written with a NORMALIZED, FIXED schema
// so that rotowire-projected.js can do exact header matching:
//   BVP:  Player | #AB | QAB% | HH% | HRF
//   SB:   Player | SB%

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
// These are the EXACT headers rotowire-projected.js expects to find.
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
// Matches the normalizeName() in rotowire-projected.js exactly.

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")  // strip diacritics
    .replace(/[^a-z ]/g, "")          // strip punctuation, Jr., etc.
    .replace(/\s+/g, " ")
    .trim();
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

// ── Generic HTML table → row-array parser ─────────────────────────────────────

function parseHtmlTable($, tableEl) {
  const rows = [];
  $(tableEl).find("tr").each((_, tr) => {
    const cells = [];
    $(tr).find("th, td").each((_, cell) => {
      cells.push($(cell).text().trim());
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
    const rows = parseHtmlTable($, tableEl);
    if (rows.length > 1) tables.push(rows);
  });
  return tables;
}

// ── Column finder — fuzzy match against a raw FIC header row ──────────────────
// Returns the column index for a given stat, or -1 if not found.

function findCol(header, matchers) {
  return header.findIndex((h) => {
    const lh = h.toLowerCase().trim();
    return matchers.some((m) =>
      typeof m === "function" ? m(lh) : lh === m || lh.startsWith(m) || lh.includes(m)
    );
  });
}

// ── BVP normalizer ────────────────────────────────────────────────────────────
// Takes raw scraped tables (any schema, any number of tables) and produces
// a single clean array of rows matching BVP_COLUMNS exactly.

function normalizeBvpTables(tables) {
  const seen = new Set();
  const out = [];

  for (const table of tables) {
    if (!table || table.length < 2) continue;
    const rawHeader = table[0];
    const header = rawHeader.map((h) => h.toLowerCase().trim());

    // Find player name column
    const iName = findCol(header, [
      "batter", "player", "hitter", "name",
      (h) => h.startsWith("batter") || h.startsWith("player") || h.startsWith("hitter"),
    ]);
    if (iName === -1) {
      console.log("[fic] BVP: skipping table — no name column. Headers:", header);
      continue;
    }

    // Find stat columns
    const iAb  = findCol(header, ["#ab", "ab#", "ab", "at bats", "atbats", (h) => h === "ab"]);
    const iQab = findCol(header, ["qab%", "qab #", "qab", (h) => h.startsWith("qab")]);
    const iHh  = findCol(header, ["hh%", "hh", "hard hit%", "hard hit", (h) => h.includes("hh") || h.includes("hard hit")]);
    const iHrf = findCol(header, ["hrf", "hr/f", "hr f", "hrfb", "hr f%", (h) => h.startsWith("hrf") || h.startsWith("hr/f") || h.startsWith("hr f")]);

    console.log(`[fic] BVP table (${table.length - 1} data rows): name:${iName} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

    for (const row of table.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;

      // Normalize the name for dedup and for rotowire matching
      const normalized = normalizeName(rawName);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      // Use normalized name as the stored value so rotowire-projected.js
      // can match it directly without re-normalizing the Notion cell.
      out.push([
        normalized,
        iAb  >= 0 ? (row[iAb]  || "") : "",
        iQab >= 0 ? (row[iQab] || "") : "",
        iHh  >= 0 ? (row[iHh]  || "") : "",
        iHrf >= 0 ? (row[iHrf] || "") : "",
      ]);
    }
  }

  console.log(`[fic] BVP normalized: ${out.length} unique players across all tables`);
  return out;
}

// ── SB normalizer ─────────────────────────────────────────────────────────────
// Takes raw scraped tables and produces a single clean array of rows matching
// SB_COLUMNS exactly.

function normalizeSbTables(tables) {
  const seen = new Set();
  const out = [];

  for (const table of tables) {
    if (!table || table.length < 2) continue;
    const rawHeader = table[0];
    const header = rawHeader.map((h) => h.toLowerCase().trim());

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

    console.log(`[fic] SB table (${table.length - 1} data rows): name:${iName} sb:${iSb}`);

    for (const row of table.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;

      const normalized = normalizeName(rawName);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);

      out.push([
        normalized,
        iSb >= 0 ? (row[iSb] || "") : "",
      ]);
    }
  }

  console.log(`[fic] SB normalized: ${out.length} unique players across all tables`);
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

// ── Write a NORMALIZED table to Notion ────────────────────────────────────────
// Uses a fixed column schema; passes normalized data rows directly.

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

// ── Write RAW scraped tables to Notion (today pages — unchanged behavior) ─────

async function writeRawTablePageToNotion(pageId, label, date, tables, sourceUrl) {
  const ts = getMtTimestamp();
  const headerLines = [
    label,
    `Date: ${date}`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  if (!tables || tables.length === 0) {
    await overwritePageWithTable(pageId, headerLines, ["(no data)"], []);
    return;
  }

  if (tables.length === 1) {
    const [header, ...dataRows] = tables[0];
    await overwritePageWithTable(pageId, headerLines, header, dataRows);
  } else {
    const maxCols = Math.max(...tables.map((t) => (t[0] || []).length));
    function padRow(row, len) {
      const r = [...row];
      while (r.length < len) r.push("");
      return r;
    }
    const unifiedHeader = padRow(tables[0][0], maxCols);
    const allDataRows = [];
    tables.forEach((tableRows, idx) => {
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
  // Today page: raw dump (not consumed by rotowire-projected)
  await writeRawTablePageToNotion(FIC_BVP_TODAY_PAGE_ID, "Batter vs Pitcher — Today", date, tables, url);
  await logRun({ name: `FIC BvP Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runBvpTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);

  // Normalize into fixed BVP schema for rotowire-projected.js
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
  // Today page: raw dump
  await writeRawTablePageToNotion(FIC_SB_TODAY_PAGE_ID, "Steal Probability — Today", date, tables, url);
  await logRun({ name: `FIC SB Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);

  // Normalize into fixed SB schema for rotowire-projected.js
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
