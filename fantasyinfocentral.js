// fantasyinfocentral.js
// Scrapes FantasyInfoCentral daily matchups (batter vs pitcher) and SB predictions,
// then overwrites the corresponding Notion landing pages using native Notion tables.
//
// BVP tomorrow and SB tomorrow pages are written with a NORMALIZED, FIXED schema
// so that rotowire-projected.js can do exact header matching:
//   BVP:  Player | #AB | QAB% | HH% | HRF
//   SB:   Player | SB%
//
// Player keys are stored as BOTH "awayteam:normalizedname" AND "hometeam:normalizedname"
// (e.g. "bos:m betts" and "nyy:m betts") so that rotowire-projected.js can match
// regardless of which side of the @ the batter is on.
// The name-only key is also stored as a final fallback.
//
// FIC team columns use <img> tags (team logos) rather than text for team abbreviations.
// cellText() extracts img alt/src values alongside text nodes so the game cell
// produces a usable string like "BOS @ NYY" instead of just "@ ".

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

// ── Team key helper ───────────────────────────────────────────────────────────
// Extracts BOTH team abbreviations from a FIC game cell string.
// Works with any format: "BOS@NYY", "BOS @ NYY", "@ NYY", etc.

function teamsFromGame(gameCell) {
  if (!gameCell) return [];
  const parts = gameCell.trim().split("@").map((p) => p.trim().toLowerCase());
  return parts
    .map((p) => p.replace(/[^a-z]/g, "").slice(0, 3))
    .filter((p) => p.length >= 2);
}

// ── Smart cell text extractor ────────────────────────────────────────────────
// FIC uses <img> tags for team logos in the game/matchup column.
// cheerio's .text() skips images entirely, giving "@ " instead of "BOS @ NYY".
// This helper walks the cell's child nodes in order, collecting:
//   - text nodes (trimmed)
//   - <img> alt attribute (preferred), falling back to the filename in src
//     (e.g. src="/images/teams/bos.png" → "bos")
// The result is joined with spaces and collapsed, producing e.g. "BOS @ NYY".

function cellText($, cellEl) {
  const parts = [];

  $(cellEl).contents().each((_, node) => {
    if (node.type === "text") {
      const t = (node.data || "").trim();
      if (t) parts.push(t);
    } else if (node.type === "tag" && node.name === "img") {
      const el = $(node);
      // Prefer alt text ("BOS", "NYY", etc.)
      const alt = (el.attr("alt") || "").trim();
      if (alt) {
        parts.push(alt);
        return;
      }
      // Fall back to filename stem from src (e.g. "/img/mlb/teams/bos.png" → "bos")
      const src = (el.attr("src") || "").trim();
      if (src) {
        const stem = src.split("/").pop().split(".")[0];
        if (stem) parts.push(stem.toUpperCase());
      }
    } else {
      // For any other inline element (span, a, etc.) recurse via text()
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
// Uses cellText() instead of .text() so img alt/src values are included.

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

function normalizeBvpTables(tables) {
  const seen = new Set();
  const out = [];

  for (const table of tables) {
    if (!table || table.length < 2) continue;
    const rawHeader = table[0];
    const header = rawHeader.map((h) => h.toLowerCase().trim());

    const iName = findCol(header, [
      "batter", "player", "hitter", "name",
      (h) => h.startsWith("batter") || h.startsWith("player") || h.startsWith("hitter"),
    ]);
    if (iName === -1) {
      console.log("[fic] BVP: skipping table — no name column. Headers:", header);
      continue;
    }

    const iGame = findCol(header, [
      "game", "matchup", "match",
      (h) => h.startsWith("game") || h.startsWith("matchup"),
    ]);

    const iAb  = findCol(header, ["#ab", "ab#", "ab", "at bats", "atbats", (h) => h === "ab"]);
    const iQab = findCol(header, ["qab%", "qab #", "qab", (h) => h.startsWith("qab")]);
    const iHh  = findCol(header, ["hh%", "hh", "hard hit%", "hard hit", (h) => h.includes("hh") || h.includes("hard hit")]);
    const iHrf = findCol(header, ["hrf", "hr/f", "hr f", "hrfb", "hr f%", (h) => h.startsWith("hrf") || h.startsWith("hr/f") || h.startsWith("hr f")]);

    console.log(`[fic] BVP table (${table.length - 1} data rows): name:${iName} game:${iGame} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

    for (const row of table.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;

      const normalized = normalizeName(rawName);
      if (!normalized) continue;

      const statCols = [
        iAb  >= 0 ? (row[iAb]  || "") : "",
        iQab >= 0 ? (row[iQab] || "") : "",
        iHh  >= 0 ? (row[iHh]  || "") : "",
        iHrf >= 0 ? (row[iHrf] || "") : "",
      ];

      const gameRaw = iGame >= 0 ? (row[iGame] || "") : "";
      const teams = teamsFromGame(gameRaw);
      console.log(`[fic] BVP: "${normalized}" game:"${gameRaw}" teams:[${teams.join(",")}]`);

      const keys = [
        ...teams.map((t) => `${t}:${normalized}`),
        normalized, // name-only fallback always stored
      ];

      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([key, ...statCols]);
      }
    }
  }

  console.log(`[fic] BVP normalized: ${out.length} keys across all players/tables`);
  return out;
}

// ── SB normalizer ─────────────────────────────────────────────────────────────

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

    const iGame = findCol(header, [
      "game", "matchup", "match",
      (h) => h.startsWith("game") || h.startsWith("matchup"),
    ]);

    const iSb = findCol(header, [
      "sb%", "steal%", "sb probability", "steal probability",
      (h) => h.includes("sb") || h.includes("steal") || h.includes("prob"),
    ]);
    if (iSb === -1) {
      console.log("[fic] SB: skipping table — no SB% column. Headers:", header);
      continue;
    }

    console.log(`[fic] SB table (${table.length - 1} data rows): name:${iName} game:${iGame} sb:${iSb}`);

    for (const row of table.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;

      const normalized = normalizeName(rawName);
      if (!normalized) continue;

      const sbVal = row[iSb] || "";
      const gameRaw = iGame >= 0 ? (row[iGame] || "") : "";
      const teams = teamsFromGame(gameRaw);

      const keys = [
        ...teams.map((t) => `${t}:${normalized}`),
        normalized,
      ];

      for (const key of keys) {
        if (seen.has(key)) continue;
        seen.add(key);
        out.push([key, sbVal]);
      }
    }
  }

  console.log(`[fic] SB normalized: ${out.length} keys across all players/tables`);
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
  await writeRawTablePageToNotion(FIC_BVP_TODAY_PAGE_ID, "Batter vs Pitcher — Today", date, tables, url);
  await logRun({ name: `FIC BvP Today (${date}) — ${new Date().toISOString()}` });
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
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
  return { date, tables: tables.length, rows: tables.reduce((s, t) => s + t.length, 0) };
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
