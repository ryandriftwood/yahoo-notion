// sync.js
import {
  YAHOO_TEAM_KEYS_JSON,
  YAHOO_LEAGUE_KEY,
  YAHOO_FREE_AGENTS_COUNT,
  NOTION_ROSTERS_PAGE_ID,
  NOTION_FREE_AGENTS_PAGE_ID,
  requireEnv,
} from "./config.js";
import { yahooFantasyGetXml } from "./yahoo.js";
import { parseTeamRoster, parseFreeAgents } from "./parseYahoo.js";
import {
  overwritePageWithMarkdown,
  overwritePageWithNumberedList,
  logRun,
} from "./notion.js";

requireEnv("NOTION_ROSTERS_PAGE_ID", NOTION_ROSTERS_PAGE_ID);
requireEnv("NOTION_FREE_AGENTS_PAGE_ID", NOTION_FREE_AGENTS_PAGE_ID);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("YAHOO_TEAM_KEYS_JSON", YAHOO_TEAM_KEYS_JSON);

function teamKeys() {
  const arr = JSON.parse(YAHOO_TEAM_KEYS_JSON);
  if (!Array.isArray(arr) || arr.length === 0)
    throw new Error("YAHOO_TEAM_KEYS_JSON must be a JSON array of team keys");
  return arr;
}

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

  // 1) Rosters (10 teams)
  const rosterResults = [];
  for (const tk of teamKeys()) {
    const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
    const parsed = await parseTeamRoster(xml);
    rosterResults.push(parsed);
  }

  // 2) Free agents: top 400 hitters + top 600 pitchers by Yahoo rank
  const hittersTarget = 400;
  const pitchersTarget = 600;
  const pageSize = 25; // Yahoo commonly caps here

  async function fetchFreeAgentsPage(position, start, count) {
    const xml = await yahooFantasyGetXml(
      `league/${YAHOO_LEAGUE_KEY}/players;status=A;position=${position};sort=OR;start=${start};count=${count}`
    );
    // status=A -> available (FA + waivers), position=B/P filters hitters/pitchers, sort=OR -> overall rank
    return parseFreeAgents(xml);
  }

  async function fetchTopForPosition(position, target) {
    let start = 0;
    let collected = [];

    while (collected.length < target) {
      const remaining = target - collected.length;
      const count = Math.min(pageSize, remaining);

      const page = await fetchFreeAgentsPage(position, start, count);

      // Pool exhausted: Yahoo returned nothing
      if (!page.length) {
        console.log(`[${position}] Pool exhausted at ${collected.length} players (empty page at start=${start}). Moving on.`);
        break;
      }

      collected = collected.concat(page);

      // Pool exhausted: Yahoo returned fewer than requested — this is the last page
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

  // Combined list: hitters first, then pitchers
  const freeAgents = [...hitters, ...pitchers];
  const total = freeAgents.length;

  // 3) Write to Notion (true overwrite)
  const rostersMd =
    `Rosters sync\nLast synced: ${started}\n\n` +
    rosterResults
      .map((t) => {
        const header = `${t.team_name || t.team_key}`;
        const lines = (t.players || []).map((p) => `- ${p}`).join("\n");
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
