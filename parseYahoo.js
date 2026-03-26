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
				const selectedPos = pl?.selected_position?.position || "";
	const eligNode = pl?.eligible_positions?.eligible_position || pl?.eligible_positions;
	const eligList = Array.isArray(eligNode) ? eligNode : eligNode ? [eligNode] : [];
	const eligPos = eligList
		.map((e) => e.position || e)  // depending on how xml2js parsed it
		.filter(Boolean);

	let pos = "";
	if (selectedPos && eligPos.length) {
		// Put selected first, then full elig list
		pos = `${selectedPos} (${eligPos.join(", ")})`;
	} else if (selectedPos) {
		pos = selectedPos;
	} else if (eligPos.length) {
		pos = eligPos.join(", ");
	}

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
		const eligNode = pl?.eligible_positions?.eligible_positions;
		const eligList = Array.isArray(eligNode) ? eligNode : eligNode ? [eligNode] : [];
		const eligPos = eligList.map((e) => e.position).filter(Boolean);
		const pos = eligPos.length ? eligPos.join(", ") : (pl?.display_position || "");
		const mlbTeam = pl?.editorial_team_abbr || "";
		const ownershipType =
			pl?.ownership?.ownership_type ||
			pl?.ownership_type ||            // depending on how xml2js shaped it
			"";

		const isWaivers =
			typeof ownershipType === "string" &&
			ownershipType.toLowerCase().includes("waiver");

		const waiverTag = isWaivers ? " — W" : ""; // or " — waiver" if you prefer

		return `${full}${pos ? ` — ${pos}` : ""}${mlbTeam ? ` — ${mlbTeam}` : ""}${waiverTag}`.trim();
	});
}
