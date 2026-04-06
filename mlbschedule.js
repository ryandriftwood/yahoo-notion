// mlbschedule.js
// Fetches the MLB schedule from the MLB Stats API and, for today/tomorrow syncs,
// enriches each game with implied run totals derived from The Odds API (h2h + totals).
//
// MLB Stats API (free, no auth): https://statsapi.mlb.com/api/v1/schedule
// The Odds API (requires ODDS_API_KEY): https://api.the-odds-api.com/v4/sports/baseball_mlb/odds
//
// Implied run total methodology:
//   1. Pull game total (over/under) and moneyline for both teams from The Odds API.
//   2. Convert moneyline → win probability (no-vig):
//        ML < 0:  p = (-ML) / (-ML + 100)
//        ML > 0:  p = 100  / (ML  + 100)
//   3. Normalize the two raw probabilities to sum to 1.0 (remove vig).
//   4. Split total proportionally:
//        home implied = total × p_home_norm
//        away implied = total × p_away_norm
//   If odds are unavailable for a game, the implied columns show "—".
//
// After the game table, a ranked list is appended:
//   PROJECTED RUNS RANKING — HIGH TO LOW
//   1. Los Angeles Dodgers — 5.4
//   2. Atlanta Braves — 5.1
//   ...

import axios from "axios";
import {
  NOTION_TOKEN,
  ODDS_API_KEY,
  MLB_SCHEDULE_TODAY_PAGE_ID,
  MLB_SCHEDULE_TOMORROW_PAGE_ID,
  MLB_SCHEDULE_WEEK_PAGE_ID,
  requireEnv,
} from "./config.js";
import { logRun } from "./notion.js";
import { overwritePageWithTable, appendRankedListToPage } from "./notiontables.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("ODDS_API_KEY", ODDS_API_KEY);
requireEnv("MLB_SCHEDULE_TODAY_PAGE_ID", MLB_SCHEDULE_TODAY_PAGE_ID);
requireEnv("MLB_SCHEDULE_TOMORROW_PAGE_ID", MLB_SCHEDULE_TOMORROW_PAGE_ID);
requireEnv("MLB_SCHEDULE_WEEK_PAGE_ID", MLB_SCHEDULE_WEEK_PAGE_ID);

const MLB_API_BASE  = "https://statsapi.mlb.com/api/v1/schedule";
const ODDS_API_BASE = "https://api.the-odds-api.com/v4/sports/baseball_mlb/odds";

// ── Date helpers (Mountain Time) ───────────────────────────────────────────────

function getMtDate(offsetDays = 0) {
  const now = new Date();
  const shifted = new Date(now.getTime() + offsetDays * 24 * 60 * 60 * 1000);
  return shifted.toLocaleDateString("en-CA", { timeZone: "America/Denver" }); // YYYY-MM-DD
}

function getMtTimestamp() {
  return new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
}

// ── MLB Stats API ──────────────────────────────────────────────────────────────────

async function fetchSchedule({ date, startDate, endDate }) {
  const params = { sportId: 1, hydrate: "team,venue" };
  if (date) {
    params.date = date;
  } else {
    params.startDate = startDate;
    params.endDate   = endDate;
  }
  const resp = await axios.get(MLB_API_BASE, { params, timeout: 15000 });
  return resp.data;
}

// ── The Odds API ─────────────────────────────────────────────────────────────────

function mlToProb(ml) {
  if (ml < 0) return (-ml) / (-ml + 100);
  return 100 / (ml + 100);
}

function normaliseName(name) {
  return String(name || "").trim().toLowerCase();
}

