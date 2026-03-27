// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages.
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
import { overwritePageWithMarkdown, logRun } from "./notion.js";

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
  // Shift by offset days in ms, then format in MT
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

// ── Format rows as plain-text table ──────────────────────────────────────────

function formatTableAsText(rows) {
  if (!rows || rows.length === 0) return "(no data)";

  const colCount = Math.max(...rows.map((r) => r.length));
  const widths = Array(colCount).fill(0);
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, String(cell).length);
    });
  }

  const lines = rows.map((row, ri) => {
    const padded = row.map((cell, i) => String(cell).padEnd(widths[i] || 0));
    const line = "| " + padded.join(" | ") + " |";
    if (ri === 0) {
      const sep = "|" + widths.map((w) => "-".repeat(w + 2)).join("|") + "|";
      return line + "\n" + sep;
    }
    return line;
  });

  return lines.join("\n");
}

// ── Build Notion page markdown ────────────────────────────────────────────────

function buildPageMarkdown(label, date, tables, sourceUrl) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  const lines = [
    label,
    `Date: ${date}`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
    "",
  ];

  if (!tables || tables.length === 0) {
    lines.push("(no tables found)");
  } else {
    tables.forEach((rows, idx) => {
      if (tables.length > 1) lines.push(`Table ${idx + 1}`);
      lines.push(formatTableAsText(rows));
      lines.push("");
    });
  }

  return lines.join("\n");
}

// ── Public sync functions ────────────────────────────────────────────────────

export async function runBvpTodaySync() {
  const date = todayDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const md = buildPageMarkdown("Batter vs Pitcher — Today", date, tables, url);
  await overwritePageWithMarkdown(FIC_BVP_TODAY_PAGE_ID, md);
  await logRun({ name: `FIC BvP Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runBvpTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(BVP_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const md = buildPageMarkdown("Batter vs Pitcher — Tomorrow", date, tables, url);
  await overwritePageWithMarkdown(FIC_BVP_TOMORROW_PAGE_ID, md);
  await logRun({ name: `FIC BvP Tomorrow (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTodaySync() {
  const date = todayDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const md = buildPageMarkdown("Steal Probability — Today", date, tables, url);
  await overwritePageWithMarkdown(FIC_SB_TODAY_PAGE_ID, md);
  await logRun({ name: `FIC SB Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTomorrowSync() {
  const date = tomorrowDate();
  const url  = buildUrl(SB_BASE, date);
  const tables = await scrapeTablesFromUrl(url);
  const md = buildPageMarkdown("Steal Probability — Tomorrow", date, tables, url);
  await overwritePageWithMarkdown(FIC_SB_TOMORROW_PAGE_ID, md);
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
