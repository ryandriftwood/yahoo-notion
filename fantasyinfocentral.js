// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages.

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

const notion = new NotionClient({ auth: NOTION_TOKEN });

const BVP_URL = "https://www.fantasyinfocentral.com/mlb/daily-matchups";
const SB_URL = "https://www.fantasyinfocentral.com/betting/mlb/sb-predictions";

// ── Browserless helper ───────────────────────────────────────────────────────

async function fetchRenderedHtml(url, waitForSelector) {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: waitForSelector, timeout: 20000 },
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

// ── BVP scraper ──────────────────────────────────────────────────────────────
// The page renders two tab panels: today and tomorrow.
// We parse all <table> elements and pair them with their nearest heading/tab label.

export async function scrapeBvpTables() {
  const html = await fetchRenderedHtml(BVP_URL, "table");
  const $ = cheerio.load(html);

  // Collect tables with their preceding heading text
  const results = { today: [], tomorrow: [] };

  // The site uses tab panels or section headings to separate today/tomorrow.
  // Strategy: walk all tables; use surrounding context to classify.
  // Look for a parent element whose text contains "Today" or "Tomorrow".

  $('table').each((_, tableEl) => {
    const tableHtml = $.html(tableEl);
    // Walk up the DOM to find a section label
    let label = "today"; // default
    let el = $(tableEl);
    for (let i = 0; i < 10; i++) {
      el = el.parent();
      const parentText = el.attr('id') || el.attr('class') || "";
      if (/tomorrow/i.test(parentText)) { label = "tomorrow"; break; }
      if (/today/i.test(parentText)) { label = "today"; break; }
      // Also check headings just before this ancestor
      const prevHeading = el.prevAll('h1,h2,h3,h4,h5').first().text();
      if (/tomorrow/i.test(prevHeading)) { label = "tomorrow"; break; }
      if (/today/i.test(prevHeading)) { label = "today"; break; }
    }
    results[label].push(parseHtmlTable($, tableEl));
  });

  return results;
}

// ── SB scraper ───────────────────────────────────────────────────────────────

export async function scrapeSbTables() {
  const html = await fetchRenderedHtml(SB_URL, "table");
  const $ = cheerio.load(html);

  const results = { today: [], tomorrow: [] };

  $('table').each((_, tableEl) => {
    let label = "today";
    let el = $(tableEl);
    for (let i = 0; i < 10; i++) {
      el = el.parent();
      const parentText = el.attr('id') || el.attr('class') || "";
      if (/tomorrow/i.test(parentText)) { label = "tomorrow"; break; }
      if (/today/i.test(parentText)) { label = "today"; break; }
      const prevHeading = el.prevAll('h1,h2,h3,h4,h5').first().text();
      if (/tomorrow/i.test(prevHeading)) { label = "tomorrow"; break; }
      if (/today/i.test(prevHeading)) { label = "today"; break; }
    }
    results[label].push(parseHtmlTable($, tableEl));
  });

  return results;
}

// ── Generic HTML table → row-array parser ───────────────────────────────────

function parseHtmlTable($, tableEl) {
  const rows = [];
  $(tableEl).find('tr').each((_, tr) => {
    const cells = [];
    $(tr).find('th, td').each((_, cell) => {
      cells.push($(cell).text().trim());
    });
    if (cells.length) rows.push(cells);
  });
  return rows;
}

// ── Format rows as plain-text table ─────────────────────────────────────────

function formatTableAsText(rows) {
  if (!rows || rows.length === 0) return "(no data)";

  // Compute column widths
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

// ── Format multiple tables into a markdown page ──────────────────────────────

function buildPageMarkdown(label, tables, sourceUrl) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  const lines = [
    `${label}`,
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

// ── Public sync functions (called by index.js routes) ────────────────────────

export async function runBvpTodaySync() {
  const { today } = await scrapeBvpTables();
  const md = buildPageMarkdown("Batter vs Pitcher — Today", today, BVP_URL);
  await overwritePageWithMarkdown(FIC_BVP_TODAY_PAGE_ID, md);
  await logRun({ name: `FIC BvP Today sync — ${new Date().toISOString()}` });
  return { rows: today.reduce((s, t) => s + t.length, 0) };
}

export async function runBvpTomorrowSync() {
  const { tomorrow } = await scrapeBvpTables();
  const md = buildPageMarkdown("Batter vs Pitcher — Tomorrow", tomorrow, BVP_URL);
  await overwritePageWithMarkdown(FIC_BVP_TOMORROW_PAGE_ID, md);
  await logRun({ name: `FIC BvP Tomorrow sync — ${new Date().toISOString()}` });
  return { rows: tomorrow.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTodaySync() {
  const { today } = await scrapeSbTables();
  const md = buildPageMarkdown("Steal Probability — Today", today, SB_URL);
  await overwritePageWithMarkdown(FIC_SB_TODAY_PAGE_ID, md);
  await logRun({ name: `FIC SB Today sync — ${new Date().toISOString()}` });
  return { rows: today.reduce((s, t) => s + t.length, 0) };
}

export async function runSbTomorrowSync() {
  const { tomorrow } = await scrapeSbTables();
  const md = buildPageMarkdown("Steal Probability — Tomorrow", tomorrow, SB_URL);
  await overwritePageWithMarkdown(FIC_SB_TOMORROW_PAGE_ID, md);
  await logRun({ name: `FIC SB Tomorrow sync — ${new Date().toISOString()}` });
  return { rows: tomorrow.reduce((s, t) => s + t.length, 0) };
}

// ── Combined helper: run all four at once ─────────────────────────────────────

export async function runAllFicSyncs() {
  const [bvpToday, bvpTomorrow, sbToday, sbTomorrow] = await Promise.allSettled([
    runBvpTodaySync(),
    runBvpTomorrowSync(),
    runSbTodaySync(),
    runSbTomorrowSync(),
  ]);
  return { bvpToday, bvpTomorrow, sbToday, sbTomorrow };
}