async function fetchOddsMap() {
  const oddsMap = new Map(); // key: "away_norm|home_norm" → { total, awayML, homeML }

  try {
    const resp = await axios.get(ODDS_API_BASE, {
      params: {
        apiKey: ODDS_API_KEY,
        regions: "us",
        markets: "h2h,totals",
        oddsFormat: "american",
      },
      timeout: 15000,
    });

    for (const event of (resp.data || [])) {
      const awayName = normaliseName(event.away_team);
      const homeName = normaliseName(event.home_team);
      const key = `${awayName}|${homeName}`;

      let total = null;
      let awayML = null;
      let homeML = null;

      for (const bk of (event.bookmakers || [])) {
        const h2hMarket    = bk.markets?.find(m => m.key === "h2h");
        const totalsMarket = bk.markets?.find(m => m.key === "totals");
        if (!h2hMarket || !totalsMarket) continue;

        const overOutcome = totalsMarket.outcomes?.find(o => o.name === "Over");
        if (!overOutcome?.point) continue;

        const awayOutcome = h2hMarket.outcomes?.find(o => normaliseName(o.name) === awayName);
        const homeOutcome = h2hMarket.outcomes?.find(o => normaliseName(o.name) === homeName);
        if (!awayOutcome || !homeOutcome) continue;

        total  = overOutcome.point;
        awayML = awayOutcome.price;
        homeML = homeOutcome.price;
        break;
      }

      if (total !== null && awayML !== null && homeML !== null) {
        oddsMap.set(key, { total, awayML, homeML });
      }
    }
  } catch (err) {
    // Non-fatal: sync still runs; implied columns will show "—"
    console.error("[mlbschedule] Odds API fetch failed:", err?.message || err);
  }

  return oddsMap;
}

// Returns { awayImplied, homeImplied } as numeric strings ("3.8") or "—"
function computeImplied(oddsEntry) {
  if (!oddsEntry) return { awayImplied: "—", homeImplied: "—" };

  const { total, awayML, homeML } = oddsEntry;
  const rawAway = mlToProb(awayML);
  const rawHome = mlToProb(homeML);
  const sum     = rawAway + rawHome;

  const pAway = rawAway / sum;
  const pHome = rawHome / sum;

  return {
    awayImplied: (total * pAway).toFixed(1),
    homeImplied: (total * pHome).toFixed(1),
  };
}

// ── Parse schedule → table rows ─────────────────────────────────────────────────────

