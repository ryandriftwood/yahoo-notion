// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages using native Notion tables.
//
// Both sites use a ?date=YYYY-MM-DD query param to select the day.
// No tab/DOM detection needed — we compute today and tomorrow in MT and build the URL.

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

// ── Date helpers (Mountain Time) ─────────────────────────────────────────────

// Returns "YYYY-MM-DD" for today or tomorrow in America/Denver.
function getMtDate(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // en-CA gives YYYY-MM-DD
}

export function todayDate()    { return getMtDate(0); }
export function tomorrowDate() { return getMtDate(1); }

function buildUrl(base, date) {
  return `${base}?date=${date}`;
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

// ── Generic HTML table → row-array parser ────────────────────────────────────

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

// Scrape all tables from a fully-rendered URL
async function scrapeTablesFromUrl(url) {
  const html = await fetchRenderedHtml(url);
  const $ = cheerio.load(html);
  const tables = [];
  $("table").each((_, tableEl) => {
    const rows = parseHtmlTable($, tableEl);
    if (rows.length > 1) tables.push(rows); // skip empty/single-row tables
  });
  return tables;
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

// ── Write scraped tables to a Notion page ────────────────────────────────────
//
// Each scraped HTML table becomes its own native Notion table block.
// The first row of each scraped table is treated as the header row (columns).
// If there are multiple tables, a heading paragraph precedes each one.

async function writeTablePageToNotion(pageId, label, date, tables, sourceUrl) {
  const ts = getMtTimestamp();

  const headerLines = [
    label,
    `Date: ${date}`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  if (!tables || tables.length === 0) {
    // Write a single empty-state table with one column so notiontables still renders
    await overwritePageWithTable(pageId, headerLines, ["(no data)"], []);
    return;
  }

  // For a single table, write directly.
  // For multiple tables, prefix each with a label row via headerLines extension.
  if (tables.length === 1) {
    const [header, ...dataRows] = tables[0];
    await overwritePageWithTable(pageId, headerLines, header, dataRows);
  } else {
    // Write all tables sequentially. We wipe the page on the first call,
    // then append for subsequent tables by writing them one at a time.
    // notiontables.overwritePageWithTable wipes then writes, so we handle
    // multi-table ourselves: write the first table (wipes page), then
    // append remaining tables as additional overwritePageWithTable calls
    // would re-wipe. Instead, we concatenate all tables with separator rows.
    //
    // Strategy: pass all data as one large table set, with separator header
    // lines injected between tables. Since overwritePageWithTable supports
    // headerLines, we write each table separately using a helper that only
    // appends (not wipes) after the first. We do this by writing one table
    // at a time but chaining through the existing append logic.
    //
    // Simplest robust approach: write the first table (wipes page cleanly),
    // then for each subsequent table, call overwritePageWithTable with empty
    // headerLines=[] but note it will re-wipe. So instead we combine all rows
    // across tables using a blank "separator row" between them, under a unified
    // column schema derived from the widest table.

    // Find the max column count across all tables
    const maxCols = Math.max(...tables.map((t) => (t[0] || []).length));

    // Pad all rows to maxCols so column widths are consistent
    function padRow(row, len) {
      const r = [...row];
      while (r.length < len) r.push("");
      return r;
    }

    // Use the header from the first table, padded
    const unifiedHeader = padRow(tables[0][0], maxCols);

    const allDataRows = [];
    tables.forEach((tableRows, idx) => {
      const [header, ...dataRows] = tableRows;

      // Insert a visible section label row before each table (except the first)
      if (idx > 0) {
        // Blank separator row
        allDataRows.push(padRow([], maxCols));
        // Label row in first cell
        const labelRow = padRow([`── Table ${idx + 1} ──`], maxCols);
        allDataRows.push(labelRow);
      }

      for (const row of dataRows) {
        allDataRows.push(padRow(row, maxCols));
      }
    });

    await overwritePageWithTable(pageId, headerLines, unifiedHeader, allDataRows);
  }
}

// ── Public sync functions ────────────────────────────────────────────────────

export async function runBvpTodaySync() {
  const date = todayDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeTablePageToNotion(FIC_BVP_TODAY_PAGE_ID, "Batter vs Pitcher — Today", date, tables, url);
  await logRun({ name: `FIC BvP Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runBvpTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeTablePageToNotion(FIC_BVP_TOMORROW_PAGE_ID, "Batter vs Pitcher — Tomorrow", date, tables, url);
  await logRun({ name: `FIC BvP Tomorrow (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTodaySync() {
  const date = todayDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeTablePageToNotion(FIC_SB_TODAY_PAGE_ID, "Steal Probability — Today", date, tables, url);
  await logRun({ name: `FIC SB Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  await writeTablePageToNotion(FIC_SB_TOMORROW_PAGE_ID, "Steal Probability — Tomorrow", date, tables, url);
  await logRun({ name: `FIC SB Tomorrow (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

// ── Combined: all four at once ────────────────────────────────────────────────

export async function runAllFicSyncs() {
  const [bvpToday, bvpTomorrow, sbToday, sbTomorrow] = await Promise.allSettled([
    runBvpTodaySync(),
    runBvpTomorrowSync(),
    runSbTodaySync(),
    runSbTomorrowSync(),
  ]);
  return { bvpToday, bvpTomorrow, sbToday, sbTomorrow };
}
