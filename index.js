import express from "express";
import axios from "axios";
import pg from "pg";
import { Client as NotionClient } from "@notionhq/client";
import { parseStringPromise } from "xml2js";

const { Pool } = pg;
const app = express();

/**
 * Env vars required:
 * - BASE_URL = https://ys.driftwoodclimate.com
 * - YAHOO_CONSUMER_KEY
 * - YAHOO_CONSUMER_SECRET
 * - DATABASE_URL
 *
 * Notion (used by /notion/test):
 * - NOTION_TOKEN
 * - NOTION_LEAGUE_STATE_PAGE_ID
 * - NOTION_API_UPDATES_LOG_DATABASE_ID
 */
const BASE_URL = process.env.BASE_URL || "https://ys.driftwoodclimate.com";
const OAUTH2_CALLBACK_PATH = "/callback/yahoo-oauth2";
const REDIRECT_URI = `${BASE_URL}${OAUTH2_CALLBACK_PATH}`;

const YAHOO_OAUTH2_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const YAHOO_OAUTH2_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";

const YAHOO_FANTASY_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";
const LEAGUE_KEY = "469.l.42443";
const TEAM_KEY = "469.l.42443.t.10";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const notion = new NotionClient({ auth: process.env.NOTION_TOKEN });

async function ensureTables() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS yahoo_oauth2_tokens (
			id TEXT PRIMARY KEY DEFAULT 'main',
			access_token TEXT,
			refresh_token TEXT,
			token_type TEXT,
			expires_at BIGINT,
			scope TEXT,
			raw_json TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);
}

function basicAuthHeader() {
	const key = process.env.YAHOO_CONSUMER_KEY;
	const secret = process.env.YAHOO_CONSUMER_SECRET;
	if (!key || !secret) throw new Error("Missing YAHOO_CONSUMER_KEY or YAHOO_CONSUMER_SECRET");
	const b64 = Buffer.from(`${key}:${secret}`, "utf8").toString("base64");
	return `Basic ${b64}`;
}

async function loadTokens() {
	await ensureTables();
	const { rows } = await pool.query(`SELECT * FROM yahoo_oauth2_tokens WHERE id='main'`);
	return rows[0] || null;
}

async function saveTokens(tokenResponse) {
	await ensureTables();

	const now = Math.floor(Date.now() / 1000);
	const expiresIn = tokenResponse.expires_in ? Number(tokenResponse.expires_in) : null;
	const expiresAt = expiresIn ? now + expiresIn - 30 : null; // buffer

	await pool.query(
		`
		INSERT INTO yahoo_oauth2_tokens (id, access_token, refresh_token, token_type, expires_at, scope, raw_json)
		VALUES ('main', $1, $2, $3, $4, $5, $6)
		ON CONFLICT (id) DO UPDATE SET
			access_token = EXCLUDED.access_token,
			refresh_token = COALESCE(EXCLUDED.refresh_token, yahoo_oauth2_tokens.refresh_token),
			token_type = EXCLUDED.token_type,
			expires_at = EXCLUDED.expires_at,
			scope = EXCLUDED.scope,
			raw_json = EXCLUDED.raw_json,
			updated_at = NOW()
		`,
		[
			tokenResponse.access_token || null,
			tokenResponse.refresh_token || null,
			tokenResponse.token_type || null,
			expiresAt,
			tokenResponse.scope || null,
			JSON.stringify(tokenResponse),
		]
	);
}

async function ensureAccessToken() {
	const tokens = await loadTokens();
	if (!tokens || !tokens.refresh_token) {
		throw new Error("No refresh_token saved yet. Go to /connect/yahoo-oauth2 first.");
	}

	const now = Math.floor(Date.now() / 1000);
	if (tokens.access_token && tokens.expires_at && now < Number(tokens.expires_at)) {
		return tokens.access_token;
	}

	// Refresh
	const r = await axios({
		url: YAHOO_OAUTH2_TOKEN_URL,
		method: "post",
		headers: {
			Authorization: basicAuthHeader(),
			"Content-Type": "application/x-www-form-urlencoded",
			"User-Agent": "Mozilla/5.0",
		},
		data: new URLSearchParams({
			grant_type: "refresh_token",
			refresh_token: tokens.refresh_token,
			redirect_uri: REDIRECT_URI,
		}).toString(),
		timeout: 10000,
	});

	await saveTokens(r.data);
	return r.data.access_token;
}

