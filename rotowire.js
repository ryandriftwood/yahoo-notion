// rotowire.js
// Scrapes MLB daily lineups from Rotowire, diffs against last snapshot,
// and writes new/old lineup pages + DB log to Notion when changes are found.

import axios from "axios";
import { Client as NotionClient } from "@notionhq/client";
import {
  NOTION_TOKEN,
  ROTOWIRE_LINEUPS_URL,
  NOTION_LINEUP_NEW_PAGE_ID,
  NOTION_LINEUP_OLD_PAGE_ID,
  NOTION_LINEUP_DB_ID,
  requireEnv,
} from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_LINEUP_NEW_PAGE_ID", NOTION_LINEUP_NEW_PAGE_ID);
requireEnv("NOTION_LINEUP_OLD_PAGE_ID", NOTION_LINEUP_OLD_PAGE_ID);
requireEnv("NOTION_LINEUP_DB_ID", NOTION_LINEUP_DB_ID);

const notion = new NotionClient({ auth: NOTION_TOKEN });
const ROTOWIRE_URL =
  ROTOWIRE_LINEUPS_URL || "https://www.rotowire.com/baseball/daily-lineups.php";

// Positions used to identify player lines in the text
const POSITIONS = new Set(["C","1B","2B","3B","SS","LF","CF","RF","DH","P","SP"]);

// ---------------------------------------------------------------------------
// DEBUG: returns raw text from Rotowire (first 5000 chars exposed via route)
// ---------------------------------------------------------------------------
export async function getRawHtml() {
  const { data } = await axios.get(ROTOWIRE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; yahoo-notion-bot/1.0)" },
    timeout: 15000,
  });
  return typeof data === "string" ? data : JSON.stringify(data);
}

// ---------------------------------------------------------------------------
// 1.  SCRAPE
// ---------------------------------------------------------------------------

export async function scrapeRotowireLineups() {
  const raw = await getRawHtml();
  const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);

  const games = [];

  const timeRe = /^\d{1,2}:\d{2}\s+[AP]M\s+ET$/;
  const statusRe = /^(Confirmed|Expected|Projected)\s+Lineup$/i;
  const posPlayerRe = /^([A-Z0-9]{1,3})\s{2,}(.+?)\s+[LRBS]$/;

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];

    if (!timeRe.test(line)) { i++; continue; }

    const gameTime = line;
    i++;

    while (i < lines.length && !lines[i].match(/^[A-Z]{2,3}$/) && !timeRe.test(lines[i])) i++;
    const awayTeam = lines[i] ?? "AWAY";
    i++;

    while (i < lines.length && !lines[i].match(/^[A-Z]{2,3}$/) && !statusRe.test(lines[i]) && !timeRe.test(lines[i])) i++;
    const homeTeam = lines[i] ?? "HOME";
    i++;

    const parseNextLineup = () => {
      while (i < lines.length && !statusRe.test(lines[i]) && !timeRe.test(lines[i])) i++;
      if (i >= lines.length || timeRe.test(lines[i])) return null;

      const statusMatch = lines[i].match(statusRe);
      const status = statusMatch?.[1]?.toLowerCase() === "confirmed" ? "confirmed" : "projected";
      i++;

      const players = [];
      while (i < lines.length) {
        const l = lines[i];
        if (timeRe.test(l) || statusRe.test(l)) break;
        if (
          l.startsWith("$") ||
          l.startsWith("-") ||
          l.match(/^\d+-\d+/) ||
          l.match(/^\*\*/) ||
          l.match(/^(LINE|O\/U|Umpire|Watch|Alerts|Dome|Precipitation|Wind|Temperature)/i)
        ) { i++; continue; }
        const m = l.match(posPlayerRe);
        if (m && POSITIONS.has(m[1])) {
          players.push(`${m[1]} ${m[2].trim()}`);
        }
        i++;
      }
      return { status, players };
    };

    const awayLineup = parseNextLineup() ?? { status: "projected", players: [] };
    const homeLineup = parseNextLineup() ?? { status: "projected", players: [] };

    const gameId = `${awayTeam}-${homeTeam}`;
    games.push({ gameId, awayTeam, homeTeam, gameTime, awayLineup, homeLineup });
  }

  return { scrapedAt: new Date().toISOString(), games };
}

// ---------------------------------------------------------------------------
// 2.  DIFF
// ---------------------------------------------------------------------------

