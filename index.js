import express from "express";
import { Client as NotionClient } from "@notionhq/client";
import pg from "pg";
import fetch from "node-fetch";
import OAuth from "oauth-1.0a";
import crypto from "crypto";

const { Pool } = pg;

const app = express();

/**
 * ------------------------
 * Notion client
 * ------------------------
 */
const notion = new NotionClient({
	auth: process.env.NOTION_TOKEN,
});

/**
 * ------------------------
 * Postgres
 * ------------------------
 */
const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
});

/**
 * ------------------------
 * Yahoo OAuth 1.0a endpoints
 * ------------------------
 */
const YAHOO_REQUEST_TOKEN_URL = "https://api.login.yahoo.com/oauth/v2/get_request_token";
const YAHOO_ACCESS_TOKEN_URL = "https://api.login.yahoo.com/oauth/v2/get_token";

/**
 * This is the user approval page for OAuth1 request tokens
 */
const YAHOO_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth/v2/request_auth";

/**
 * Base URL + callback
 * - Set BASE_URL in Render to: https://ys.driftwoodclimate.com
 * - Set Yahoo Redirect/Callback URL to: https://ys.driftwoodclimate.com/callback/yahoo
 */
const BASE_URL = process.env.BASE_URL || "https://ys.driftwoodclimate.com";
const CALLBACK_URL = `${BASE_URL}/callback/yahoo`;

/**
 * Yahoo OAuth signer
 * NOTE: Yahoo may label these as "Client ID/Secret" in the UI.
 * For Fantasy Sports OAuth1, treat them as consumer key/secret.
 */
const yahooOAuth = new OAuth({
	consumer: {
		key: process.env.YAHOO_CLIENT_ID,
		secret: process.env.YAHOO_CLIENT_SECRET,
	},
	signature_method: "HMAC-SHA1",
	hash_function(base_string, key) {
		return crypto.createHmac("sha1", key).update(base_string).digest("base64");
	},
});

