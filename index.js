import express from "express";
import { YAHOO_CONSUMER_KEY } from "./config.js";
import { YAHOO_OAUTH2_AUTHORIZE_URL, REDIRECT_URI, exchangeCodeForTokens } from "./yahoo.js";
import { loadTokens } from "./yahoo.js";
import { runSync } from "./sync.js";
import { seasonStatsRouteHandler } from "./seasonstats.js";
import { sevenDayStatsRouteHandler } from "./sevendaystats.js";
import { runLineupSync, scrapeRotowireLineups, getRawHtml, getFirstCardHtml } from "./rotowire.js";
import {
  runBvpTodaySync,
  runBvpTomorrowSync,
  runSbTodaySync,
  runSbTomorrowSync,
  runAllFicSyncs,
} from "./fantasyinfocentral.js";

const app = express();

app.get("/", (req, res) => res.type("text/plain").send("ok"));

app.get("/connect/yahoo-oauth2", (req, res) => {
	const u = new URL(YAHOO_OAUTH2_AUTHORIZE_URL);
	u.searchParams.set("client_id", YAHOO_CONSUMER_KEY);
	u.searchParams.set("redirect_uri", REDIRECT_URI);
	u.searchParams.set("response_type", "code");
	u.searchParams.set("language", "en-us");
	return res.redirect(u.toString());
});

app.get("/callback/yahoo-oauth2", async (req, res) => {
	try {
		const code = req.query.code;
		if (!code) return res.status(400).send("Missing code");
		await exchangeCodeForTokens(code);
		return res.type("text/plain").send("Yahoo OAuth2 connected ✅ Tokens saved.");
	} catch (e) {
		return res.status(500).send(String(e?.response?.data || e?.message || e));
	}
});

app.get("/yahoo/oauth2/status", async (req, res) => {
	const t = await loadTokens();
	if (!t || !t.refresh_token) return res.status(404).send("No tokens saved yet. Go to /connect/yahoo-oauth2.");
	return res.json({ hasAccessToken: Boolean(t.access_token), hasRefreshToken: Boolean(t.refresh_token), expiresAt: t.expires_at });
});

app.post("/sync", async (req, res) => {
	try {
		const result = await runSync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.response?.data || e?.message || e) });
	}
});

app.post("/sync/seasonstats", seasonStatsRouteHandler());
app.post("/sync/sevendaystats", sevenDayStatsRouteHandler());

// ── Rotowire MLB Lineups ───────────────────────────────────────────────────────────────────
app.post("/sync/lineups", async (req, res) => {
	try {
		const result = await runLineupSync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.response?.data || e?.message || e) });
	}
});

app.get("/debug/lineups", async (req, res) => {
	try {
		const snapshot = await scrapeRotowireLineups();
		res.json(snapshot);
	} catch (e) {
		res.status(500).json({ error: String(e?.message || e) });
	}
});

app.get("/debug/lineups/raw", async (req, res) => {
	try {
		const raw = await getRawHtml();
		res.type("text/plain").send(raw);
	} catch (e) {
		res.status(500).send(String(e?.message || e));
	}
});

app.get("/debug/lineups/card", async (req, res) => {
	try {
		const card = await getFirstCardHtml();
		res.type("text/plain").send(card);
	} catch (e) {
		res.status(500).send(String(e?.message || e));
	}
});

// ── FantasyInfoCentral ───────────────────────────────────────────────────────────────────

// Batter vs Pitcher — Today
app.post("/sync/fic/bvp/today", async (req, res) => {
	try {
		const result = await runBvpTodaySync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}
});

// Batter vs Pitcher — Tomorrow
app.post("/sync/fic/bvp/tomorrow", async (req, res) => {
	try {
		const result = await runBvpTomorrowSync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}
});

// Steal Probability — Today
app.post("/sync/fic/sb/today", async (req, res) => {
	try {
		const result = await runSbTodaySync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}
});

// Steal Probability — Tomorrow
app.post("/sync/fic/sb/tomorrow", async (req, res) => {
	try {
		const result = await runSbTomorrowSync();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}
});

// All four FIC syncs at once (optional convenience route)
app.post("/sync/fic/all", async (req, res) => {
	try {
		const result = await runAllFicSyncs();
		res.json({ ok: true, result });
	} catch (e) {
		res.status(500).json({ ok: false, error: String(e?.message || e) });
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`Server running on port ${port}`));
