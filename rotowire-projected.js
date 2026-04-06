// rotowire-projected.js
// Scrapes tomorrow's PROJECTED lineups from Rotowire and enriches each batter with:
//   • Free Agent flag         (Yahoo status=A pool)
//   • Last-7-days OPS         (Yahoo stat ID 55, type=lastweek)
//   • BVP: AB, QAB%, HH%, HRF (read from FIC_BVP_TOMORROW_PAGE_ID Notion table)
//   • SB%                     (read from FIC_SB_TOMORROW_PAGE_ID Notion table)
//
// BVP and SB% Notion pages are written by fantasyinfocentral.js using a FIXED
// normalized schema (Player names are pre-normalized, column headers are exact):
//   BVP:  Player | #AB | QAB% | HH% | HRF
//   SB:   Player | SB%
//
// FIC stores names as abbreviated "first-initial last" (e.g. "m betts").
// Rotowire and Yahoo use full names (e.g. "mookie betts").
// lookupPlayer() tries full-name first, then falls back to "{initial} {lastName}".

import axios from "axios";
import { Client as NotionClient } from "@notionhq/client";
import { parseStringPromise } from "xml2js";
import {
  NOTION_TOKEN,
  NOTION_PROJECTED_LINEUP_PAGE_ID,
  FIC_BVP_TOMORROW_PAGE_ID,
  FIC_SB_TOMORROW_PAGE_ID,
  BROWSERLESS_TOKEN,
  YAHOO_LEAGUE_KEY,
  requireEnv,
} from "./config.js";
import { yahooFantasyGetXml } from "./yahoo.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_PROJECTED_LINEUP_PAGE_ID", NOTION_PROJECTED_LINEUP_PAGE_ID);
requireEnv("FIC_BVP_TOMORROW_PAGE_ID", FIC_BVP_TOMORROW_PAGE_ID);
requireEnv("FIC_SB_TOMORROW_PAGE_ID", FIC_SB_TOMORROW_PAGE_ID);
requireEnv("BROWSERLESS_TOKEN", BROWSERLESS_TOKEN);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);

const notion = new NotionClient({ auth: NOTION_TOKEN });

const ROTOWIRE_TOMORROW_URL =
  "https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow";

// ---------------------------------------------------------------------------
// NAME NORMALIZATION
// Strips diacritics, punctuation (Jr., accents), lowercases, collapses spaces.
// Must match the normalizeName() in fantasyinfocentral.js exactly.
// ---------------------------------------------------------------------------

function normalizeName(name) {
  return String(name || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z ]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// INITIAL+LAST KEY
// Converts a normalized full name ("mookie betts") → abbreviated key ("m betts")
// to match FIC's storage format.
// ---------------------------------------------------------------------------

function initialLastKey(normalizedFullName) {
  const parts = normalizedFullName.split(" ");
  if (parts.length < 2) return normalizedFullName; // single-word name, use as-is
  return `${parts[0][0]} ${parts.slice(1).join(" ")}`;
}

// ---------------------------------------------------------------------------
// MAP LOOKUP — full name first, then initial+last fallback
// Works for any map keyed by normalized name (BVP, SB, OPS, FA).
// ---------------------------------------------------------------------------

function lookupMap(map, normalizedFullName) {
  if (map[normalizedFullName] !== undefined) return map[normalizedFullName];
  const abbr = initialLastKey(normalizedFullName);
  return map[abbr];
}

function hasInSet(set, normalizedFullName) {
  if (set.has(normalizedFullName)) return true;
  return set.has(initialLastKey(normalizedFullName));
}

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function parseXml(xml) {
  return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

function getAttr(tagHtml, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  return tagHtml.match(re)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// NOTION TABLE READER
// Reads the largest table block from a Notion page.
// ---------------------------------------------------------------------------

async function readNotionTableRows(pageId) {
  let cursor;
  const allBlocks = [];
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: pageId,
      start_cursor: cursor,
      page_size: 100,
    });
    allBlocks.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }

  const tableBlocks = allBlocks.filter((b) => b.type === "table");
  if (!tableBlocks.length) {
    console.warn(`[projected-lineup] No table block found in Notion page ${pageId}`);
    return [];
  }

  let bestRows = [];
  for (const tableBlock of tableBlocks) {
    let rowCursor;
    const rowBlocks = [];
    while (true) {
      const resp = await notion.blocks.children.list({
        block_id: tableBlock.id,
        start_cursor: rowCursor,
        page_size: 100,
      });
      rowBlocks.push(...resp.results);
      if (!resp.has_more) break;
      rowCursor = resp.next_cursor;
    }
    if (rowBlocks.length > bestRows.length) bestRows = rowBlocks;
  }

  console.log(`[projected-lineup] Notion page ${pageId}: ${tableBlocks.length} table(s), using largest (${bestRows.length} rows)`);

  return bestRows.map((row) =>
    (row.table_row?.cells || []).map((cell) =>
      cell.map((rt) => rt.plain_text ?? rt?.text?.content ?? "").join("")
    )
  );
}

