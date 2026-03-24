// seasonstats.js
import {
	YAHOO_LEAGUE_KEY,
	YAHOO_FREE_AGENTS_COUNT,
	requireEnv,
	NOTION_SEASON_STATS_PAGE_ID,
} from "./config.js";

import { yahooFantasyGetXml } from "./yahoo.js";
import { parseStringPromise } from "xml2js";
import { overwritePageWithTable } from "./notiontables.js";

requireEnv("YAHOO_LEAGUE_KEY", YAHOO_LEAGUE_KEY);
requireEnv("NOTION_SEASON_STATS_PAGE_ID", NOTION_SEASON_STATS_PAGE_ID);

async function parseXml(xml) {
	return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

function asArray(x) {
	if (!x) return [];
	return Array.isArray(x) ? x : [x];
}

function getPlayerListFromLeaguePlayersResponse(p) {
	const players = p?.fantasy_content?.league?.players?.player;
	return asArray(players).map((pl) => ({
		player_key: pl?.player_key || null,
		player_id: pl?.player_id || null,
		full: pl?.name?.full || "",
		mlbTeam: pl?.editorial_team_abbr || "",
		positions: pl?.display_position || "",
		status: pl?.status || "",
	}));
}

function getStatMapFromPlayer(pl) {
	// stats often appear under: player.player_stats.stats.stat[]
	// each stat is like: { stat_id: '...', value: '...' }
	const stats = asArray(pl?.player_stats?.stats?.stat);
	const out = {};
	for (const s of stats) {
		const id = s?.stat_id;
		if (!id) continue;
		out[String(id)] = s?.value ?? "";
	}
	return out;
}

async function fetchPlayersByOverallRank({ target = 500, statusFilter = "FA" }) {
	const pageSize = 25;
	let start = 0;
	let all = [];

	while (all.length < target) {
		const remaining = target - all.length;
		const count = Math.min(pageSize, remaining);

		// NOTE: statusFilter: FA or A
		const xml = await yahooFantasyGetXml(
			`league/${YAHOO_LEAGUE_KEY}/players;status=${statusFilter};sort=OR;start=${start};count=${count}`
		);

		const parsed = await parseXml(xml);
		const pagePlayers = getPlayerListFromLeaguePlayersResponse(parsed);

		if (!pagePlayers.length) break;

		all = all.concat(pagePlayers);
		start += pageSize;
	}

	return all;
}

async function fetchSeasonStatsForPlayerKeys(playerKeysCsv) {
	// This URL shape is the one you may need to tweak depending on Yahoo’s exact format.
	// Goal: get players by player_keys, include stats for season.
	const xml = await yahooFantasyGetXml(
		`league/${YAHOO_LEAGUE_KEY}/players;player_keys=${playerKeysCsv}/stats`
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
	return players.map((p) => ({
		...p,
		statMap: m.get(p.player_key) || {},
	}));
}

export async function runSeasonStatsSync({ statusFilter = "FA", target = 500 } = {}) {
	const started = new Date().toISOString();

	const players = await fetchPlayersByOverallRank({ target, statusFilter });

	// batch stats per 25
	const pageSize = 25;
	let statsRows = [];

	for (let i = 0; i < players.length; i += pageSize) {
		const batch = players.slice(i, i + pageSize);
		const keys = batch.map((b) => b.player_key).filter(Boolean);
		if (!keys.length) continue;

		const stats = await fetchSeasonStatsForPlayerKeys(keys.join(","));
		statsRows = statsRows.concat(stats);
	}

	const merged = mergeStatsIntoPlayers(players, statsRows);

	// STAT IDS NOTE:
	// We don’t yet know which stat_ids correspond to OPS, ERA, WHIP, etc in *your* league feed.
	// So we’ll print a “raw” stat_ids subset first, and you can tell me which IDs map to which categories.
	//
	// Once you identify IDs, we’ll replace these with labeled columns.
	const columns = [
		"OR Rank",
		"Player",
		"Team",
		"Pos",
		"Status",
		"player_key",
		"Stats (raw ids)",
	];

	const rows = merged.map((p, idx) => {
		// take first ~10 stat entries so the table is readable
		const entries = Object.entries(p.statMap || {}).slice(0, 10);
		const compact = entries.map(([k, v]) => `${k}:${v}`).join(" | ");

		return [
			String(idx + 1),
			p.full,
			p.mlbTeam,
			p.positions,
			p.status,
			p.player_key,
			compact,
		];
	});

	await overwritePageWithTable(
		NOTION_SEASON_STATS_PAGE_ID,
		[
			`Season stats — Top ${target} by Yahoo overall rank (status=${statusFilter})`,
			`Last synced: ${started}`,
		],
		columns,
		rows
	);

	return { started, count: merged.length };
}

export function seasonStatsRouteHandler() {
	return async (req, res) => {
		try {
			if (SEASON_STATS_SECRET) {
				const got = req.header("x-sync-secret");
				if (got !== SEASON_STATS_SECRET) return res.status(401).send("Unauthorized");
			}

			const status = (req.query.status || "FA").toString();
			const result = await runSeasonStatsSync({ statusFilter: status, target: 500 });
			return res.json({ ok: true, result });
		} catch (e) {
			return res.status(500).json({ ok: false, error: String(e?.response?.data || e?.message || e) });
		}
	};
}
