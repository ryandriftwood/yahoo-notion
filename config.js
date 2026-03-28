export const BASE_URL = process.env.BASE_URL;

export const DATABASE_URL = process.env.DATABASE_URL;

export const YAHOO_CONSUMER_KEY = process.env.YAHOO_CONSUMER_KEY;
export const YAHOO_CONSUMER_SECRET = process.env.YAHOO_CONSUMER_SECRET;

export const YAHOO_GAME_KEY = process.env.YAHOO_GAME_KEY;
export const YAHOO_LEAGUE_KEY = process.env.YAHOO_LEAGUE_KEY;
export const YAHOO_FREE_AGENTS_COUNT = Number(process.env.YAHOO_FREE_AGENTS_COUNT || 200);

export const YAHOO_TEAM_KEYS_JSON = process.env.YAHOO_TEAM_KEYS_JSON;

export const NOTION_TOKEN = process.env.NOTION_TOKEN;
export const NOTION_API_UPDATES_LOG_DATABASE_ID = process.env.NOTION_API_UPDATES_LOG_DATABASE_ID;

export const NOTION_ROSTERS_PAGE_ID = process.env.NOTION_ROSTERS_PAGE_ID;
export const NOTION_FREE_AGENTS_PAGE_ID = process.env.NOTION_FREE_AGENTS_PAGE_ID;

export const NOTION_SEASON_STATS_PAGE_ID = process.env.NOTION_SEASON_STATS_PAGE_ID;
export const NOTION_SEVENDAY_STATS_PAGE_ID = process.env.NOTION_SEVENDAY_STATS_PAGE_ID;

// ── Rotowire MLB Lineups ───────────────────────────────────────────────────────────────────
export const ROTOWIRE_LINEUPS_URL = process.env.ROTOWIRE_LINEUPS_URL;
export const NOTION_LINEUP_NEW_PAGE_ID = process.env.NOTION_LINEUP_NEW_PAGE_ID;
export const NOTION_LINEUP_OLD_PAGE_ID = process.env.NOTION_LINEUP_OLD_PAGE_ID;
export const NOTION_LINEUP_DB_ID = process.env.NOTION_LINEUP_DB_ID;
export const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// ── Rotowire Projected Lineups (tomorrow) ─────────────────────────────────────────────────
export const NOTION_PROJECTED_LINEUP_PAGE_ID = process.env.NOTION_PROJECTED_LINEUP_PAGE_ID;

// ── FantasyInfoCentral ───────────────────────────────────────────────────────────────────
// Notion page IDs for the four FIC landing pages
export const FIC_BVP_TODAY_PAGE_ID     = process.env.FIC_BVP_TODAY_PAGE_ID;
export const FIC_BVP_TOMORROW_PAGE_ID  = process.env.FIC_BVP_TOMORROW_PAGE_ID;
export const FIC_SB_TODAY_PAGE_ID      = process.env.FIC_SB_TODAY_PAGE_ID;
export const FIC_SB_TOMORROW_PAGE_ID   = process.env.FIC_SB_TOMORROW_PAGE_ID;

export function requireEnv(name, val) {
	if (!val) throw new Error(`Missing env var ${name}`);
}
