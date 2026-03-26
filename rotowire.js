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

// ---------------------------------------------------------------------------
// 1.  SCRAPE
// ---------------------------------------------------------------------------

/**
 * Fetches Rotowire and returns a structured snapshot:
 * {
 *   scrapedAt: ISO string,
 *   games: [
 *     {
 *       gameId: string,          // e.g. "NYY-BOS"
 *       awayTeam: string,
 *       homeTeam: string,
 *       gameTime: string,
 *       awayLineup: { status: "confirmed"|"projected", players: string[] },
 *       homeLineup: { status: "confirmed"|"projected", players: string[] },
 *     },
 *     ...
 *   ]
 * }
 */
export async function scrapeRotowireLineups() {
  const { data: html } = await axios.get(ROTOWIRE_URL, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; yahoo-notion-bot/1.0)" },
    timeout: 15000,
  });

  const games = [];

  // Each game card lives in a <div class="lineup is-mlb">
  // We parse with regex because we don't have a DOM; keeps deps minimal.
  const gameCardRe =
    /<div[^>]+class="[^"]*lineup is-mlb[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*lineup is-mlb|$)/g;
  let cardMatch;

  while ((cardMatch = gameCardRe.exec(html)) !== null) {
    const card = cardMatch[1];

    // Team abbreviations from .lineup__abbr divs
    const teamAbbrRe = /<div[^>]+class="[^"]*lineup__abbr[^"]*"[^>]*>([^<]+)<\/div>/g;
    const teamMatches = [...card.matchAll(teamAbbrRe)];
    const awayTeam = teamMatches[0]?.[1]?.trim() ?? "AWAY";
    const homeTeam = teamMatches[1]?.[1]?.trim() ?? "HOME";
    const gameId = `${awayTeam}-${homeTeam}`;

    // Game time from .lineup__time
    const timeMatch = card.match(
      /<div[^>]+class="[^"]*lineup__time[^"]*"[^>]*>([^<]+)<\/div>/
    );
    const gameTime = timeMatch?.[1]?.trim() ?? "";

    // Each side's lineup list; class includes "is-confirmed" or "is-projected"
    const listRe =
      /<ul[^>]+class="([^"]*lineup__list[^"]*?)"[^>]*>([\s\S]*?)<\/ul>/g;
    const lists = [...card.matchAll(listRe)];

    const parseList = (listHtml, classAttr) => {
      const status = classAttr.includes("is-confirmed")
        ? "confirmed"
        : "projected";
      const playerRe = /<a[^>]+class="[^"]*lineup__player[^"]*"[^>]*>([^<]+)<\/a>/g;
      const players = [...listHtml.matchAll(playerRe)].map((m) =>
        m[1].trim()
      );
      return { status, players };
    };

    const awayLineup =
      lists[0]
        ? parseList(lists[0][2], lists[0][1])
        : { status: "projected", players: [] };
    const homeLineup =
      lists[1]
        ? parseList(lists[1][2], lists[1][1])
        : { status: "projected", players: [] };

    // skip cards that produced no useful data
    if (awayTeam === "AWAY" && homeTeam === "HOME" && !gameTime) continue;

    games.push({
      gameId,
      awayTeam,
      homeTeam,
      gameTime,
      awayLineup,
      homeLineup,
    });
  }

  return { scrapedAt: new Date().toISOString(), games };
}

// ---------------------------------------------------------------------------
// 2.  DIFF
// ---------------------------------------------------------------------------

/**
 * Returns true if any lineup data changed between oldSnapshot and newSnapshot.
 * Changes include: player added/removed/reordered, or status flip
 * (projected <-> confirmed).
 */