function parseScheduleToRows(data, oddsMap = null) {
  const rows = [];

  for (const dateEntry of (data.dates || [])) {
    for (const game of (dateEntry.games || [])) {
      const gameDate = dateEntry.date;

      let timeMt = "TBD";
      if (game.gameDate) {
        timeMt = new Date(game.gameDate).toLocaleTimeString("en-US", {
          timeZone: "America/Denver",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
      }

      const away   = game.teams?.away?.team?.name || "—";
      const home   = game.teams?.home?.team?.name || "—";
      const venue  = game.venue?.name             || "—";
      const status = game.status?.detailedState   || "—";

      if (oddsMap) {
        const key                         = `${normaliseName(away)}|${normaliseName(home)}`;
        const oddsEntry                   = oddsMap.get(key) || null;
        const ouTotal                     = oddsEntry ? String(oddsEntry.total) : "—";
        const { awayImplied, homeImplied } = computeImplied(oddsEntry);
        rows.push([gameDate, timeMt, away, home, venue, status, ouTotal, awayImplied, homeImplied]);
      } else {
        rows.push([gameDate, timeMt, away, home, venue, status]);
      }
    }
  }

  return rows;
}

// ── Build projected runs ranking list ─────────────────────────────────────────────
//
// Flattens every team from every game into a single list ranked high → low.
// Teams with no odds data are omitted from the ranking.
// Returns an array of strings like ["Los Angeles Dodgers — 5.4", ...]

function buildRunsRanking(data, oddsMap) {
  const entries = [];

  for (const dateEntry of (data.dates || [])) {
    for (const game of (dateEntry.games || [])) {
      const away = game.teams?.away?.team?.name || "—";
      const home = game.teams?.home?.team?.name || "—";
      const key  = `${normaliseName(away)}|${normaliseName(home)}`;
      const { awayImplied, homeImplied } = computeImplied(oddsMap.get(key));

      if (awayImplied !== "—") entries.push({ team: away, runs: Number(awayImplied) });
      if (homeImplied !== "—") entries.push({ team: home, runs: Number(homeImplied) });
    }
  }

  entries.sort((a, b) => b.runs - a.runs);

  return entries.map(e => `${e.team} — ${e.runs.toFixed(1)}`);
}

// ── Write helpers ───────────────────────────────────────────────────────────────────

async function writeScheduleToNotion(pageId, headerLines, rows, withOdds = false) {
  const baseColumns = ["Date", "Time (MT)", "Away", "Home", "Venue", "Status"];
  const oddsColumns = ["O/U", "Away Runs", "Home Runs"];
  const columns     = withOdds ? [...baseColumns, ...oddsColumns] : baseColumns;
  const emptyRow    = withOdds
    ? ["No games scheduled", "", "", "", "", "", "", "", ""]
    : ["No games scheduled", "", "", "", "", ""];

  await overwritePageWithTable(pageId, headerLines, columns, rows.length ? rows : [emptyRow]);
}

// ── Public sync functions ────────────────────────────────────────────────────────

export async function runMlbScheduleTodaySync() {
  const date      = getMtDate(0);
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&date=${date}`;

  const [scheduleData, oddsMap] = await Promise.all([
    fetchSchedule({ date }),
    fetchOddsMap(),
  ]);

  const rows    = parseScheduleToRows(scheduleData, oddsMap);
  const ranking = buildRunsRanking(scheduleData, oddsMap);

  const headerLines = [
    `MLB Schedule — Today (${date})`,
    `Last synced: ${ts} MT`,
    `Implied runs = O/U split by moneyline win probability (no-vig)`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_TODAY_PAGE_ID, headerLines, rows, true);

  await appendRankedListToPage(
    MLB_SCHEDULE_TODAY_PAGE_ID,
    `PROJECTED RUNS RANKING — HIGH TO LOW`,
    ranking.length ? ranking : ["No odds data available"]
  );

  await logRun({ name: `MLB Schedule Today (${date}) — ${new Date().toISOString()}` });

  return { date, games: rows.length };
}

export async function runMlbScheduleTomorrowSync() {
  const date      = getMtDate(1);
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&date=${date}`;

  const [scheduleData, oddsMap] = await Promise.all([
    fetchSchedule({ date }),
    fetchOddsMap(),
  ]);

  const rows    = parseScheduleToRows(scheduleData, oddsMap);
  const ranking = buildRunsRanking(scheduleData, oddsMap);

  const headerLines = [
    `MLB Schedule — Tomorrow (${date})`,
    `Last synced: ${ts} MT`,
    `Implied runs = O/U split by moneyline win probability (no-vig)`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_TOMORROW_PAGE_ID, headerLines, rows, true);

  await appendRankedListToPage(
    MLB_SCHEDULE_TOMORROW_PAGE_ID,
    `PROJECTED RUNS RANKING — HIGH TO LOW`,
    ranking.length ? ranking : ["No odds data available"]
  );

  await logRun({ name: `MLB Schedule Tomorrow (${date}) — ${new Date().toISOString()}` });

  return { date, games: rows.length };
}

export async function runMlbScheduleWeekSync() {
  const startDate = getMtDate(2);
  const endDate   = getMtDate(8);
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&startDate=${startDate}&endDate=${endDate}`;

  const data = await fetchSchedule({ startDate, endDate });
  const rows = parseScheduleToRows(data); // no odds for week view

  const headerLines = [
    `MLB Schedule — Week Ahead (${startDate} → ${endDate})`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_WEEK_PAGE_ID, headerLines, rows, false);
  await logRun({ name: `MLB Schedule Week (${startDate}–${endDate}) — ${new Date().toISOString()}` });

  return { startDate, endDate, games: rows.length };
}
