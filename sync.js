// sync.js
// Syncs current rosters + free agents to Notion.
// Rosters are enriched with:
//   • Last-7-days OPS   (Yahoo stat ID 55, type=lastweek)
//   • Season OPS        (Yahoo stat ID 55, season default)
//   • BVP: #AB, QAB%, HH%, HRF  (read from FIC_BVP_TODAY_PAGE_ID Notion table)
//   • SB%               (read from FIC_SB_TODAY_PAGE_ID Notion table)
//
// BVP and SB% Notion pages are written by fantasyinfocentral.js.
// Fixed schema (exact column headers, player keys are pre-normalized names):
//   BVP: Player | #AB | QAB% | HH% | HRF
//   SB:  Player | SB%

import {
  YAHOO_TEAM_KEYS_JSON,
  YAHOO_LEAGUE_KEY,
  YAHOO_FREE_AGENTS_COUNT,
  NOTION_ROSTERS_PAGE_ID,
  NOTION_FREE_AGENTS_PAGE_ID,
  NOTION_TOKEN,
  FIC_BVP_TODAY_PAGE_ID,
  FIC_SB_TODAY_PAGE_ID,
  requireEnv,
} from "./config.js";
import { yahooFantasyGetXml } from "./yahoo.js";
import { parseTeamRoster, parseFreeAgents } from "./parseYahoo.js";
import {
  overwritePageWithMarkdown,
  overwritePageWithNumberedList,
  logRun,
} from "./notion.js";
import { Client as NotionClient } from "@notionhq/client";
import { parseStringPromise } from "xml2js";

requireEnv("NOTION_ROSTERS_PAGE_ID", NOTION_ROSTERS_PAGE_ID);
requireEnv("NOTION_FREE_AGENTS_PAGE_ID", NOTION_FREE_AGENTS_PAGE_ID);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("YAHOO_TEAM_KEYS_JSON", YAHOO_TEAM_KEYS_JSON);

const notion = new NotionClient({ auth: NOTION_TOKEN });

function teamKeys() {
  const arr = JSON.parse(YAHOO_TEAM_KEYS_JSON);
  if (!Array.isArray(arr) || arr.length === 0)
    throw new Error("YAHOO_TEAM_KEYS_JSON must be a JSON array of team keys");
  return arr;
}

// ---------------------------------------------------------------------------
// HELPERS
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

function initialLastKey(n) {
  const parts = n.split(" ");
  if (parts.length < 2) return n;
  return `${parts[0][0]} ${parts.slice(1).join(" ")}`;
}

function lookupMap(map, key) {
  if (map[key] !== undefined) return map[key];
  return map[initialLastKey(key)];
}

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function parseXml(xml) {
  return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

// ---------------------------------------------------------------------------
// NOTION TABLE READER  (identical to rotowire-projected.js)
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
    console.warn(`[sync] No table block found in Notion page ${pageId}`);
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

  console.log(`[sync] Notion page ${pageId}: ${tableBlocks.length} table(s), largest has ${bestRows.length} rows`);

  return bestRows.map((row) =>
    (row.table_row?.cells || []).map((cell) =>
      cell.map((rt) => rt.plain_text ?? rt?.text?.content ?? "").join("")
    )
  );
}

// ---------------------------------------------------------------------------
// BVP MAP — today (FIC_BVP_TODAY_PAGE_ID)
// Fixed schema: Player | #AB | QAB% | HH% | HRF
// ---------------------------------------------------------------------------

