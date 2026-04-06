// rotowire-projected.js
// Scrapes tomorrow's PROJECTED lineups from Rotowire and enriches each batter with:
//   • Free Agent flag (from Yahoo status=A pool)
//   • Last-7-days OPS (Yahoo stat ID 55, type=lastweek)
//   • BVP stats: AB, QAB, HH%, HRF (from FantasyInfoCentral tomorrow BVP table)
//   • SB% (from FantasyInfoCentral tomorrow SB predictions table)
//
// Player matching across all three sources uses a normalized name key.

import axios from "axios";
import * as cheerio from "cheerio";
import { Client as NotionClient } from "@notionhq/client";
import { parseStringPromise } from "xml2js";
import {
  NOTION_TOKEN,
  NOTION_PROJECTED_LINEUP_PAGE_ID,
  BROWSERLESS_TOKEN,
  YAHOO_LEAGUE_KEY,
  requireEnv,
} from "./config.js";
import { yahooFantasyGetXml } from "./yahoo.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_PROJECTED_LINEUP_PAGE_ID", NOTION_PROJECTED_LINEUP_PAGE_ID);
requireEnv("BROWSERLESS_TOKEN", BROWSERLESS_TOKEN);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);

const notion = new NotionClient({ auth: NOTION_TOKEN });

const ROTOWIRE_TOMORROW_URL =
  "https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow";
const FIC_BVP_BASE = "https://www.fantasyinfocentral.com/mlb/daily-matchups";
const FIC_SB_BASE  = "https://www.fantasyinfocentral.com/betting/mlb/sb-predictions";

// ---------------------------------------------------------------------------
// DATE HELPER
// ---------------------------------------------------------------------------

function getMtDate(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/Denver" });
}

// ---------------------------------------------------------------------------
// NAME NORMALIZATION  (used to match players across Rotowire, Yahoo, FIC)
// ---------------------------------------------------------------------------

function normalizeName(name) {
  return name
    .toLowerCase()
    // strip accents / diacritics
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    // strip non-alpha except spaces
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// BROWSER HELPER
// ---------------------------------------------------------------------------

async function getRenderedHtml(url) {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: "table, .lineup__player", timeout: 20000 },
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

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function getAttr(tagHtml, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  return tagHtml.match(re)?.[1] ?? null;
}

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function parseXml(xml) {
  return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

// ---------------------------------------------------------------------------
// PARSE ONE ROTOWIRE LINEUP LIST
// ---------------------------------------------------------------------------

function parseList(listHtml) {
  const status = /class="[^"]*lineup__status[^"]*is-confirmed[^"]*"/.test(listHtml)
    ? "confirmed"
    : "projected";

  // SP
  let sp = null;
  const spLiMatch = listHtml.match(
    /<li[^>]+class="[^"]*lineup__player-highlight[^"]*"[^>]*>([\s\S]*?)<\/li>/
  );
  if (spLiMatch) {
    const spBlock = spLiMatch[1];
    const aMatch = spBlock.match(/<a([^>]*)>([^<]+)<\/a>/);
    if (aMatch) {
      const title = getAttr(aMatch[1], "title");
      const name = (title || aMatch[2]).trim();
      const throwsMatch = spBlock.match(
        /<span[^>]+class="[^"]*lineup__throws[^"]*"[^>]*>([^<]+)<\/span>/
      );
      const throws = throwsMatch?.[1]?.trim() ?? "";
      if (name) sp = { name, throws };
    }
  }

  // Batters
  const liRe =
    /<li[^>]+class="[^"]*\blineup__player\b(?!-highlight)[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  const players = [];
  let li;
  let order = 1;
  while ((li = liRe.exec(listHtml)) !== null) {
    const liContent = li[1];
    const posMatch = liContent.match(
      /<div[^>]+class="[^"]*lineup__pos[^"]*"[^>]*>([^<]+)<\/div>/
    );
    const position = posMatch?.[1]?.trim() ?? "";
    const aMatch = liContent.match(/<a([^>]+)>([^<]+)<\/a>/);
    if (!aMatch) continue;
    const title = getAttr(aMatch[1], "title");
    const name = (title || aMatch[2]).trim();
    if (!name) continue;
    const batsMatch = liContent.match(
      /<span[^>]+class="[^"]*lineup__bats[^"]*"[^>]*>([^<]+)<\/span>/
    );
    const bats = batsMatch?.[1]?.trim() ?? "";
    players.push({ order, position, name, bats });
    order++;
  }

  return { status, sp, players };
}

// ---------------------------------------------------------------------------
// SCRAPE ROTOWIRE TOMORROW
// ---------------------------------------------------------------------------

async function scrapeTomorrowLineups() {
  const html = await getRenderedHtml(ROTOWIRE_TOMORROW_URL);
  const games = [];

  const gameCardRe =
    /<div[^>]+class="[^"]*lineup is-mlb[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*lineup is-mlb|<\/section|$)/g;
  let cardMatch;

  while ((cardMatch = gameCardRe.exec(html)) !== null) {
    const card = cardMatch[1];

    const abbrRe = /<div[^>]+class="[^"]*lineup__abbr[^"]*"[^>]*>([^<]+)<\/div>/g;
    const abbrs = [...card.matchAll(abbrRe)];
    const awayTeam = abbrs[0]?.[1]?.trim() ?? "AWAY";
    const homeTeam = abbrs[1]?.[1]?.trim() ?? "HOME";
    if (awayTeam === "AWAY" && homeTeam === "HOME") continue;

    const timeMatch = card.match(
      /<div[^>]+class="[^"]*lineup__time[^"]*"[^>]*>([^<]+)<\/div>/
    );
    const gameTime = timeMatch?.[1]?.trim() ?? "";

    const listRe = /<ul[^>]+class="[^"]*lineup__list[^"]*"[^>]*>([\s\S]*?)<\/ul>/g;
    const lists = [...card.matchAll(listRe)];

    const awayLineup = lists[0]
      ? parseList(lists[0][1])
      : { status: "projected", sp: null, players: [] };
    const homeLineup = lists[1]
      ? parseList(lists[1][1])
      : { status: "projected", sp: null, players: [] };

    games.push({ awayTeam, homeTeam, gameTime, awayLineup, homeLineup });
  }

  return { scrapedAt: new Date().toISOString(), games };
}

