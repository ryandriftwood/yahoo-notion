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
import { overwritePageWithMarkdown, overwritePageWithNumberedList, logRun } from "./notion.js";

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

	// 1) Rosters (10 teams)
	const rosterResults = [];
	for (const tk of teamKeys()) {
		const xml = await yahooFantasyGetXml(`team/${tk}/roster`);
		const parsed = await parseTeamRoster(xml);
		rosterResults.push(parsed);
	}

	// 2) Free agents (paginate to top N)
	const target = YAHOO_FREE_AGENTS_COUNT || 500;
	const pageSize = 25; // Yahoo commonly caps here
	let start = 0;
	let freeAgents = [];

	while (freeAgents.length < target) {
		const remaining = target - freeAgents.length;
		const count = Math.min(pageSize, remaining);

		const xml = await yahooFantasyGetXml(
			`league/${YAHOO_LEAGUE_KEY}/players;status=A;sort=OR;start=${start};count=${count}`
		);


		const page = await parseFreeAgents(xml); // must return NOT-numbered strings
		if (!page.length) break;

		freeAgents = freeAgents.concat(page);
		start += pageSize;
	}

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
		[`Free agents (Top ${target} by Yahoo rank)`, `Last synced: ${started}`],
		freeAgents
	);

	await logRun({ name: `Sync run ${started} (teams=${rosterResults.length}, freeAgents=${freeAgents.length})` });

	return {
		started,
		teams: rosterResults.length,
		freeAgents: freeAgents.length,
	};
}
