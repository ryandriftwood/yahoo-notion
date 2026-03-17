import axios from "axios";
import { ensureTables, pool } from "./db.js";
import { YAHOO_CONSUMER_KEY, YAHOO_CONSUMER_SECRET, BASE_URL, requireEnv } from "./config.js";

requireEnv("YAHOO_CONSUMER_KEY", YAHOO_CONSUMER_KEY);
requireEnv("YAHOO_CONSUMER_SECRET", YAHOO_CONSUMER_SECRET);
requireEnv("BASE_URL", BASE_URL);

const OAUTH2_CALLBACK_PATH = "/callback/yahoo-oauth2";
export const REDIRECT_URI = `${BASE_URL}${OAUTH2_CALLBACK_PATH}`;

export const YAHOO_OAUTH2_AUTHORIZE_URL = "https://api.login.yahoo.com/oauth2/request_auth";
const YAHOO_OAUTH2_TOKEN_URL = "https://api.login.yahoo.com/oauth2/get_token";

const YAHOO_FANTASY_BASE = "https://fantasysports.yahooapis.com/fantasy/v2";

function basicAuthHeader() {
	const b64 = Buffer.from(`${YAHOO_CONSUMER_KEY}:${YAHOO_CONSUMER_SECRET}`, "utf8").toString("base64");
	return `Basic ${b64}`;
}

export async function loadTokens() {
	await ensureTables();
	const { rows } = await pool.query(`SELECT * FROM yahoo_oauth2_tokens WHERE id='main'`);
	return rows[0] || null;
}

async function saveTokens(tokenResponse) {
	await ensureTables();

	const now = Math.floor(Date.now() / 1000);
	const expiresIn = tokenResponse.expires_in ? Number(tokenResponse.expires_in) : null;
	const expiresAt = expiresIn ? now + expiresIn - 30 : null;

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

export async function exchangeCodeForTokens(code) {
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
			client_id: YAHOO_CONSUMER_KEY,
			client_secret: YAHOO_CONSUMER_SECRET,
		}).toString(),
		timeout: 10000,
	});

	await saveTokens(r.data);
	return r.data;
}

export async function ensureAccessToken() {
	const tokens = await loadTokens();
	if (!tokens || !tokens.refresh_token) {
		throw new Error("No refresh_token saved yet. Go to /connect/yahoo-oauth2 first.");
	}

	const now = Math.floor(Date.now() / 1000);
	if (tokens.access_token && tokens.expires_at && now < Number(tokens.expires_at)) {
		return tokens.access_token;
	}

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

export async function yahooFantasyGetXml(path) {
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
		timeout: 15000,
	});
	return r.data; // XML string
}