async function ensureTables() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS yahoo_tokens (
			id TEXT PRIMARY KEY DEFAULT 'main',
			oauth_token TEXT NOT NULL,
			oauth_token_secret TEXT NOT NULL,
			oauth_session_handle TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await pool.query(`
		CREATE TABLE IF NOT EXISTS yahoo_request_tokens (
			oauth_token TEXT PRIMARY KEY,
			oauth_token_secret TEXT NOT NULL,
			created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);
}

async function saveYahooTokens({ token, tokenSecret, sessionHandle }) {
	await ensureTables();
	await pool.query(
		`
		INSERT INTO yahoo_tokens (id, oauth_token, oauth_token_secret, oauth_session_handle)
		VALUES ('main', $1, $2, $3)
		ON CONFLICT (id) DO UPDATE SET
			oauth_token = EXCLUDED.oauth_token,
			oauth_token_secret = EXCLUDED.oauth_token_secret,
			oauth_session_handle = EXCLUDED.oauth_session_handle,
			updated_at = NOW()
		`,
		[token, tokenSecret, sessionHandle || null]
	);
}

async function getYahooTokens() {
	await ensureTables();
	const { rows } = await pool.query(
		`SELECT oauth_token, oauth_token_secret, oauth_session_handle FROM yahoo_tokens WHERE id = 'main'`
	);
	return rows[0] || null;
}

app.get("/", (req, res) => {
	res.send("ok");
});

/**
 * ------------------------
 * Notion test endpoint
 * ------------------------
 * Env vars required:
 * - NOTION_TOKEN
 * - NOTION_LEAGUE_STATE_PAGE_ID
 * - NOTION_API_UPDATES_LOG_DATABASE_ID
 */
app.get("/notion/test", async (req, res) => {
	try {
		const leagueStatePageId = process.env.NOTION_LEAGUE_STATE_PAGE_ID;
		const updatesLogDatabaseId = process.env.NOTION_API_UPDATES_LOG_DATABASE_ID;

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
						rich_text: [
							{
								type: "text",
								text: { content: `✅ Notion write test from Render at ${now}` },
							},
						],
					},
				},
			],
		});

		await notion.pages.create({
			parent: { database_id: updatesLogDatabaseId },
			properties: {
				Name: {
					title: [
						{
							type: "text",
							text: { content: `Sync test ${now}` },
						},
					],
				},
			},
		});

		res.send("Wrote to Notion successfully ✅");
	} catch (err) {
		console.error(err);
		res.status(500).send(`Notion write failed: ${err.message || String(err)}`);
	}
});

/**
 * ------------------------
 * Yahoo OAuth step 1: connect
 * ------------------------
 * This requests a request token, stores it, then redirects you to Yahoo to approve.
 *
 * Required env vars:
 * - YAHOO_CLIENT_ID
 * - YAHOO_CLIENT_SECRET
 * - DATABASE_URL
 * - BASE_URL (recommended)
 */
app.get("/connect/yahoo", async (req, res) => {
	try {
		if (!process.env.YAHOO_CLIENT_ID || !process.env.YAHOO_CLIENT_SECRET) {
			return res.status(400).send("Missing YAHOO_CLIENT_ID or YAHOO_CLIENT_SECRET env vars");
		}

		await ensureTables();

		// Build OAuth params for request token
		const requestData = {
			url: YAHOO_REQUEST_TOKEN_URL,
			method: "GET",
			data: { oauth_callback: CALLBACK_URL },
		};

		const oauthParams = yahooOAuth.authorize(requestData);

		// Put ALL oauth params into the query string (more reliable with Yahoo)
		const url = new URL(YAHOO_REQUEST_TOKEN_URL);
		url.searchParams.set("oauth_callback", CALLBACK_URL);
		for (const [k, v] of Object.entries(oauthParams)) {
			url.searchParams.set(k, v);
		}

		const r = await fetch(url.toString(), { method: "GET" });
		const text = await r.text();

		if (!r.ok) {
			return res.status(500).send(`Request token failed: HTTP ${r.status}\n\n${text}`);
		}

		// Response is querystring: oauth_token=...&oauth_token_secret=...&xoauth_request_auth_url=...
		const params = new URLSearchParams(text);
		const token = params.get("oauth_token");
		const tokenSecret = params.get("oauth_token_secret");
		const authUrlFromYahoo = params.get("xoauth_request_auth_url");

		if (!token || !tokenSecret) {
			return res.status(500).send(`Unexpected response from Yahoo:\n\n${text}`);
		}

		await pool.query(
			`INSERT INTO yahoo_request_tokens (oauth_token, oauth_token_secret)
			 VALUES ($1, $2)
			 ON CONFLICT (oauth_token) DO UPDATE SET oauth_token_secret = EXCLUDED.oauth_token_secret`,
			[token, tokenSecret]
		);

		// Prefer Yahoo-provided auth URL if present
		const approveUrl = authUrlFromYahoo || `${YAHOO_AUTHORIZE_URL}?oauth_token=${encodeURIComponent(token)}`;
		return res.redirect(approveUrl);
	} catch (err) {
		console.error(err);
		return res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

/**
 * ------------------------
 * Yahoo OAuth step 2: callback
 * ------------------------
 * Yahoo sends you back with:
 * - oauth_token (the request token)
 * - oauth_verifier
 *
 * We look up the stored request token secret, then exchange for access token + secret.
 */
app.get("/callback/yahoo", async (req, res) => {
	try {
		const { oauth_token, oauth_verifier } = req.query;

		if (!oauth_token || !oauth_verifier) {
			return res.status(400).send("Missing oauth_token or oauth_verifier in callback");
		}

		await ensureTables();

		// Look up request token secret
		const { rows } = await pool.query(
			`SELECT oauth_token_secret FROM yahoo_request_tokens WHERE oauth_token = $1`,
			[String(oauth_token)]
		);

		if (!rows[0]) return res.status(400).send("Request token not found. Try /connect/yahoo again.");

		const requestTokenSecret = rows[0].oauth_token_secret;

		// Build OAuth params for access token exchange
		const requestData = {
			url: YAHOO_ACCESS_TOKEN_URL,
			method: "GET",
			data: { oauth_verifier: String(oauth_verifier) },
		};

		const oauthParams = yahooOAuth.authorize(requestData, {
			key: String(oauth_token),
			secret: requestTokenSecret,
		});

		// Put ALL oauth params into query string
		const url = new URL(YAHOO_ACCESS_TOKEN_URL);
		url.searchParams.set("oauth_verifier", String(oauth_verifier));
		for (const [k, v] of Object.entries(oauthParams)) {
			url.searchParams.set(k, v);
		}

		const r = await fetch(url.toString(), { method: "GET" });
		const text = await r.text();

		if (!r.ok) {
			return res.status(500).send(`Access token failed: HTTP ${r.status}\n\n${text}`);
		}

		// Response is querystring: oauth_token=...&oauth_token_secret=...&oauth_session_handle=...
		const params = new URLSearchParams(text);
		const accessToken = params.get("oauth_token");
		const accessTokenSecret = params.get("oauth_token_secret");
		const sessionHandle = params.get("oauth_session_handle");

		if (!accessToken || !accessTokenSecret) {
			return res.status(500).send(`Unexpected response from Yahoo:\n\n${text}`);
		}

		await saveYahooTokens({
			token: accessToken,
			tokenSecret: accessTokenSecret,
			sessionHandle,
		});

		return res.send("Yahoo connected ✅ Tokens saved. Next: visit /yahoo/token-status");
	} catch (err) {
		console.error(err);
		return res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

app.get("/yahoo/token-status", async (req, res) => {
	try {
		const t = await getYahooTokens();
		if (!t) return res.status(404).send("No Yahoo tokens saved yet. Go to /connect/yahoo first.");
		return res.send("Yahoo tokens are saved ✅");
	} catch (err) {
		console.error(err);
		return res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	console.log(`BASE_URL: ${BASE_URL}`);
	console.log(`CALLBACK_URL: ${CALLBACK_URL}`);
});
