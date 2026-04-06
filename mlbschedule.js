// mlbschedule.js
// Fetches the MLB schedule for today, tomorrow, or a full week from the MLB Stats API
// and overwrites the corresponding Notion pages with a clean game-by-game table.
//
// MLB Stats API (free, no auth): https://statsapi.mlb.com/api/v1/schedule
//   ?sportId=1&date=YYYY-MM-DD                        → single day
//   ?sportId=1&startDate=YYYY-MM-DD&endDate=YYYY-MM-DD → date range

import axios from "axios";
import {
  NOTION_TOKEN,
  MLB_SCHEDULE_TODAY_PAGE_ID,
  MLB_SCHEDULE_TOMORROW_PAGE_ID,
  MLB_SCHEDULE_WEEK_PAGE_ID,
  requireEnv,
} from "./config.js";
import { logRun } from "./notion.js";
import { overwritePageWithTable } from "./notiontables.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("MLB_SCHEDULE_TODAY_PAGE_ID", MLB_SCHEDULE_TODAY_PAGE_ID);
requireEnv("MLB_SCHEDULE_TOMORROW_PAGE_ID", MLB_SCHEDULE_TOMORROW_PAGE_ID);
requireEnv("MLB_SCHEDULE_WEEK_PAGE_ID", MLB_SCHEDULE_WEEK_PAGE_ID);

const MLB_API_BASE = "https://statsapi.mlb.com/api/v1/schedule";

// ── Date helpers (Mountain Time) ─────────────────────────────────────────────

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

// ── MLB Stats API fetch ───────────────────────────────────────────────────────

async function fetchSchedule({ date, startDate, endDate }) {
  const params = { sportId: 1, hydrate: "team,venue" };
  if (date) {
    params.date = date;
  } else {
    params.startDate = startDate;
    params.endDate   = endDate;
  }

  const resp = await axios.get(MLB_API_BASE, { params, timeout: 15000 });
  return resp.data; // { dates: [ { date, games: [...] } ] }
}

// ── Parse API response into table rows ───────────────────────────────────────
//
// Columns: Date | Time (MT) | Away | Home | Venue | Status

function parseScheduleToRows(data) {
  const rows = [];

  for (const dateEntry of (data.dates || [])) {
    for (const game of (dateEntry.games || [])) {
      const gameDate = dateEntry.date; // YYYY-MM-DD

      // Game time → convert UTC ISO to MT
      let timeMt = "TBD";
      if (game.gameDate) {
        timeMt = new Date(game.gameDate).toLocaleTimeString("en-US", {
          timeZone: "America/Denver",
          hour: "numeric",
          minute: "2-digit",
          hour12: true,
        });
      }

      const away   = game.teams?.away?.team?.name  || "—";
      const home   = game.teams?.home?.team?.name  || "—";
      const venue  = game.venue?.name              || "—";
      const status = game.status?.detailedState    || "—";

      rows.push([gameDate, timeMt, away, home, venue, status]);
    }
  }

  return rows;
}

// ── Write to Notion ───────────────────────────────────────────────────────────

async function writeScheduleToNotion(pageId, headerLines, rows) {
  const columns = ["Date", "Time (MT)", "Away", "Home", "Venue", "Status"];

  if (rows.length === 0) {
    await overwritePageWithTable(pageId, headerLines, columns, [["No games scheduled", "", "", "", "", ""]]);
  } else {
    await overwritePageWithTable(pageId, headerLines, columns, rows);
  }
}

// ── Public sync functions ─────────────────────────────────────────────────────

export async function runMlbScheduleTodaySync() {
  const date      = getMtDate(0);
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&date=${date}`;

  const data = await fetchSchedule({ date });
  const rows = parseScheduleToRows(data);

  const headerLines = [
    `MLB Schedule — Today (${date})`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_TODAY_PAGE_ID, headerLines, rows);
  await logRun({ name: `MLB Schedule Today (${date}) — ${new Date().toISOString()}` });

  return { date, games: rows.length };
}

export async function runMlbScheduleTomorrowSync() {
  const date      = getMtDate(1);
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&date=${date}`;

  const data = await fetchSchedule({ date });
  const rows = parseScheduleToRows(data);

  const headerLines = [
    `MLB Schedule — Tomorrow (${date})`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_TOMORROW_PAGE_ID, headerLines, rows);
  await logRun({ name: `MLB Schedule Tomorrow (${date}) — ${new Date().toISOString()}` });

  return { date, games: rows.length };
}

export async function runMlbScheduleWeekSync() {
  // Runs Saturday morning — pulls the following Monday through Sunday (7 days).
  // Saturday = day 0, so Monday ahead = +2, Sunday ahead = +8.
  const startDate = getMtDate(2); // next Monday
  const endDate   = getMtDate(8); // following Sunday
  const ts        = getMtTimestamp();
  const sourceUrl = `${MLB_API_BASE}?sportId=1&startDate=${startDate}&endDate=${endDate}`;

  const data = await fetchSchedule({ startDate, endDate });
  const rows = parseScheduleToRows(data);

  const headerLines = [
    `MLB Schedule — Week Ahead (${startDate} → ${endDate})`,
    `Last synced: ${ts} MT`,
    `Source: ${sourceUrl}`,
  ];

  await writeScheduleToNotion(MLB_SCHEDULE_WEEK_PAGE_ID, headerLines, rows);
  await logRun({ name: `MLB Schedule Week (${startDate}–${endDate}) — ${new Date().toISOString()}` });

  return { startDate, endDate, games: rows.length };
}
