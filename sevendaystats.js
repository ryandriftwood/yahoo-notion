// sevendaystats.js
import { YAHOO_LEAGUE_KEY, requireEnv, NOTION_SEVENDAY_STATS_PAGE_ID } from "./config.js";
import { yahooFantasyGetXml } from "./yahoo.js";
import { parseStringPromise } from "xml2js";
import { overwritePageWithTable } from "./notiontables.js";

requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("NOTION_SEVENDAY_STATS_PAGE_ID", NOTION_SEVENDAY_STATS_PAGE_ID);

// Stat ID → column name mapping derived from league scoring settings
// Batters:  7=R, 12=HR, 13=RBI, 16=SB, 55=OPS, 60=H/AB
// Pitchers: 26=ERA, 27=WHIP, 28=SV, 50=IP, 57=K/9, 85=QS
const BATTER_STAT_IDS  = ["7",  "12",  "13",  "16",  "55",   "60"];
const BATTER_STAT_NAMES = ["R",  "HR",  "RBI", "SB",  "OPS",  "H/AB"];
const PITCHER_STAT_IDS  = ["26", "27",  "28",  "50",  "57",   "85"];
const PITCHER_STAT_NAMES = ["ERA","WHIP","SV",  "IP",  "K/9",  "QS"];

// Combined ordered list for the table columns
const ALL_STAT_IDS   = [...BATTER_STAT_IDS,   ...PITCHER_STAT_IDS];
const ALL_STAT_NAMES = [...BATTER_STAT_NAMES, ...PITCHER_STAT_NAMES];

async function parseXml(xml) {
	return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

function asArray(x) {
	if (!x) return [];
	return Array.isArray(x) ? x : [x];
}

function getPlayersFromLeaguePlayersResponse(p) {
	const players = p?.fantasy_content?.league?.players?.player;
	return asArray(players).map((pl) => ({
		player_key: pl?.player_key || null,
		full: pl?.name?.full || "",
		mlbTeam: pl?.editorial_team_abbr || "",
		positions: pl?.display_position || "",
		status: pl?.status || "",
	}));
}

function getStatMapFromPlayer(pl) {
	const stats = asArray(pl?.player_stats?.stats?.stat);
	const out = {};
	for (const s of stats) {
		const id = s?.stat_id;
		if (!id) continue;
		out[String(id)] = s?.value ?? "";
	}
	return out;
}

async function fetchPlayersByOverallRank({ target = 1000 }) {
	const pageSize = 25;
	let start = 0;
	let all = [];

	while (all.length < target) {
		const remaining = target - all.length;
		const count = Math.min(pageSize, remaining);

		// status=A returns ALL players (owned + FA + waivers)
		const xml = await yahooFantasyGetXml(
			`league/${YAHOO_LEAGUE_KEY}/players;status=A;sort=OR;start=${start};count=${count}`
		);

		const parsed = await parseXml(xml);
		const pagePlayers = getPlayersFromLeaguePlayersResponse(parsed);
		if (!pagePlayers.length) break;

		all = all.concat(pagePlayers);
		start += pageSize;
	}

	return all;
}

async function fetchLastWeekStatsForPlayerKeys(playerKeysCsv) {
	const xml = await yahooFantasyGetXml(
		`league/${YAHOO_LEAGUE_KEY}/players;player_keys=${playerKeysCsv}/stats;type=lastweek`
	);

	const parsed = await parseXml(xml);
	const players = asArray(parsed?.fantasy_content?.league?.players?.player);

	return players.map((pl) => ({
		player_key: pl?.player_key || null,
		statMap: getStatMapFromPlayer(pl),
	}));
}

function mergeStatsIntoPlayers(players, statsByKey) {
	const m = new Map(statsByKey.map((x) => [x.player_key, x.statMap]));
	return players.map((p) => ({ ...p, statMap: m.get(p.player_key) || {} }));
}

export async function runSevenDayStatsSync({ target = 1000 } = {}) {
	const started = new Date().toISOString();

	const players = await fetchPlayersByOverallRank({ target });

	const pageSize = 25;
	let statsRows = [];

	for (let i = 0; i < players.length; i += pageSize) {
		const batch = players.slice(i, i + pageSize);
		const keys = batch.map((b) => b.player_key).filter(Boolean);
		if (!keys.length) continue;

		const stats = await fetchLastWeekStatsForPlayerKeys(keys.join(","));
		statsRows = statsRows.concat(stats);
	}

	const merged = mergeStatsIntoPlayers(players, statsRows);

	const columns = ["OR Rank", "Player", "Team", "Pos", "Status", "player_key", ...ALL_STAT_NAMES];

	const rows = merged.map((p, idx) => [
		String(idx + 1),
		p.full,
		p.mlbTeam,
		p.positions,
		p.status,
		p.player_key,
		...ALL_STAT_IDS.map((id) => p.statMap?.[id] ?? ""),
	]);

	await overwritePageWithTable(
		NOTION_SEVENDAY_STATS_PAGE_ID,
		[`Last week stats — Top ${target} by OR (all players)`, `Last synced: ${started}`],
		columns,
		rows
	);

	return { started, count: merged.length };
}

export function sevenDayStatsRouteHandler() {
	return async (req, res) => {
		try {
			const target = Number(req.query.target || 1000);
			const result = await runSevenDayStatsSync({ target });
			return res.json({ ok: true, result });
		} catch (e) {
			return res
				.status(500)
				.json({ ok: false, error: String(e?.response?.data || e?.message || e) });
		}
	};
}
