import { parseStringPromise } from "xml2js";

async function parseXml(xml) {
	return parseStringPromise(xml, { explicitArray: false, mergeAttrs: true, ignoreAttrs: false });
}

export async function parseTeamRoster(xml) {
	const p = await parseXml(xml);

	// Walk: fantasy_content -> team -> roster -> players -> player
	const team = p?.fantasy_content?.team;
	const roster = team?.roster;
	const playersNode = roster?.players;
	const players = playersNode?.player;

	const list = Array.isArray(players) ? players : players ? [players] : [];

	// Normalize to simple strings for Notion
	return {
		team_key: team?.team_key || null,
		team_name: team?.name || null,
		date: roster?.date || null,
		players: list.map((pl) => {
			const full = pl?.name?.full || "";
			const pos = pl?.selected_position?.position || pl?.display_position || "";
			const mlbTeam = pl?.editorial_team_abbr || "";
			return `${full}${pos ? ` — ${pos}` : ""}${mlbTeam ? ` — ${mlbTeam}` : ""}`.trim();
		}),
	};
}

export async function parseFreeAgents(xml) {
	const p = await parseXml(xml);

	// Typical shape: fantasy_content -> league -> players -> player
	const league = p?.fantasy_content?.league;
	const playersNode = league?.players;
	const players = playersNode?.player;

	const list = Array.isArray(players) ? players : players ? [players] : [];

	return list.map((pl, idx) => {
		const full = pl?.name?.full || "";
		const pos = pl?.display_position || "";
		const mlbTeam = pl?.editorial_team_abbr || "";
		return `${full}${pos ? ` — ${pos}` : ""}${mlbTeam ? ` — ${mlbTeam}` : ""}`.trim();
	});
}