// ---------------------------------------------------------------------------
// BVP MAP
// Fixed schema: Player | #AB | QAB% | HH% | HRF
// Keys are normalized abbreviated names ("m betts") written by fantasyinfocentral.js.
// ---------------------------------------------------------------------------

async function fetchBvpMapFromNotion() {
  const rows = await readNotionTableRows(FIC_BVP_TOMORROW_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[projected-lineup] BVP Notion table is empty or missing.");
    return {};
  }

  const header = rows[0].map((h) => h.trim());
  console.log("[projected-lineup] BVP headers:", header);

  const iName = header.indexOf("Player");
  const iAb   = header.indexOf("#AB");
  const iQab  = header.indexOf("QAB%");
  const iHh   = header.indexOf("HH%");
  const iHrf  = header.indexOf("HRF");

  if (iName === -1) {
    console.warn("[projected-lineup] BVP table missing 'Player' column. Headers:", header);
    return {};
  }

  console.log(`[projected-lineup] BVP indices — name:${iName} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

  const bvpMap = {};
  for (const row of rows.slice(1)) {
    const key = row[iName]?.trim();
    if (!key) continue;
    bvpMap[key] = {
      ab:    iAb  >= 0 ? (row[iAb]  || "") : "",
      qab:   iQab >= 0 ? (row[iQab] || "") : "",
      hhPct: iHh  >= 0 ? (row[iHh]  || "") : "",
      hrf:   iHrf >= 0 ? (row[iHrf] || "") : "",
    };
  }

  console.log(`[projected-lineup] BVP map: ${Object.keys(bvpMap).length} players`);
  return bvpMap;
}

// ---------------------------------------------------------------------------
// SB MAP
// Fixed schema: Player | SB%
// ---------------------------------------------------------------------------

async function fetchSbMapFromNotion() {
  const rows = await readNotionTableRows(FIC_SB_TOMORROW_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[projected-lineup] SB Notion table is empty or missing.");
    return {};
  }

  const header = rows[0].map((h) => h.trim());
  console.log("[projected-lineup] SB headers:", header);

  const iName = header.indexOf("Player");
  const iSb   = header.indexOf("SB%");

  if (iName === -1 || iSb === -1) {
    console.warn("[projected-lineup] SB table missing expected columns. Headers:", header);
    return {};
  }

  const sbMap = {};
  for (const row of rows.slice(1)) {
    const key = row[iName]?.trim();
    if (!key) continue;
    sbMap[key] = row[iSb] || "";
  }

  console.log(`[projected-lineup] SB map: ${Object.keys(sbMap).length} players`);
  return sbMap;
}

// ---------------------------------------------------------------------------
// YAHOO: FREE AGENTS (batters only, status=A)
// ---------------------------------------------------------------------------

async function fetchFreeAgentNameSet() {
  const pageSize = 25;
  const target = 500;
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
    if (players.length < count) break;
    start += pageSize;
  }

  console.log(`[projected-lineup] Free agent name set: ${nameSet.size} batters`);
  return nameSet;
}

// ---------------------------------------------------------------------------
// YAHOO: LAST-7-DAYS OPS (stat ID 55)
// ---------------------------------------------------------------------------

async function fetchLast7OpsMap() {
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

  const opsMap = {};
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
// BROWSERLESS HELPER  (Rotowire only)
// ---------------------------------------------------------------------------

async function getRenderedHtml() {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url: ROTOWIRE_TOMORROW_URL,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: ".lineup__player", timeout: 15000 },
      rejectResourceTypes: ["image", "font", "media"],
    },
    {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      timeout: 35000,
      responseType: "text",
    }
  );
  return response.data;
}

// ---------------------------------------------------------------------------
// PARSE ONE ROTOWIRE LINEUP LIST
// ---------------------------------------------------------------------------

function parseList(listHtml) {
  const status = /class="[^"]*lineup__status[^"]*is-confirmed[^"]*"/.test(listHtml)
    ? "confirmed"
    : "projected";

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
  const html = await getRenderedHtml();
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
// ENRICH PLAYERS
// Uses lookupMap / hasInSet which try full name first, then "{initial} {last}".
// ---------------------------------------------------------------------------

function enrichPlayer(player, faSet, opsMap, bvpMap, sbMap) {
  const key = normalizeName(player.name);
  const bvp = lookupMap(bvpMap, key) || null;
  return {
    ...player,
    isFreeAgent: hasInSet(faSet, key),
    ops7:   lookupMap(opsMap, key) ?? "",
    bvpAb:  bvp?.ab    ?? "",
    bvpQab: bvp?.qab   ?? "",
    bvpHh:  bvp?.hhPct ?? "",
    bvpHrf: bvp?.hrf   ?? "",
    sbPct:  lookupMap(sbMap, key) ?? "",
  };
}

// ---------------------------------------------------------------------------
// FORMAT
// ---------------------------------------------------------------------------

function formatPlayerLine(p) {
  const fa  = p.isFreeAgent ? " 🟢FA" : "";
  const ops = p.ops7 ? ` | L7 OPS: ${p.ops7}` : "";
  const bvp = (p.bvpAb || p.bvpQab || p.bvpHh || p.bvpHrf)
    ? ` | BVP: ${[
        p.bvpAb  ? `${p.bvpAb} AB`    : "",
        p.bvpQab ? `QAB% ${p.bvpQab}` : "",
        p.bvpHh  ? `HH% ${p.bvpHh}`   : "",
        p.bvpHrf ? `HRF ${p.bvpHrf}`  : "",
      ].filter(Boolean).join(", ")}`
    : "";
  const sb = p.sbPct ? ` | SB% ${p.sbPct}` : "";
  return `  ${String(p.order).padStart(2)}. ${p.position.padEnd(3)} ${p.name}${p.bats ? ` (${p.bats})` : ""}${fa}${ops}${bvp}${sb}`;
}

function formatLineupSide(label, lineup) {
  const statusLabel = lineup.status === "confirmed" ? "✅ CONFIRMED" : "🕒 PROJECTED";
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
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  const lines = [
    `MLB Projected Lineups — ${dateStr}`,
    `(pulled ${ts} MT)`,
    `${snapshot.games.length} games scheduled`,
    `Legend: 🟢FA = Free Agent | L7 OPS = Last 7 days | BVP = vs tomorrow's pitcher (#AB/QAB%/HH%/HRF) | SB% = steal probability`,
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
// NOTION WRITE HELPERS
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
      blocks.slice(i, i + batchSize).map((b) =>
        notion.blocks.update({ block_id: b.id, in_trash: true })
      )
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
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
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

  // 1) Scrape Rotowire (critical path — if this fails, abort)
  const snapshot = await scrapeTomorrowLineups();
  if (!snapshot.games.length) {
    console.warn("[projected-lineup] No games found — nothing written to Notion.");
    return { games: 0 };
  }
  console.log(`[projected-lineup] Found ${snapshot.games.length} games from Rotowire.`);

  // 2) Fetch enrichment data in parallel — all independent, gracefully degraded
  console.log("[projected-lineup] Reading FA list, L7 OPS, BVP, and SB% in parallel...");
  const [faSet, opsMap, bvpMap, sbMap] = await Promise.all([
    fetchFreeAgentNameSet().catch((e) => {
      console.error("[projected-lineup] FA fetch failed:", e.message); return new Set();
    }),
    fetchLast7OpsMap().catch((e) => {
      console.error("[projected-lineup] L7 OPS fetch failed:", e.message); return {};
    }),
    fetchBvpMapFromNotion().catch((e) => {
      console.error("[projected-lineup] BVP Notion read failed:", e.message); return {};
    }),
    fetchSbMapFromNotion().catch((e) => {
      console.error("[projected-lineup] SB Notion read failed:", e.message); return {};
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

  // 4) Write enriched output to Notion
  console.log(`[projected-lineup] Writing to Notion page ${NOTION_PROJECTED_LINEUP_PAGE_ID}...`);
  const markdown = formatSnapshot(snapshot);
  await writePageContent(NOTION_PROJECTED_LINEUP_PAGE_ID, markdown);

  console.log("[projected-lineup] Done.");
  return { games: snapshot.games.length };
}
