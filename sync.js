// sync.js
import {
  YAHOO_TEAM_KEYS_JSON,
  YAHOO_LEAGUE_KEY,
  YAHOO_FREE_AGENTS_COUNT,
  NOTION_ROSTERS_PAGE_ID,
  NOTION_FREE_AGENTS_PAGE_ID,
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
import {
  NOTION_TOKEN,
} from "./config.js";

requireEnv("NOTION_ROSTERS_PAGE_ID", NOTION_ROSTERS_PAGE_ID);
requireEnv("NOTION_FREE_AGENTS_PAGE_ID", NOTION_FREE_AGENTS_PAGE_ID);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("YAHOO_TEAM_KEYS_JSON", YAHOO_TEAM_KEYS_JSON);

const notion = new NotionClient({ auth: NOTION_TOKEN });

// ---------------------------------------------------------------------------
// HELPERS (mirrored from rotowire-projected.js)
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

function initialLastKey(normalizedFullName) {
  const parts = normalizedFullName.split(" ");
  if (parts.length < 2) return normalizedFullName;
  return `${parts[0][0]} ${parts.slice(1).join(" ")}`;
}

function lookupMap(map, normalizedFullName) {
  if (map[normalizedFullName] !== undefined) return map[normalizedFullName];
  const abbr = initialLastKey(normalizedFullName);
  return map[abbr];
}

function lookupMapWithTeam(map, normalizedFullName, team) {
  if (team) {
    const t = team.toLowerCase();
    const abbrKey = `${t}:${initialLastKey(normalizedFullName)}`;
    if (map[abbrKey] !== undefined) return map[abbrKey];
    const fullKey = `${t}:${normalizedFullName}`;
    if (map[fullKey] !== undefined) return map[fullKey];
  }
  return lookupMap(map, normalizedFullName);
}

function asArray(x) {
  if (!x) return [];
  return Array.isArray(x) ? x : [x];
}

async function parseXml(xml) {
  return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

// ---------------------------------------------------------------------------
// NOTION TABLE READER (mirrored from rotowire-projected.js)
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

  console.log(`[sync] Notion page ${pageId}: ${tableBlocks.length} table(s), using largest (${bestRows.length} rows)`);

  return bestRows.map((row) =>
    (row.table_row?.cells || []).map((cell) =>
      cell.map((rt) => rt.plain_text ?? rt?.text?.content ?? "").join("")
    )
  );
}

// ---------------------------------------------------------------------------
// BVP MAP — today's data (FIC_BVP_TODAY_PAGE_ID)
// Fixed schema: Player | #AB | QAB% | HH% | HRF
// ---------------------------------------------------------------------------

async function fetchBvpMapFromNotion() {
  if (!FIC_BVP_TODAY_PAGE_ID) {
    console.warn("[sync] FIC_BVP_TODAY_PAGE_ID not set — skipping BVP.");
    return {};
  }
  const rows = await readNotionTableRows(FIC_BVP_TODAY_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[sync] BVP Notion table is empty or missing.");
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

  console.log(`[sync] BVP map: ${Object.keys(bvpMap).length} players`);
  return bvpMap;
}

// ---------------------------------------------------------------------------
// SB MAP — today's data (FIC_SB_TODAY_PAGE_ID)
// Fixed schema: Player | SB%
// ---------------------------------------------------------------------------

async function fetchSbMapFromNotion() {
  if (!FIC_SB_TODAY_PAGE_ID) {
    console.warn("[sync] FIC_SB_TODAY_PAGE_ID not set — skipping SB%.");
    return {};
  }
  const rows = await readNotionTableRows(FIC_SB_TODAY_PAGE_ID);
  if (rows.length < 2) {
    console.warn("[sync] SB Notion table is empty or missing.");
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

  const sbMap = {};
  for (const row of rows.slice(1)) {
    const key = row[iName]?.trim();
    if (!key) continue;
    sbMap[key] = row[iSb] || "";
  }

  console.log(`[sync] SB map: ${Object.keys(sbMap).length} players`);
  return sbMap;
}

// ---------------------------------------------------------------------------
// YAHOO: LAST-7-DAYS OPS (stat ID 55, type=lastweek)
// Fetches roster players by their player_keys
// ---------------------------------------------------------------------------

async function fetchLast7OpsMapForKeys(playerKeys) {
  const opsMap = {};
  const batchSize = 25;
  for (let i = 0; i < playerKeys.length; i += batchSize) {
    const batch = playerKeys.slice(i, i + batchSize);
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
  console.log(`[sync] L7 OPS map: ${Object.keys(opsMap).length} players`);
  return opsMap;
}

// ---------------------------------------------------------------------------
// YAHOO: SEASON OPS (stat ID 55, no type param = season default)
// ---------------------------------------------------------------------------

async function fetchSeasonOpsMapForKeys(playerKeys) {
  const opsMap = {};
  const batchSize = 25;
  for (let i = 0; i < playerKeys.length; i += batchSize) {
    const batch = playerKeys.slice(i, i + batchSize);
    const keysCsv = batch.map((b) => b.key).join(",");
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;player_keys=${keysCsv}/stats`
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
  console.log(`[sync] Season OPS map: ${Object.keys(opsMap).length} players`);
  return opsMap;
}

// ---------------------------------------------------------------------------
// FETCH ROSTER PLAYER KEYS
// Returns [{ key, name }] for all rostered players across all teams
// ---------------------------------------------------------------------------

async function fetchRosterPlayerKeys(teamKeyArr) {
  const playerKeys = [];
  const seen = new Set();

  for (const tk of teamKeyArr) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
    const parsed = await parseXml(xml);
    const players = asArray(
      parsed?.fantasy_content?.team?.roster?.players?.player
    );
    for (const pl of players) {
      const key = pl?.player_key || pl?.["player_key"] || null;
      const name = pl?.name?.full || "";
      if (key && !seen.has(key)) {
        seen.add(key);
        playerKeys.push({ key, name });
      }
    }
  }

  console.log(`[sync] Roster player keys collected: ${playerKeys.length}`);
  return playerKeys;
}

// ---------------------------------------------------------------------------
// FORMAT ENRICHED PLAYER LINE
// ---------------------------------------------------------------------------

function formatEnrichedPlayerLine(playerStr, enrichment) {
  if (!enrichment) return playerStr;
  const parts = [];
  if (enrichment.ops7)        parts.push(`L7 OPS: ${enrichment.ops7}`);
  if (enrichment.opsSeason)   parts.push(`Season OPS: ${enrichment.opsSeason}`);
  const bvpParts = [
    enrichment.bvpAb  ? `${enrichment.bvpAb} AB`      : "",
    enrichment.bvpQab ? `QAB% ${enrichment.bvpQab}`   : "",
    enrichment.bvpHh  ? `HH% ${enrichment.bvpHh}`     : "",
    enrichment.bvpHrf ? `HRF ${enrichment.bvpHrf}`    : "",
  ].filter(Boolean);
  if (bvpParts.length) parts.push(`BVP: ${bvpParts.join(", ")}`);
  if (enrichment.sbPct) parts.push(`SB% ${enrichment.sbPct}`);
  return parts.length ? `${playerStr} [${parts.join(" | ")}]` : playerStr;
}

// ---------------------------------------------------------------------------
// TEAM KEYS HELPER
// ---------------------------------------------------------------------------

function teamKeys() {
  const arr = JSON.parse(YAHOO_TEAM_KEYS_JSON);
  if (!Array.isArray(arr) || arr.length === 0)
    throw new Error("YAHOO_TEAM_KEYS_JSON must be a JSON array of team keys");
  return arr;
}

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
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

  const keys = teamKeys();

  // 1) Rosters (10 teams) — raw XML parse for display names
  const rosterResults = [];
  for (const tk of keys) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
    const parsed = await parseTeamRoster(xml);
    rosterResults.push(parsed);
  }

  // 2) Collect all unique player keys across all rosters for stat enrichment
  const rosterPlayerKeys = await fetchRosterPlayerKeys(keys);

  // 3) Fetch enrichment data in parallel: L7 OPS, season OPS, BVP (today), SB% (today)
  console.log("[sync] Fetching L7 OPS, season OPS, BVP, and SB% in parallel...");
  const [ops7Map, opsSeasonMap, bvpMap, sbMap] = await Promise.all([
    fetchLast7OpsMapForKeys(rosterPlayerKeys).catch((e) => {
      console.error("[sync] L7 OPS fetch failed:", e.message); return {};
    }),
    fetchSeasonOpsMapForKeys(rosterPlayerKeys).catch((e) => {
      console.error("[sync] Season OPS fetch failed:", e.message); return {};
    }),
    fetchBvpMapFromNotion().catch((e) => {
      console.error("[sync] BVP Notion read failed:", e.message); return {};
    }),
    fetchSbMapFromNotion().catch((e) => {
      console.error("[sync] SB Notion read failed:", e.message); return {};
    }),
  ]);

  // 4) Free agents: top 400 hitters + top 600 pitchers by Yahoo rank
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

  // 5) Build enrichment lookup keyed by normalized full name
  //    rosterResults[].players are plain strings like "Name (POS, TEAM)"
  //    We extract the name from the beginning of that string for lookup.
  function enrichmentFor(playerStr, team) {
    // player strings look like "Mookie Betts (OF, LAD)" — grab name before " ("
    const nameOnly = playerStr.split(" (")[0];
    const key = normalizeName(nameOnly);
    const bvp = lookupMap(bvpMap, key) || null;
    return {
      ops7:       lookupMap(ops7Map, key) ?? "",
      opsSeason:  lookupMap(opsSeasonMap, key) ?? "",
      bvpAb:      bvp?.ab    ?? "",
      bvpQab:     bvp?.qab   ?? "",
      bvpHh:      bvp?.hhPct ?? "",
      bvpHrf:     bvp?.hrf   ?? "",
      sbPct:      lookupMapWithTeam(sbMap, key, team) ?? "",
    };
  }

  // 6) Write to Notion — rosters enriched, FAs unchanged
  const legend =
    "Legend: L7 OPS = last 7 days | Season OPS = season to date | BVP = vs today's pitcher (#AB, QAB%, HH%, HRF) | SB% = steal probability";

  const rostersMd =
    `Rosters sync\nLast synced: ${started}\n${legend}\n\n` +
    rosterResults
      .map((t) => {
        const header = `${t.team_name || t.team_key}`;
        const lines = (t.players || []).map((p) => {
          // Attempt to extract MLB team abbreviation from the player string for SB% lookup
          const teamMatch = p.match(/,\s*([A-Z]{2,3})\)/);
          const mlbTeam = teamMatch?.[1] ?? "";
          const enriched = enrichmentFor(p, mlbTeam);
          return `- ${formatEnrichedPlayerLine(p, enriched)}`;
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
