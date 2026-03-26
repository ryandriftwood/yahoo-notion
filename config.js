export const BASE_URL = process.env.BASE_URL;

export const DATABASE_URL = process.env.DATABASE_URL;

export const YAHOO_CONSUMER_KEY = process.env.YAHOO_CONSUMER_KEY;
export const YAHOO_CONSUMER_SECRET = process.env.YAHOO_CONSUMER_SECRET;

export const YAHOO_GAME_KEY = process.env.YAHOO_GAME_KEY; // "469"
export const YAHOO_LEAGUE_KEY = process.env.YAHOO_LEAGUE_KEY; // "469.l.42443"
export const YAHOO_FREE_AGENTS_COUNT = Number(process.env.YAHOO_FREE_AGENTS_COUNT || 200);

export const YAHOO_TEAM_KEYS_JSON = process.env.YAHOO_TEAM_KEYS_JSON;

export const NOTION_TOKEN = process.env.NOTION_TOKEN;
export const NOTION_API_UPDATES_LOG_DATABASE_ID = process.env.NOTION_API_UPDATES_LOG_DATABASE_ID;

export const NOTION_ROSTERS_PAGE_ID = process.env.NOTION_ROSTERS_PAGE_ID;
export const NOTION_FREE_AGENTS_PAGE_ID = process.env.NOTION_FREE_AGENTS_PAGE_ID;

export const NOTION_SEASON_STATS_PAGE_ID = process.env.NOTION_SEASON_STATS_PAGE_ID;
export const NOTION_SEVENDAY_STATS_PAGE_ID = process.env.NOTION_SEVENDAY_STATS_PAGE_ID;

// ── Rotowire MLB Lineups ──────────────────────────────────────────────────────
// Override the default Rotowire URL (optional)
export const ROTOWIRE_LINEUPS_URL = process.env.ROTOWIRE_LINEUPS_URL;
// Notion page that always holds the CURRENT (newest) lineup
export const NOTION_LINEUP_NEW_PAGE_ID = process.env.NOTION_LINEUP_NEW_PAGE_ID;
// Notion page that holds the PREVIOUS lineup (overwritten on each change)
export const NOTION_LINEUP_OLD_PAGE_ID = process.env.NOTION_LINEUP_OLD_PAGE_ID;
// Notion database that logs every lineup-sync run
export const NOTION_LINEUP_DB_ID = process.env.NOTION_LINEUP_DB_ID;

export function requireEnv(name, val) {
	if (!val) throw new Error(`Missing env var ${name}`);
}