async function fetchBvpMap() {
  if (!FIC_BVP_TODAY_PAGE_ID) {
    console.warn("[sync] FIC_BVP_TODAY_PAGE_ID not set — skipping BVP.");
    return {};
  }
  const rows = await readNotionTableRows(FIC_BVP_TODAY_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[sync] BVP table empty or missing.");
    return {};
  }

  const header = rows[0].map((h) => h.trim());
  console.log("[sync] BVP headers:", header);

  const iName = header.indexOf("Player");
  const iAb   = header.indexOf("#AB");
  const iQab  = header.indexOf("QAB%");
  const iHh   = header.indexOf("HH%");
  const iHrf  = header.indexOf("HRF");

  if (iName === -1) {
    console.warn("[sync] BVP table missing 'Player' column. Headers:", header);
    return {};
  }

  console.log(`[sync] BVP indices — name:${iName} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

  const map = {};
  for (const row of rows.slice(1)) {
    const key = row[iName]?.trim();
    if (!key) continue;
    map[key] = {
      ab:    iAb  >= 0 ? (row[iAb]  || "") : "",
      qab:   iQab >= 0 ? (row[iQab] || "") : "",
      hhPct: iHh  >= 0 ? (row[iHh]  || "") : "",
      hrf:   iHrf >= 0 ? (row[iHrf] || "") : "",
    };
  }

  console.log(`[sync] BVP map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// SB MAP — today (FIC_SB_TODAY_PAGE_ID)
// Fixed schema: Player | SB%
// ---------------------------------------------------------------------------

async function fetchSbMap() {
  if (!FIC_SB_TODAY_PAGE_ID) {
    console.warn("[sync] FIC_SB_TODAY_PAGE_ID not set — skipping SB%.");
    return {};
  }
  const rows = await readNotionTableRows(FIC_SB_TODAY_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[sync] SB table empty or missing.");
    return {};
  }

  const header = rows[0].map((h) => h.trim());
  console.log("[sync] SB headers:", header);

  const iName = header.indexOf("Player");
  const iSb   = header.indexOf("SB%");

  if (iName === -1 || iSb === -1) {
    console.warn("[sync] SB table missing expected columns. Headers:", header);
    return {};
  }

  const map = {};
  for (const row of rows.slice(1)) {
    const key = row[iName]?.trim();
    if (!key) continue;
    map[key] = row[iSb] || "";
  }

  console.log(`[sync] SB map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// YAHOO: COLLECT ROSTER PLAYER KEYS
// ---------------------------------------------------------------------------

async function collectRosterPlayerKeys() {
  const keys = [];
  const seen = new Set();
  for (const tk of teamKeys()) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster/players`);
    const parsed = await parseXml(xml);
    // fantasy_content.team may be array or object depending on Yahoo response shape
    const teamNode = parsed?.fantasy_content?.team;
    const teamObj  = Array.isArray(teamNode)
      ? teamNode.find((t) => t?.roster)
      : teamNode;
    for (const pl of asArray(teamObj?.roster?.players?.player)) {
      const key = pl?.player_key || pl?.player_keys?.player_key;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      keys.push(key);
    }
  }
  console.log(`[sync] Roster player keys collected: ${keys.length}`);
  return keys;
}

// ---------------------------------------------------------------------------
// YAHOO: L7 OPS  (stat ID 55, type=lastweek)
// ---------------------------------------------------------------------------

async function fetchL7OpsMap(playerKeys) {
  const map = {};
  for (let i = 0; i < playerKeys.length; i += 25) {
    const batch = playerKeys.slice(i, i + 25);
    try {
      const xml = await yahooFantasyGetXml(
        `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${batch.join(",")}/stats;type=lastweek`
      );
      const parsed = await parseXml(xml);
      for (const pl of asArray(parsed?.fantasy_content?.league?.players?.player)) {
        const full = pl?.name?.full || "";
        if (!full) continue;
        for (const s of asArray(pl?.player_stats?.stats?.stat)) {
          if (String(s?.stat_id) === "55") { map[normalizeName(full)] = s?.value ?? ""; break; }
        }
      }
    } catch (e) {
      console.error(`[sync] L7 OPS batch ${i} failed:`, e.message);
    }
  }
  console.log(`[sync] L7 OPS map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// YAHOO: SEASON OPS  (stat ID 55, season default)
// ---------------------------------------------------------------------------

async function fetchSeasonOpsMap(playerKeys) {
  const map = {};
  for (let i = 0; i < playerKeys.length; i += 25) {
    const batch = playerKeys.slice(i, i + 25);
    try {
      const xml = await yahooFantasyGetXml(
        `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${batch.join(",")}/stats`
      );
      const parsed = await parseXml(xml);
      for (const pl of asArray(parsed?.fantasy_content?.league?.players?.player)) {
        const full = pl?.name?.full || "";
        if (!full) continue;
        for (const s of asArray(pl?.player_stats?.stats?.stat)) {
          if (String(s?.stat_id) === "55") { map[normalizeName(full)] = s?.value ?? ""; break; }
        }
      }
    } catch (e) {
      console.error(`[sync] Season OPS batch ${i} failed:`, e.message);
    }
  }
  console.log(`[sync] Season OPS map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// FORMAT ENRICHED PLAYER LINE
// ---------------------------------------------------------------------------

function formatPlayerLine(playerStr, ops7, opsSeason, bvp, sbPct) {
  const parts = [];
  if (ops7)      parts.push(`L7 OPS: ${ops7}`);
  if (opsSeason) parts.push(`Season OPS: ${opsSeason}`);
  const bvpParts = [
    bvp?.ab    ? `${bvp.ab} AB`     : "",
    bvp?.qab   ? `QAB% ${bvp.qab}` : "",
    bvp?.hhPct ? `HH% ${bvp.hhPct}`: "",
    bvp?.hrf   ? `HRF ${bvp.hrf}`  : "",
  ].filter(Boolean);
  if (bvpParts.length) parts.push(`BVP: ${bvpParts.join(", ")}`);
  if (sbPct) parts.push(`SB% ${sbPct}`);
  return parts.length ? `${playerStr} [${parts.join(" | ")}]` : playerStr;
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function runSync() {
  const started = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  // 1) Rosters
  const rosterResults = [];
  for (const tk of teamKeys()) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
    const parsed = await parseTeamRoster(xml);
    rosterResults.push(parsed);
  }

  // 2) Collect roster player keys for stat lookups
  const rosterPlayerKeys = await collectRosterPlayerKeys();

  // 3) Fetch enrichment data in parallel — all fault-tolerant
  console.log("[sync] Fetching L7 OPS, season OPS, BVP, SB% in parallel...");
  const [l7OpsMap, seasonOpsMap, bvpMap, sbMap] = await Promise.all([
    rosterPlayerKeys.length
      ? fetchL7OpsMap(rosterPlayerKeys).catch((e) => { console.error("[sync] L7 OPS failed:", e.message); return {}; })
      : Promise.resolve({}),
    rosterPlayerKeys.length
      ? fetchSeasonOpsMap(rosterPlayerKeys).catch((e) => { console.error("[sync] Season OPS failed:", e.message); return {}; })
      : Promise.resolve({}),
    fetchBvpMap().catch((e) => { console.error("[sync] BVP failed:", e.message); return {}; }),
    fetchSbMap().catch((e) => { console.error("[sync] SB% failed:", e.message); return {}; }),
  ]);

  // 4) Free agents
  const hittersTarget = 400;
  const pitchersTarget = 600;
  const pageSize = 25;

  async function fetchFreeAgentsPage(position, start, count) {
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;status=A;position=${position};sort=OR;start=${start};count=${count}`
    );
    return parseFreeAgents(xml);
  }

  async function fetchTopForPosition(position, target) {
    let start = 0;
    let collected = [];
    while (collected.length < target) {
      const remaining = target - collected.length;
      const count = Math.min(pageSize, remaining);
      const page = await fetchFreeAgentsPage(position, start, count);
      if (!page.length) {
        console.log(`[${position}] Pool exhausted at ${collected.length} (empty page at start=${start}).`);
        break;
      }
      collected = collected.concat(page);
      if (page.length < count) {
        console.log(`[${position}] Pool exhausted at ${collected.length} (partial page: got ${page.length}/${count}).`);
        break;
      }
      start += pageSize;
    }
    return collected.slice(0, target);
  }

  const hitters  = await fetchTopForPosition("B", hittersTarget);
  console.log(`Hitters collected: ${hitters.length}`);
  const pitchers = await fetchTopForPosition("P", pitchersTarget);
  console.log(`Pitchers collected: ${pitchers.length}`);

  const freeAgents = [...hitters, ...pitchers];
  const total = freeAgents.length;

  // 5) Write enriched rosters to Notion
  const legend = "Legend: L7 OPS = last 7 days | Season OPS = season to date | BVP = vs today's pitcher (#AB, QAB%, HH%, HRF) | SB% = steal probability";

  const rostersMd =
    `Rosters sync\nLast synced: ${started}\n${legend}\n\n` +
    rosterResults
      .map((t) => {
        const header = `${t.team_name || t.team_key}`;
        const lines = (t.players || []).map((p) => {
          const key      = normalizeName(p.split(" — ")[0].trim());
          const ops7     = lookupMap(l7OpsMap,     key) || "";
          const opsSzn   = lookupMap(seasonOpsMap, key) || "";
          const bvp      = lookupMap(bvpMap,        key) || null;
          const sbPct    = lookupMap(sbMap,         key) || "";
          return `- ${formatPlayerLine(p, ops7, opsSzn, bvp, sbPct)}`;
        }).join("\n");
        return `## ${header}\n${lines}`;
      })
      .join("\n\n");

  await overwritePageWithMarkdown(NOTION_ROSTERS_PAGE_ID, rostersMd);

  await overwritePageWithNumberedList(
    NOTION_FREE_AGENTS_PAGE_ID,
    [`Free agents (${hitters.length} hitters + ${pitchers.length} pitchers = ${total} total)`, `Last synced: ${started}`],
    freeAgents
  );

  await logRun({
    name: `Sync run ${started} (teams=${rosterResults.length}, freeAgents=${total})`,
  });

  return {
    started,
    teams: rosterResults.length,
    hitters: hitters.length,
    pitchers: pitchers.length,
    freeAgents: total,
  };
}
