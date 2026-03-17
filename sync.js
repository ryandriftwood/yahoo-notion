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
import { overwritePageWithMarkdown, logRun } from "./notion.js";

requireEnv("NOTION_ROSTERS_PAGE_ID", NOTION_ROSTERS_PAGE_ID);
requireEnv("NOTION_FREE_AGENTS_PAGE_ID", NOTION_FREE_AGENTS_PAGE_ID);
requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("YAHOO_TEAM_KEYS_JSON", YAHOO_TEAM_KEYS_JSON);

function teamKeys() {
	const arr = JSON.parse(YAHOO_TEAM_KEYS_JSON);
	if (!Array.isArray(arr) || arr.length === 0) throw new Error("YAHOO_TEAM_KEYS_JSON must be a JSON array of team keys");
	return arr;
}

export async function runSync() {
	const started = new Date().toISOString();

	// 1) Rosters
	const rosterResults = [];
	for (const tk of teamKeys()) {
		const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
		const parsed = await parseTeamRoster(xml);
		rosterResults.push(parsed);
	}

	// 2) Free agents (top N)
	const faCount = YAHOO_FREE_AGENTS_COUNT || 200;
	const faXml = await yahooFantasyGetXml(
		`league/${YAHOO_LEAGUE_KEY}/players;status=A;sort=rank;start=0;count=${faCount}`
	);
	const freeAgents = await parseFreeAgents(faXml);

	// 3) Write to Notion (v1 appends; we’ll upgrade to true overwrite next)
	const rostersMd =
		`Rosters sync\\nLast synced: ${started}\\n\\n` +
		rosterResults
			.map((t) => {
				const header = `${t.team_name || t.team_key}`;
				const lines = t.players.map((p) => `- ${p}`).join("\\n");
				return `## ${header}\\n${lines}`;
			})
			.join("\\n\\n");

	const header =
  `Free agents (Top ${faCount} by Yahoo rank)\n` +
  `Last synced: ${started}\n\n`;

const body = freeAgents.join("\n"); // already "1. Name — Pos — Team" style

await overwritePageWithMarkdown(NOTION_FREE_AGENTS_PAGE_ID, header + body);

	await overwritePageWithMarkdown(NOTION_ROSTERS_PAGE_ID, rostersMd);

	await logRun({ name: `Sync run ${started}` });

	return {
		started,
		teams: rosterResults.length,
		freeAgents: freeAgents.length,
	};
}