// ---------------------------------------------------------------------------
// YAHOO: FREE AGENTS (batters only, status=A)
// ---------------------------------------------------------------------------

async function fetchFreeAgentNameSet() {
  const pageSize = 25;
  const target = 500; // top 500 batters by OR rank is more than enough
  const nameSet = new Set();

  let start = 0;
  while (nameSet.size < target) {
    const remaining = target - nameSet.size;
    const count = Math.min(pageSize, remaining);

    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;status=A;position=B;sort=OR;start=${start};count=${count}`
    );
    const parsed = await parseXml(xml);
    const players = asArray(parsed?.fantasy_content?.league?.players?.player);
    if (!players.length) break;

    for (const pl of players) {
      const full = pl?.name?.full || "";
      if (full) nameSet.add(normalizeName(full));
    }

    if (players.length < count) break; // pool exhausted
    start += pageSize;
  }

  console.log(`[projected-lineup] Free agent name set: ${nameSet.size} batters`);
  return nameSet;
}

// ---------------------------------------------------------------------------
// YAHOO: LAST-7-DAYS OPS (stat ID 55)
// ---------------------------------------------------------------------------

async function fetchLast7OpsMap() {
  // Fetch top 500 players by OR rank (all, status=A includes everyone)
  // then grab their lastweek stats. We only need stat 55 (OPS).
  const pageSize = 25;
  const target = 500;
  const playerKeys = [];
  let start = 0;

  while (playerKeys.length < target) {
    const remaining = target - playerKeys.length;
    const count = Math.min(pageSize, remaining);
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;status=A;position=B;sort=OR;start=${start};count=${count}`
    );
    const parsed = await parseXml(xml);
    const players = asArray(parsed?.fantasy_content?.league?.players?.player);
    if (!players.length) break;
    for (const pl of players) {
      if (pl?.player_key) playerKeys.push({ key: pl.player_key, name: pl?.name?.full || "" });
    }
    if (players.length < count) break;
    start += pageSize;
  }

  // Batch fetch lastweek stats in groups of 25
  const opsMap = {}; // normalizedName → OPS string

  for (let i = 0; i < playerKeys.length; i += 25) {
    const batch = playerKeys.slice(i, i + 25);
    const keysCsv = batch.map((b) => b.key).join(",");
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${keysCsv}/stats;type=lastweek`
    );
    const parsed = await parseXml(xml);
    const players = asArray(parsed?.fantasy_content?.league?.players?.player);

    for (const pl of players) {
      const full = pl?.name?.full || "";
      if (!full) continue;
      const stats = asArray(pl?.player_stats?.stats?.stat);
      for (const s of stats) {
        if (String(s?.stat_id) === "55") {
          opsMap[normalizeName(full)] = s?.value ?? "";
          break;
        }
      }
    }
  }

  console.log(`[projected-lineup] L7 OPS map: ${Object.keys(opsMap).length} players`);
  return opsMap;
}

// ---------------------------------------------------------------------------
// FIC: SCRAPE HTML TABLE → row array
// ---------------------------------------------------------------------------

async function scrapeFicTable(url) {
  const html = await getRenderedHtml(url);
  const $ = cheerio.load(html);
  const tables = [];
  $("table").each((_, tableEl) => {
    const rows = [];
    $(tableEl).find("tr").each((_, tr) => {
      const cells = [];
      $(tr).find("th, td").each((_, cell) => cells.push($(cell).text().trim()));
      if (cells.length) rows.push(cells);
    });
    if (rows.length > 1) tables.push(rows);
  });
  return tables;
}

// ---------------------------------------------------------------------------
// FIC: BVP MAP  → normalizedName → { ab, qab, hhPct, hrf }
//
// Expected FIC BVP table columns (based on fantasyinfocentral daily-matchups):
//   Batter | Pitcher | AB | QAB | HH% | HRF | ...
// Column indices may vary — we detect by header row.
// ---------------------------------------------------------------------------

async function fetchBvpMap() {
  const date = getMtDate(1);
  const url = `${FIC_BVP_BASE}?date=${date}`;
  const tables = await scrapeFicTable(url);
  const bvpMap = {};

  for (const tableRows of tables) {
    if (tableRows.length < 2) continue;
    const header = tableRows[0].map((h) => h.toLowerCase().trim());

    // Find column indices
    const iName   = header.findIndex((h) => h === "batter" || h === "player" || h === "name");
    const iAb     = header.findIndex((h) => h === "ab");
    const iQab    = header.findIndex((h) => h === "qab");
    const iHh     = header.findIndex((h) => h.includes("hh"));
    const iHrf    = header.findIndex((h) => h === "hrf" || h.includes("hr"));

    if (iName === -1) continue; // not the BVP table

    for (const row of tableRows.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;
      const key = normalizeName(rawName);
      bvpMap[key] = {
        ab:    iAb  >= 0 ? (row[iAb]  || "") : "",
        qab:   iQab >= 0 ? (row[iQab] || "") : "",
        hhPct: iHh  >= 0 ? (row[iHh]  || "") : "",
        hrf:   iHrf >= 0 ? (row[iHrf] || "") : "",
      };
    }
  }

  console.log(`[projected-lineup] BVP map: ${Object.keys(bvpMap).length} players`);
  return bvpMap;
}

// ---------------------------------------------------------------------------
// FIC: SB MAP  → normalizedName → sbPct string
//
// Expected FIC SB table columns:
//   Player | Team | Opp | SB% | ...
// ---------------------------------------------------------------------------

async function fetchSbMap() {
  const date = getMtDate(1);
  const url = `${FIC_SB_BASE}?date=${date}`;
  const tables = await scrapeFicTable(url);
  const sbMap = {};

  for (const tableRows of tables) {
    if (tableRows.length < 2) continue;
    const header = tableRows[0].map((h) => h.toLowerCase().trim());

    const iName = header.findIndex((h) => h === "player" || h === "batter" || h === "name");
    const iSb   = header.findIndex((h) => h.includes("sb") || h.includes("steal"));

    if (iName === -1 || iSb === -1) continue;

    for (const row of tableRows.slice(1)) {
      const rawName = row[iName] || "";
      if (!rawName) continue;
      sbMap[normalizeName(rawName)] = row[iSb] || "";
    }
  }

  console.log(`[projected-lineup] SB map: ${Object.keys(sbMap).length} players`);
  return sbMap;
}

// ---------------------------------------------------------------------------
// ENRICH PLAYERS
// ---------------------------------------------------------------------------

function enrichPlayer(player, faSet, opsMap, bvpMap, sbMap) {
  const key = normalizeName(player.name);
  const bvp = bvpMap[key] || null;
  return {
    ...player,
    isFreeAgent: faSet.has(key),
    ops7:   opsMap[key] ?? "",
    bvpAb:  bvp?.ab    ?? "",
    bvpQab: bvp?.qab   ?? "",
    bvpHh:  bvp?.hhPct ?? "",
    bvpHrf: bvp?.hrf   ?? "",
    sbPct:  sbMap[key] ?? "",
  };
}

// ---------------------------------------------------------------------------
// FORMAT
// ---------------------------------------------------------------------------

function formatPlayerLine(p) {
  const fa    = p.isFreeAgent ? " 🟢FA" : "";
  const ops   = p.ops7   ? ` | L7 OPS: ${p.ops7}` : "";
  const bvp   = (p.bvpAb || p.bvpQab || p.bvpHh || p.bvpHrf)
    ? ` | BVP: ${[
        p.bvpAb  ? `${p.bvpAb} AB`  : "",
        p.bvpQab ? `QAB ${p.bvpQab}` : "",
        p.bvpHh  ? `HH% ${p.bvpHh}` : "",
        p.bvpHrf ? `HRF ${p.bvpHrf}` : "",
      ].filter(Boolean).join(", ")}`
    : "";
  const sb    = p.sbPct ? ` | SB% ${p.sbPct}` : "";

  return `  ${String(p.order).padStart(2)}. ${p.position.padEnd(3)} ${p.name}${p.bats ? ` (${p.bats})` : ""}${fa}${ops}${bvp}${sb}`;
}

function formatLineupSide(label, lineup) {
  const statusLabel =
    lineup.status === "confirmed" ? "✅ CONFIRMED" : "🕒 PROJECTED";
  const spLine = lineup.sp
    ? `  SP: ${lineup.sp.name}${lineup.sp.throws ? ` (${lineup.sp.throws})` : ""}`
    : "  SP: TBD";
  const playerLines = lineup.players.length
    ? lineup.players.map(formatPlayerLine)
    : ["  (no lineup posted)"];
  return [`${label} — ${statusLabel}`, spLine, ...playerLines].join("\n");
}

function formatSnapshot(snapshot) {
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

  const ts = new Date(snapshot.scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const lines = [
    `MLB Projected Lineups — ${dateStr}`,
    `(pulled ${ts} MT)`,
    `${snapshot.games.length} games scheduled`,
    `Legend: 🟢FA = Free Agent | L7 OPS = Last 7 days | BVP = vs tomorrow's pitcher (AB/QAB/HH%/HRF) | SB% = steal probability`,
    "",
  ];

  for (const game of snapshot.games) {
    lines.push(`▶ ${game.awayTeam} @ ${game.homeTeam}  |  ${game.gameTime}`);
    lines.push(formatLineupSide(game.awayTeam, game.awayLineup));
    lines.push("");
    lines.push(formatLineupSide(game.homeTeam, game.homeLineup));
    lines.push("");
    lines.push("─".repeat(60));
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// NOTION HELPERS
// ---------------------------------------------------------------------------

async function listAllChildBlocks(blockId) {
  let cursor;
  const all = [];
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    all.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return all;
}

async function archiveBlocks(blocks) {
  const batchSize = 10;
  for (let i = 0; i < blocks.length; i += batchSize) {
    await Promise.all(
      blocks
        .slice(i, i + batchSize)
        .map((b) => notion.blocks.update({ block_id: b.id, in_trash: true }))
    );
  }
}

function splitIntoParagraphChunks(text, maxLen = 1900) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > maxLen) {
      if (current.trim()) chunks.push(current.trimEnd());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

async function writePageContent(pageId, markdown) {
  const existing = await listAllChildBlocks(pageId);
  if (existing.length) await archiveBlocks(existing);

  const chunks = splitIntoParagraphChunks(markdown);
  const children = chunks.map((chunk) => ({
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: chunk } }],
    },
  }));

  const batchSize = 20;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + batchSize),
    });
  }
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function runProjectedLineupSync() {
  console.log("[projected-lineup] Starting enriched tomorrow lineup sync...");

  // 1) Scrape Rotowire lineups first (critical path)
  const snapshot = await scrapeTomorrowLineups();

  if (!snapshot.games.length) {
    console.warn("[projected-lineup] No games found — nothing written to Notion.");
    return { games: 0 };
  }
  console.log(`[projected-lineup] Found ${snapshot.games.length} games from Rotowire.`);

  // 2) Fetch enrichment data in parallel (independent sources)
  console.log("[projected-lineup] Fetching FA list, L7 OPS, BVP, and SB% in parallel...");
  const [faSet, opsMap, bvpMap, sbMap] = await Promise.all([
    fetchFreeAgentNameSet().catch((e) => {
      console.error("[projected-lineup] FA fetch failed:", e.message);
      return new Set();
    }),
    fetchLast7OpsMap().catch((e) => {
      console.error("[projected-lineup] L7 OPS fetch failed:", e.message);
      return {};
    }),
    fetchBvpMap().catch((e) => {
      console.error("[projected-lineup] BVP fetch failed:", e.message);
      return {};
    }),
    fetchSbMap().catch((e) => {
      console.error("[projected-lineup] SB fetch failed:", e.message);
      return {};
    }),
  ]);

  // 3) Enrich each batter in every lineup
  for (const game of snapshot.games) {
    game.awayLineup.players = game.awayLineup.players.map((p) =>
      enrichPlayer(p, faSet, opsMap, bvpMap, sbMap)
    );
    game.homeLineup.players = game.homeLineup.players.map((p) =>
      enrichPlayer(p, faSet, opsMap, bvpMap, sbMap)
    );
  }

  // 4) Format and write to Notion
  console.log(`[projected-lineup] Writing enriched lineups to Notion page ${NOTION_PROJECTED_LINEUP_PAGE_ID}...`);
  const markdown = formatSnapshot(snapshot);
  await writePageContent(NOTION_PROJECTED_LINEUP_PAGE_ID, markdown);

  console.log("[projected-lineup] Done.");
  return { games: snapshot.games.length };
}