async function yahooFantasyGet(path) {
	const accessToken = await ensureAccessToken();
	const url = `${YAHOO_FANTASY_BASE}/${path}`;
	const r = await axios({
		url,
		method: "get",
		headers: {
			Authorization: `Bearer ${accessToken}`,
			"User-Agent": "Mozilla/5.0",
			Accept: "application/xml",
		},
		timeout: 10000,
	});
	return r.data; // XML string
}

app.get("/", (req, res) => {
	res.type("text/plain").send("ok");
});

app.get("/debug/time", (req, res) => {
	res.type("text/plain").send(
		`Date.now()=${Date.now()}\n` +
			`epochSeconds=${Math.floor(Date.now() / 1000)}\n` +
			`iso=${new Date().toISOString()}\n`
	);
});

/**
 * Notion write test (kept)
 */
app.get("/notion/test", async (req, res) => {
	try {
		const leagueStatePageId = process.env.NOTION_LEAGUE_STATE_PAGE_ID;
		const updatesLogDatabaseId = process.env.NOTION_API_UPDATES_LOG_DATABASE_ID;

		if (!process.env.NOTION_TOKEN) return res.status(400).send("Missing env var NOTION_TOKEN");
		if (!leagueStatePageId) return res.status(400).send("Missing env var NOTION_LEAGUE_STATE_PAGE_ID");
		if (!updatesLogDatabaseId) return res.status(400).send("Missing env var NOTION_API_UPDATES_LOG_DATABASE_ID");

		const now = new Date().toISOString();

		await notion.blocks.children.append({
			block_id: leagueStatePageId,
			children: [
				{
					object: "block",
					type: "paragraph",
					paragraph: {
						rich_text: [{ type: "text", text: { content: `✅ Notion write test from Render at ${now}` } }],
					},
				},
			],
		});

		await notion.pages.create({
			parent: { database_id: updatesLogDatabaseId },
			properties: {
				Name: { title: [{ type: "text", text: { content: `Sync test ${now}` } }] },
			},
		});

		res.send("Wrote to Notion successfully ✅");
	} catch (err) {
		console.error(err);
		res.status(500).send(`Notion write failed: ${err.message || String(err)}`);
	}
});

/**
 * OAuth2 connect: redirect to Yahoo
 */
