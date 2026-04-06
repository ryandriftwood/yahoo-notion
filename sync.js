// sync.js
import {
  YAHOO_TEAM_KEYS_JSON,
  YAHOO_LEAGUE_KEY,
  YAHOO_FREE_AGENTS_COUNT,
  NOTION_ROSTERS_PAGE_ID,
  NOTION_FREE_AGENTS_PAGE_ID,
  FIC_BVP_TODAY_PAGE_ID,
  FIC_SB_TODAY_PAGE_ID,
  NOTION_TOKEN,
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
// NAME NORMALIZATION + MAP LOOKUPS
// Identical to rotowire-projected.js so BVP/SB keys match.
//
// FIC stores player names in abbreviated form: "M. Betts"
// normalizeName("M. Betts") => "m betts"
// Roster full names: normalizeName("Mookie Betts") => "mookie betts"
// initialLastKey("mookie betts") => "m betts"  ← matches FIC key
// So lookupMap always tries full key first, then initial+last fallback.
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

// Try full normalized name first, then initial+last abbreviation fallback.
// e.g. lookupMap(map, "mookie betts") tries "mookie betts", then "m betts"
function lookupMap(map, key) {
  if (map[key] !== undefined) return map[key];
  return map[initialLastKey(key)];
}

// SB% map may use team-prefixed keys; fall back to name-only.
function lookupMapWithTeam(map, key, team) {
  if (team) {
    const t = team.toLowerCase();
    if (map[`${t}:${initialLastKey(key)}`] !== undefined) return map[`${t}:${initialLastKey(key)}`];
    if (map[`${t}:${key}`] !== undefined) return map[`${t}:${key}`];
  }
  return lookupMap(map, key);
}

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function parseXml(xml) {
  return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

// ---------------------------------------------------------------------------
// FLEXIBLE COLUMN FINDER
// Ported from fantasyinfocentral.js — handles raw FIC header variants.
// ---------------------------------------------------------------------------

function findCol(header, matchers) {
  return header.findIndex((h) => {
    const lh = h.toLowerCase().trim();
    return matchers.some((m) =>
      typeof m === "function" ? m(lh) : lh === m || lh.startsWith(m) || lh.includes(m)
    );
  });
}

// ---------------------------------------------------------------------------
// NOTION TABLE READER
// ---------------------------------------------------------------------------

async function readNotionTableRows(pageId) {
  let cursor;
  const allBlocks = [];
  while (true) {
    const resp = await notion.blocks.children.list({ block_id: pageId, start_cursor: cursor, page_size: 100 });
    allBlocks.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  const tableBlocks = allBlocks.filter((b) => b.type === "table");
  if (!tableBlocks.length) { console.warn(`[sync] No table found in Notion page ${pageId}`); return []; }
  let bestRows = [];
  for (const tb of tableBlocks) {
    let rowCursor;
    const rowBlocks = [];
    while (true) {
      const resp = await notion.blocks.children.list({ block_id: tb.id, start_cursor: rowCursor, page_size: 100 });
      rowBlocks.push(...resp.results);
      if (!resp.has_more) break;
      rowCursor = resp.next_cursor;
    }
    if (rowBlocks.length > bestRows.length) bestRows = rowBlocks;
  }
  return bestRows.map((row) =>
    (row.table_row?.cells || []).map((cell) =>
      cell.map((rt) => rt.plain_text ?? rt?.text?.content ?? "").join("")
    )
  );
}

// ---------------------------------------------------------------------------
// BVP MAP — today's matchups (FIC_BVP_TODAY_PAGE_ID)
//
// Today's page is written by writeRawTablePageToNotion (raw FIC scrape),
// so headers are whatever FIC uses natively — NOT the fixed normalized schema.
// We use findCol() with flexible matchers, same as fantasyinfocentral.js does
// when normalizing tomorrow's data.
//
// Player keys stored as normalizeName(rawFicName), e.g. "m betts".
// lookupMap() matches these via initialLastKey fallback on roster full names.
// ---------------------------------------------------------------------------

async function fetchBvpMap() {
  if (!FIC_BVP_TODAY_PAGE_ID) { console.warn("[sync] FIC_BVP_TODAY_PAGE_ID not set — skipping BVP."); return {}; }
  const rows = await readNotionTableRows(FIC_BVP_TODAY_PAGE_ID);
  if (rows.length < 2) { console.warn("[sync] BVP table empty."); return {}; }

  const header = rows[0].map((x) => x.trim());
  console.log("[sync] BVP raw headers:", header);

  // Flexible column matching — mirrors fantasyinfocentral.js normalizeBvpTables()
  const iName = findCol(header, [
    "batter", "player", "hitter", "name",
    (h) => h.startsWith("batter") || h.startsWith("player") || h.startsWith("hitter"),
  ]);
  if (iName === -1) { console.warn("[sync] BVP: no name column found. Headers:", header); return {}; }

  const iAb  = findCol(header, ["#ab", "at bats", "atbats", (h) => h === "ab" || h === "#ab"]);
  const iQab = findCol(header, ["qab%", "qab #", "qab", (h) => h.startsWith("qab")]);
  const iHh  = findCol(header, ["hh%", "hh", "hard hit%", "hard hit", (h) => h.includes("hh") || h.includes("hard hit")]);
  const iHrf = findCol(header, ["hrf", "hr/f", "hr f", "hrfb", (h) => h.startsWith("hrf") || h.startsWith("hr/f")]);

  console.log(`[sync] BVP cols — name:${iName} ab:${iAb} qab:${iQab} hh:${iHh} hrf:${iHrf}`);

  const map = {};
  for (const row of rows.slice(1)) {
    const rawName = row[iName]?.trim();
    if (!rawName) continue;
    const key = normalizeName(rawName);  // e.g. "m betts" — matches via initialLastKey fallback
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
// SB MAP — today's matchups (FIC_SB_TODAY_PAGE_ID)
//
// Same situation as BVP: raw FIC headers, flexible column matching.
// ---------------------------------------------------------------------------

async function fetchSbMap() {
  if (!FIC_SB_TODAY_PAGE_ID) { console.warn("[sync] FIC_SB_TODAY_PAGE_ID not set — skipping SB%."); return {}; }
  const rows = await readNotionTableRows(FIC_SB_TODAY_PAGE_ID);
  if (rows.length < 2) { console.warn("[sync] SB table empty."); return {}; }

  const header = rows[0].map((x) => x.trim());
  console.log("[sync] SB raw headers:", header);

  // Flexible column matching — mirrors fantasyinfocentral.js normalizeSbTables()
  const iName = findCol(header, [
    "player", "batter", "hitter", "name", "runner",
    (h) => h.startsWith("player") || h.startsWith("batter") || h.startsWith("hitter"),
  ]);
  if (iName === -1) { console.warn("[sync] SB: no name column found. Headers:", header); return {}; }

  const iSb = findCol(header, [
    "sb%", "steal%", "sb probability", "steal probability",
    (h) => h.includes("sb") || h.includes("steal") || h.includes("prob"),
  ]);
  if (iSb === -1) { console.warn("[sync] SB: no SB% column found. Headers:", header); return {}; }

  console.log(`[sync] SB cols — name:${iName} sb:${iSb}`);

  const map = {};
  for (const row of rows.slice(1)) {
    const rawName = row[iName]?.trim();
    if (!rawName) continue;
    const key = normalizeName(rawName);  // e.g. "m betts"
    if (!key) continue;
    map[key] = row[iSb] || "";
  }
  console.log(`[sync] SB map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// YAHOO: 7-DAY OPS  (stat ID 55, type=lastweek)
// Rolling last-7-days OPS — different from season OPS below
// ---------------------------------------------------------------------------

async function fetch7DayOpsMap(playerKeys) {
  const map = {};
  for (let i = 0; i < playerKeys.length; i += 25) {
    const csv = playerKeys.slice(i, i + 25).join(",");
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${csv}/stats;type=lastweek`
    );
    const parsed = await parseXml(xml);
    for (const pl of asArray(parsed?.fantasy_content?.league?.players?.player)) {
      const full = pl?.name?.full || "";
      if (!full) continue;
      for (const s of asArray(pl?.player_stats?.stats?.stat)) {
        if (String(s?.stat_id) === "55") { map[normalizeName(full)] = s?.value ?? ""; break; }
      }
    }
  }
  console.log(`[sync] 7-day OPS map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// YAHOO: SEASON OPS  (stat ID 55, no type param = season-to-date default)
// Full season accumulation — different from 7-day OPS above
// ---------------------------------------------------------------------------

async function fetchSeasonOpsMap(playerKeys) {
  const map = {};
  for (let i = 0; i < playerKeys.length; i += 25) {
    const csv = playerKeys.slice(i, i + 25).join(",");
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${csv}/stats`
    );
    const parsed = await parseXml(xml);
    for (const pl of asArray(parsed?.fantasy_content?.league?.players?.player)) {
      const full = pl?.name?.full || "";
      if (!full) continue;
      for (const s of asArray(pl?.player_stats?.stats?.stat)) {
        if (String(s?.stat_id) === "55") { map[normalizeName(full)] = s?.value ?? ""; break; }
      }
    }
  }
  console.log(`[sync] Season OPS map: ${Object.keys(map).length} players`);
  return map;
}

// ---------------------------------------------------------------------------
// FORMAT ENRICHED PLAYER LINE
// Input string format from parseTeamRoster: "Name — POS (ELIG) — TEAM"
// Enrichment appended in brackets.
// ---------------------------------------------------------------------------

function formatEnrichedPlayerLine(playerStr, ops7day, opsSeason, bvp, sbPct) {
  const parts = [];
  if (ops7day)   parts.push(`7-day OPS: ${ops7day}`);
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
// MAIN ENTRY POINT  (original structure preserved exactly)
// ---------------------------------------------------------------------------

export async function runSync() {
  // Mountain Time (America/Denver), human readable
  const started = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  // 1) Rosters (10 teams) — identical to original
  //    Also collect player_key + mlbTeam in the same loop for stat lookups.
  const rosterResults = [];
  const rosterPlayerKeys = [];  // [player_key string, ...]
  const rosterPlayerTeam = {};  // normalizedName → mlbTeam
  const seenKeys = new Set();

  for (const tk of teamKeys()) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
    const parsed = await parseTeamRoster(xml);
    rosterResults.push(parsed);

    // Re-parse the same XML to extract player_key + mlbTeam (no extra fetch)
    const rawParsed = await parseXml(xml);
    const players = asArray(rawParsed?.fantasy_content?.team?.roster?.players?.player);
    for (const pl of players) {
      const key = pl?.player_key || null;
      if (!key || seenKeys.has(key)) continue;
      seenKeys.add(key);
      rosterPlayerKeys.push(key);
      const name = normalizeName(pl?.name?.full || "");
      if (name) rosterPlayerTeam[name] = pl?.editorial_team_abbr || "";
    }
  }

  // 2) Fetch all enrichment data in parallel — graceful fallback to {} on any failure
  console.log("[sync] Fetching 7-day OPS, season OPS, BVP, SB% in parallel...");
  const [ops7DayMap, opsSeasonMap, bvpMap, sbMap] = await Promise.all([
    fetch7DayOpsMap(rosterPlayerKeys).catch((e) => { console.error("[sync] 7-day OPS failed:", e.message); return {}; }),
    fetchSeasonOpsMap(rosterPlayerKeys).catch((e) => { console.error("[sync] Season OPS failed:", e.message); return {}; }),
    fetchBvpMap().catch((e) => { console.error("[sync] BVP failed:", e.message); return {}; }),
    fetchSbMap().catch((e) => { console.error("[sync] SB% failed:", e.message); return {}; }),
  ]);

  // 3) Free agents — identical to original
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
        console.log(`[${position}] Pool exhausted at ${collected.length} players (empty page at start=${start}). Moving on.`);
        break;
      }
      collected = collected.concat(page);
      if (page.length < count) {
        console.log(`[${position}] Pool exhausted at ${collected.length} players (partial page: got ${page.length}/${count}). Moving on.`);
        break;
      }
      start += pageSize;
    }
    return collected.slice(0, target);
  }

  const hitters = await fetchTopForPosition("B", hittersTarget);
  console.log(`Hitters collected: ${hitters.length}`);

  const pitchers = await fetchTopForPosition("P", pitchersTarget);
  console.log(`Pitchers collected: ${pitchers.length}`);

  const freeAgents = [...hitters, ...pitchers];
  const total = freeAgents.length;

  // 4) Build enriched roster markdown + write to Notion
  //
  // Player strings from parseTeamRoster: "Mookie Betts — OF (OF, 1B) — LAD"
  // Name extracted by splitting on em-dash; mlbTeam from rosterPlayerTeam map.
  const legend = "Legend: 7-day OPS = last 7 days | Season OPS = season to date | BVP = vs today's pitcher (#AB, QAB%, HH%, HRF) | SB% = steal probability";

  const rostersMd =
    `Rosters sync\nLast synced: ${started}\n${legend}\n\n` +
    rosterResults
      .map((t) => {
        const header = `${t.team_name || t.team_key}`;
        const lines = (t.players || []).map((p) => {
          const nameOnly = p.split(" \u2014 ")[0].trim();  // split on em-dash "\u2014"
          const key = normalizeName(nameOnly);
          const mlbTeam  = rosterPlayerTeam[key] || "";
          const ops7day  = lookupMap(ops7DayMap, key) || "";
          const opsSeason= lookupMap(opsSeasonMap, key) || "";
          const bvp      = lookupMap(bvpMap, key) || null;
          const sbPct    = lookupMapWithTeam(sbMap, key, mlbTeam) || "";
          return `- ${formatEnrichedPlayerLine(p, ops7day, opsSeason, bvp, sbPct)}`;
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
