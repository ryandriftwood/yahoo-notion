import express from "express";
import { Client as NotionClient } from "@notionhq/client";
import pkg from "oauth";
import pg from "pg";

const { OAuth } = pkg;
const { Pool } = pg;

const app = express();

const notion = new NotionClient({
	auth: process.env.NOTION_TOKEN,
});

const pool = new Pool({
	connectionString: process.env.DATABASE_URL,
	ssl: process.env.DATABASE_URL?.includes("localhost") ? false : undefined,
});

// Yahoo OAuth 1.0 endpoints
const YAHOO_REQUEST_TOKEN_URL = "https://api.login.yahoo.com/oauth/v2/get_request_token";
const YAHOO_ACCESS_TOKEN_URL = "https://api.login.yahoo.com/oauth/v2/get_token";

// IMPORTANT: this must match what you put in Yahoo app settings
const BASE_URL = process.env.BASE_URL || "https://ys.driftwoodclimate.com";
const CALLBACK_URL = `${BASE_URL}/callback/yahoo`;

const oauth = new OAuth(
	YAHOO_REQUEST_TOKEN_URL,
	YAHOO_ACCESS_TOKEN_URL,
	process.env.YAHOO_CLIENT_ID,
	process.env.YAHOO_CLIENT_SECRET,
	"1.0",
	CALLBACK_URL,
	"HMAC-SHA1"
);

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
	res.send("OK - Yahoo/Notion sync service is running");
});

// --------- Notion test (kept) ----------
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

// --------- Yahoo OAuth flow ----------
app.get("/connect/yahoo", async (req, res) => {
	try {
		if (!process.env.YAHOO_CLIENT_ID || !process.env.YAHOO_CLIENT_SECRET) {
			return res.status(400).send("Missing YAHOO_CLIENT_ID or YAHOO_CLIENT_SECRET env vars");
		}

		oauth.getOAuthRequestToken((err, token, tokenSecret, results) => {
			if (err) {
				console.error(err);
				return res.status(500).send(`Failed to get request token: ${err.message || String(err)}`);
			}

			// Redirect user to Yahoo authorization page
			const authUrl = results?.xoauth_request_auth_url;
			if (!authUrl) return res.status(500).send("Yahoo did not return xoauth_request_auth_url");

			// We need tokenSecret later in callback; simplest is to store temporarily in Postgres keyed by request token.
			// Minimal approach: store it in a separate table.
			(async () => {
				await ensureTables();
				await pool.query(`
					CREATE TABLE IF NOT EXISTS yahoo_request_tokens (
						oauth_token TEXT PRIMARY KEY,
						oauth_token_secret TEXT NOT NULL,
						created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
					);
				`);
				await pool.query(
					`INSERT INTO yahoo_request_tokens (oauth_token, oauth_token_secret) VALUES ($1, $2)
					 ON CONFLICT (oauth_token) DO UPDATE SET oauth_token_secret = EXCLUDED.oauth_token_secret`,
					[token, tokenSecret]
				);

				return res.redirect(authUrl);
			})().catch((e) => {
				console.error(e);
				return res.status(500).send("Failed to store request token");
			});
		});
	} catch (err) {
		console.error(err);
		res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

app.get("/callback/yahoo", async (req, res) => {
	try {
		const { oauth_token, oauth_verifier } = req.query;

		if (!oauth_token || !oauth_verifier) {
			return res.status(400).send("Missing oauth_token or oauth_verifier in callback");
		}

		// Look up token secret we stored during /connect/yahoo
		await ensureTables();
		const { rows } = await pool.query(
			`SELECT oauth_token_secret FROM yahoo_request_tokens WHERE oauth_token = $1`,
			[String(oauth_token)]
		);

		if (!rows[0]) return res.status(400).send("Request token not found. Try /connect/yahoo again.");

		const requestTokenSecret = rows[0].oauth_token_secret;

		oauth.getOAuthAccessToken(
			String(oauth_token),
			requestTokenSecret,
			String(oauth_verifier),
			async (err, accessToken, accessTokenSecret, results) => {
				if (err) {
					console.error(err);
					return res.status(500).send(`Failed to get access token: ${err.message || String(err)}`);
				}

				const sessionHandle = results?.oauth_session_handle;

				await saveYahooTokens({
					token: accessToken,
					tokenSecret: accessTokenSecret,
					sessionHandle,
				});

				res.send("Yahoo connected ✅ Tokens saved. Next: call /yahoo/token-status");
			}
		);
	} catch (err) {
		console.error(err);
		res.status(500).send(`Error: ${err.message || String(err)}`);
	}
});

app.get("/yahoo/token-status", async (req, res) => {
	const t = await getYahooTokens();
	if (!t) return res.status(404).send("No Yahoo tokens saved yet. Go to /connect/yahoo first.");
	res.send("Yahoo tokens are saved ✅");
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server running on port ${port}`);
	console.log(`Callback URL: ${CALLBACK_URL}`);
});