export function hasLineupChanged(oldSnapshot, newSnapshot) {
  if (!oldSnapshot) return true;

  const oldMap = Object.fromEntries((oldSnapshot.games || []).map((g) => [g.gameId, g]));
  const newMap = Object.fromEntries((newSnapshot.games || []).map((g) => [g.gameId, g]));

  const oldIds = Object.keys(oldMap).sort();
  const newIds = Object.keys(newMap).sort();
  if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) return true;

  for (const id of newIds) {
    const o = oldMap[id];
    const n = newMap[id];
    if (!o || !n) return true;
    for (const side of ["awayLineup", "homeLineup"]) {
      if (o[side].status !== n[side].status) return true;
      if (JSON.stringify(o[side].players) !== JSON.stringify(n[side].players)) return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 3.  FORMAT
// ---------------------------------------------------------------------------

function formatSnapshot(snapshot) {
  const ts = new Date(snapshot.scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });

  const lines = [`MLB Lineups -- scraped ${ts} MT`, ""];
  for (const game of snapshot.games) {
    lines.push(`${game.awayTeam} @ ${game.homeTeam}  |  ${game.gameTime}`);
    lines.push(`  AWAY (${game.awayLineup.status.toUpperCase()}): ${game.awayLineup.players.join(", ") || "(no players)"}`);
    lines.push(`  HOME (${game.homeLineup.status.toUpperCase()}): ${game.homeLineup.players.join(", ") || "(no players)"}`);
    lines.push("");
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4.  NOTION HELPERS
// ---------------------------------------------------------------------------

async function listAllChildBlocks(blockId) {
  let cursor = undefined;
  const all = [];
  while (true) {
    const resp = await notion.blocks.children.list({ block_id: blockId, start_cursor: cursor, page_size: 100 });
    all.push(...resp.results);
    if (!resp.has_more) break;
    cursor = resp.next_cursor;
  }
  return all;
}

async function archiveBlocks(blocks) {
  const batchSize = 10;
  for (let i = 0; i < blocks.length; i += batchSize) {
    const batch = blocks.slice(i, i + batchSize);
    await Promise.all(batch.map((b) => notion.blocks.update({ block_id: b.id, in_trash: true })));
  }
}

function splitIntoParagraphChunks(text, maxLen = 1900) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > maxLen) {
      if (current.trim().length > 0) chunks.push(current.trimEnd());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim().length > 0) chunks.push(current.trimEnd());
  return chunks;
}

async function overwritePageWithMarkdown(pageId, markdown) {
  const blocks = await listAllChildBlocks(pageId);
  if (blocks.length) await archiveBlocks(blocks);
  const chunks = splitIntoParagraphChunks(markdown);
  const children = chunks.map((chunk) => ({
    object: "block", type: "paragraph",
    paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] },
  }));
  const batchSize = 20;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({ block_id: pageId, children: children.slice(i, i + batchSize) });
  }
}

async function logLineupRun({ label, gamesCount, changesDetected }) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hour12: false,
  });
  await notion.pages.create({
    parent: { database_id: NOTION_LINEUP_DB_ID },
    properties: {
      Name: { title: [{ type: "text", text: { content: label } }] },
      "Scraped At": { rich_text: [{ type: "text", text: { content: ts } }] },
      Games: { number: gamesCount },
      "Changes Detected": { checkbox: changesDetected },
    },
  });
}

// ---------------------------------------------------------------------------
// 5.  SNAPSHOT STATE
// ---------------------------------------------------------------------------

let _lastSnapshot = null;
async function loadLastSnapshot() { return _lastSnapshot; }
async function saveSnapshot(snapshot) { _lastSnapshot = snapshot; }

// ---------------------------------------------------------------------------
// 6.  MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function runLineupSync() {
  const newSnapshot = await scrapeRotowireLineups();
  const oldSnapshot = await loadLastSnapshot();
  const changed = hasLineupChanged(oldSnapshot, newSnapshot);

  if (!changed) {
    console.log("[lineup] No changes detected -- skipping Notion write.");
    return { changed: false, games: newSnapshot.games.length };
  }

  console.log(`[lineup] Changes detected (${newSnapshot.games.length} games). Updating Notion...`);

  if (oldSnapshot) {
    await overwritePageWithMarkdown(NOTION_LINEUP_OLD_PAGE_ID, formatSnapshot(oldSnapshot));
  }

  await overwritePageWithMarkdown(NOTION_LINEUP_NEW_PAGE_ID, formatSnapshot(newSnapshot));
  await saveSnapshot(newSnapshot);

  const ts = new Date(newSnapshot.scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Denver", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  });
  await logLineupRun({ label: `Lineup update ${ts}`, gamesCount: newSnapshot.games.length, changesDetected: true });

  return { changed: true, games: newSnapshot.games.length };
}