app.get("/connect/yahoo-oauth2", async (req, res) => {
	try {
		const clientId = process.env.YAHOO_CONSUMER_KEY;
		if (!clientId) return res.status(400).send("Missing env var YAHOO_CONSUMER_KEY");

		const u = new URL(YAHOO_OAUTH2_AUTHORIZE_URL);
		u.searchParams.set("client_id", clientId);
		u.searchParams.set("redirect_uri", REDIRECT_URI);
		u.searchParams.set("response_type", "code");
		u.searchParams.set("language", "en-us");

		return res.redirect(u.toString());
	} catch (err) {
		console.error(err);
		return res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

/**
 * OAuth2 callback: exchange code -> tokens, store in Postgres
 */
app.get(OAUTH2_CALLBACK_PATH, async (req, res) => {
	try {
		const code = req.query.code;
		if (!code) return res.status(400).send("Missing code");

		const r = await axios({
			url: YAHOO_OAUTH2_TOKEN_URL,
			method: "post",
			headers: {
				Authorization: basicAuthHeader(),
				"Content-Type": "application/x-www-form-urlencoded",
				"User-Agent": "Mozilla/5.0",
			},
			data: new URLSearchParams({
				grant_type: "authorization_code",
				code: String(code),
				redirect_uri: REDIRECT_URI,
				client_id: process.env.YAHOO_CONSUMER_KEY,
				client_secret: process.env.YAHOO_CONSUMER_SECRET,
			}).toString(),
			timeout: 10000,
		});

		await saveTokens(r.data);

		return res
			.type("text/plain")
			.send("Yahoo OAuth2 connected ✅ Tokens saved. Next: visit /yahoo/oauth2/status then /yahoo/discover");
	} catch (err) {
		console.error(err?.response?.data || err);
		const details = err?.response?.data ? JSON.stringify(err.response.data, null, 2) : String(err);
		return res.status(500).send(`Token exchange failed:\n\n${details}`);
	}
});

app.get("/yahoo/oauth2/status", async (req, res) => {
	try {
		const t = await loadTokens();
		if (!t || !t.refresh_token) return res.status(404).send("No tokens saved yet. Go to /connect/yahoo-oauth2.");
		res.type("text/plain").send(
			`Tokens saved ✅\n` +
				`hasAccessToken=${Boolean(t.access_token)}\n` +
				`hasRefreshToken=${Boolean(t.refresh_token)}\n` +
				`expiresAt=${t.expires_at}\n`
		);
	} catch (err) {
		console.error(err);
		res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

/**
 * Yahoo API test: returns raw XML
 */
app.get("/yahoo/api-test", async (req, res) => {
	try {
		const xml = await yahooFantasyGet("game/mlb");
		res.type("text/xml").send(xml);
	} catch (err) {
		console.error(err?.response?.data || err);
		const details = err?.response?.data ? err.response.data : String(err);
		res.status(500).send(`Yahoo API test failed:\n\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`);
	}
});

/**
 * Discover league + team keys (parsed JSON)
 * Calls: users;use_login=1/games;game_keys=mlb/teams
 */
app.get("/yahoo/discover", async (req, res) => {
	try {
		const xml = await yahooFantasyGet("users;use_login=1/games;game_keys=mlb/teams");

		const parsed = await parseStringPromise(xml, {
			explicitArray: false,
			mergeAttrs: true,
			ignoreAttrs: false,
		});

		const fantasy = parsed?.fantasy_content;
		const users = fantasy?.users;
		const user = users?.user;

		const games = user?.games?.game;
		const gameList = Array.isArray(games) ? games : games ? [games] : [];

		const out = [];

		for (const g of gameList) {
			const game_key = g?.game_key;
			const game_name = g?.name;
			const teams = g?.teams?.team;
			const teamList = Array.isArray(teams) ? teams : teams ? [teams] : [];

			for (const t of teamList) {
				out.push({
					game_key,
					game_name,
					league_key: t?.league_key || null,
					team_key: t?.team_key || null,
					team_name: t?.name || null,
					team_id: t?.team_id || null,
				});
			}
		}

		res.json({ count: out.length, teams: out });
	} catch (err) {
		console.error(err?.response?.data || err);
		const details = err?.response?.data ? err.response.data : String(err);
		res.status(500).send(`Discover failed:\n\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`);
	}
});

app.get("/yahoo/league/settings", async (req, res) => {
	try {
		const xml = await yahooFantasyGet(`league/${LEAGUE_KEY}/settings`);
		res.type("text/xml").send(xml);
	} catch (err) {
		console.error(err?.response?.data || err);
		const details = err?.response?.data ? err.response.data : String(err);
		res.status(500).send(
			`League settings failed:\n\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`
		);
	}
});

app.get("/yahoo/team/roster", async (req, res) => {
	try {
		const xml = await yahooFantasyGet(`team/${TEAM_KEY}/roster`);
		res.type("text/xml").send(xml);
	} catch (err) {
		console.error(err?.response?.data || err);
		const details = err?.response?.data ? err.response.data : String(err);
		res.status(500).send(
			`Team roster failed:\n\n${typeof details === "string" ? details : JSON.stringify(details, null, 2)}`
		);
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	console.log(`OAuth2 redirect URI: ${REDIRECT_URI}`);
});