export function hasLineupChanged(oldSnapshot, newSnapshot) {
  // First run ever — treat as a change so the initial state is written
  if (!oldSnapshot) return true;

  const oldMap = Object.fromEntries(
    (oldSnapshot.games || []).map((g) => [g.gameId, g])
  );
  const newMap = Object.fromEntries(
    (newSnapshot.games || []).map((g) => [g.gameId, g])
  );

  // Different set of games (postponements, added games, etc.)
  const oldIds = Object.keys(oldMap).sort();
  const newIds = Object.keys(newMap).sort();
  if (JSON.stringify(oldIds) !== JSON.stringify(newIds)) return true;

  for (const id of newIds) {
    const o = oldMap[id];
    const n = newMap[id];
    if (!o || !n) return true;

    for (const side of ["awayLineup", "homeLineup"]) {
      // Status change (e.g. projected -> confirmed)
      if (o[side].status !== n[side].status) return true;
      // Any player added, removed, or reordered
      if (JSON.stringify(o[side].players) !== JSON.stringify(n[side].players))
        return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// 3.  FORMAT SNAPSHOT -> MARKDOWN
// ---------------------------------------------------------------------------

function formatSnapshot(snapshot) {
  const ts = new Date(snapshot.scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  const lines = [`MLB Lineups -- scraped ${ts} MT`, ""];

  for (const game of snapshot.games) {
    lines.push(`${game.awayTeam} @ ${game.homeTeam}  |  ${game.gameTime}`);
    lines.push(
      `  AWAY (${game.awayLineup.status.toUpperCase()}): ${
        game.awayLineup.players.join(", ") || "(no players)"
      }`
    );
    lines.push(
      `  HOME (${game.homeLineup.status.toUpperCase()}): ${
        game.homeLineup.players.join(", ") || "(no players)"
      }`
    );
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// 4.  NOTION HELPERS (self-contained, no dependency on notion.js)
// ---------------------------------------------------------------------------

async function listAllChildBlocks(blockId) {
  let cursor = undefined;
  const all = [];
  while (true) {
    const resp = await notion.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
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
    await Promise.all(
      batch.map((b) =>
        notion.blocks.update({ block_id: b.id, in_trash: true })
      )
    );
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
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content: chunk } }],
    },
  }));

  const batchSize = 20;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + batchSize),
    });
  }
}

async function logLineupRun({ label, gamesCount, changesDetected }) {
  const ts = new Date().toLocaleString("en-US", {
    timeZone: "America/Denver",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });

  await notion.pages.create({
    parent: { database_id: NOTION_LINEUP_DB_ID },
    properties: {
      Name: {
        title: [{ type: "text", text: { content: label } }],
      },
      "Scraped At": {
        rich_text: [{ type: "text", text: { content: ts } }],
      },
      Games: {
        number: gamesCount,
      },
      "Changes Detected": {
        checkbox: changesDetected,
      },
    },
  });
}

// ---------------------------------------------------------------------------
// 5.  SNAPSHOT STATE
//     _lastSnapshot is in-memory (survives repeated calls in the same process).
//     Swap loadLastSnapshot / saveSnapshot with DB reads/writes if you need
//     persistence across server restarts or multiple workers.
// ---------------------------------------------------------------------------

let _lastSnapshot = null;

async function loadLastSnapshot() {
  return _lastSnapshot;
}

async function saveSnapshot(snapshot) {
  _lastSnapshot = snapshot;
}

// ---------------------------------------------------------------------------
// 6.  MAIN ENTRY POINT
// ---------------------------------------------------------------------------

/**
 * runLineupSync()
 *  1. Scrape Rotowire
 *  2. Diff against last snapshot
 *  3. No change  -> return early
 *  4. Changed    -> archive old lineup page, write new lineup page
 *  5. Log run to Notion DB
 */
export async function runLineupSync() {
  const newSnapshot = await scrapeRotowireLineups();
  const oldSnapshot = await loadLastSnapshot();

  const changed = hasLineupChanged(oldSnapshot, newSnapshot);

  if (!changed) {
    console.log("[lineup] No changes detected -- skipping Notion write.");
    return { changed: false, games: newSnapshot.games.length };
  }

  console.log(
    `[lineup] Changes detected (${newSnapshot.games.length} games). Updating Notion...`
  );

  // Move current "new" page content to the "old" archive page
  if (oldSnapshot) {
    const oldMd = formatSnapshot(oldSnapshot);
    await overwritePageWithMarkdown(NOTION_LINEUP_OLD_PAGE_ID, oldMd);
  }

  // Write the freshly scraped lineup to the live "new" page
  const newMd = formatSnapshot(newSnapshot);
  await overwritePageWithMarkdown(NOTION_LINEUP_NEW_PAGE_ID, newMd);

  // Save for next comparison
  await saveSnapshot(newSnapshot);

  // Log to Notion database
  const ts = new Date(newSnapshot.scrapedAt).toLocaleString("en-US", {
    timeZone: "America/Denver",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  await logLineupRun({
    label: `Lineup update ${ts}`,
    gamesCount: newSnapshot.games.length,
    changesDetected: true,
  });

  return { changed: true, games: newSnapshot.games.length };
}
