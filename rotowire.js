// rotowire.js
import axios from "axios";
import { Client as NotionClient } from "@notionhq/client";
import {
  NOTION_TOKEN,
  ROTOWIRE_LINEUPS_URL,
  NOTION_LINEUP_NEW_PAGE_ID,
  NOTION_LINEUP_OLD_PAGE_ID,
  NOTION_LINEUP_DB_ID,
  BROWSERLESS_TOKEN,
  requireEnv,
} from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_LINEUP_NEW_PAGE_ID", NOTION_LINEUP_NEW_PAGE_ID);
requireEnv("NOTION_LINEUP_OLD_PAGE_ID", NOTION_LINEUP_OLD_PAGE_ID);
requireEnv("NOTION_LINEUP_DB_ID", NOTION_LINEUP_DB_ID);
requireEnv("BROWSERLESS_TOKEN", BROWSERLESS_TOKEN);

const notion = new NotionClient({ auth: NOTION_TOKEN });
const ROTOWIRE_URL =
  ROTOWIRE_LINEUPS_URL || "https://www.rotowire.com/baseball/daily-lineups.php";

// ---------------------------------------------------------------------------
// BROWSER HELPER
// ---------------------------------------------------------------------------

async function getRenderedHtml() {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url: ROTOWIRE_URL,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: ".lineup__list", timeout: 15000 },
      rejectResourceTypes: ["image", "font", "media"],
    },
    {
      headers: { "Content-Type": "application/json", "Cache-Control": "no-cache" },
      timeout: 35000,
      responseType: "text",
    }
  );
  return response.data;
}

export async function getRawHtml() {
  return (await getRenderedHtml()).slice(0, 5000);
}

// DEBUG: raw HTML of the first game card — 8000 chars to capture player list
export async function getFirstCardHtml() {
  const html = await getRenderedHtml();
  const start = html.indexOf('class="lineup is-mlb');
  if (start === -1) return "[No lineup card found — class='lineup is-mlb' not present in HTML]";
  const divStart = html.lastIndexOf("<", start);
  return html.slice(divStart, divStart + 8000);
}

// ---------------------------------------------------------------------------
// 1.  SCRAPE
// ---------------------------------------------------------------------------

export async function scrapeRotowireLineups() {
  const html = await getRenderedHtml();
  const games = [];

  const gameCardRe = /<div[^>]+class="[^"]*lineup is-mlb[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*lineup is-mlb|<\/section|$)/g;
  let cardMatch;

  while ((cardMatch = gameCardRe.exec(html)) !== null) {
    const card = cardMatch[1];

    const abbrRe = /<div[^>]+class="[^"]*lineup__abbr[^"]*"[^>]*>([^<]+)<\/div>/g;
    const abbrs = [...card.matchAll(abbrRe)];
    const awayTeam = abbrs[0]?.[1]?.trim() ?? "AWAY";
    const homeTeam = abbrs[1]?.[1]?.trim() ?? "HOME";
    if (awayTeam === "AWAY" && homeTeam === "HOME") continue;

    const timeMatch = card.match(/<div[^>]+class="[^"]*lineup__time[^"]*"[^>]*>([^<]+)<\/div>/);
    const gameTime = timeMatch?.[1]?.trim() ?? "";

    const listRe = /<ul[^>]+class="([^"]*lineup__list[^"]*?)"[^>]*>([\s\S]*?)<\/ul>/g;
    const lists = [...card.matchAll(listRe)];

    const parseList = (listHtml, classAttr) => {
      const status = classAttr.includes("is-confirmed") ? "confirmed" : "projected";
      const playerRe = /<a[^>]+class="[^"]*lineup__player[^"]*"[^>]*>([^<]+)<\/a>/g;
      const players = [...listHtml.matchAll(playerRe)].map((m) => m[1].trim()).filter(Boolean);
      return { status, players };
    };

    const awayLineup = lists[0] ? parseList(lists[0][2], lists[0][1]) : { status: "projected", players: [] };
    const homeLineup = lists[1] ? parseList(lists[1][2], lists[1][1]) : { status: "projected", players: [] };

    games.push({ gameId: `${awayTeam}-${homeTeam}`, awayTeam, homeTeam, gameTime, awayLineup, homeLineup });
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
    const o = oldMap[id]; const n = newMap[id];
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
  let cursor;
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
    await Promise.all(blocks.slice(i, i + batchSize).map((b) => notion.blocks.update({ block_id: b.id, in_trash: true })));
  }
}

function splitIntoParagraphChunks(text, maxLen = 1900) {
  const lines = text.split("\n");
  const chunks = [];
  let current = "";
  for (const line of lines) {
    if ((current + line + "\n").length > maxLen) {
      if (current.trim()) chunks.push(current.trimEnd());
      current = "";
    }
    current += line + "\n";
  }
  if (current.trim()) chunks.push(current.trimEnd());
  return chunks;
}

async function overwritePageWithMarkdown(pageId, markdown) {
  const blocks = await listAllChildBlocks(pageId);
  if (blocks.length) await archiveBlocks(blocks);
  const chunks = splitIntoParagraphChunks(markdown);
  const children = chunks.map((chunk) => ({ object: "block", type: "paragraph", paragraph: { rich_text: [{ type: "text", text: { content: chunk } }] } }));
  const batchSize = 20;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({ block_id: pageId, children: children.slice(i, i + batchSize) });
  }
}

async function logLineupRun({ label, gamesCount, changesDetected }) {
  const ts = new Date().toLocaleString("en-US", { timeZone: "America/Denver", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
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
  if (oldSnapshot) await overwritePageWithMarkdown(NOTION_LINEUP_OLD_PAGE_ID, formatSnapshot(oldSnapshot));
  await overwritePageWithMarkdown(NOTION_LINEUP_NEW_PAGE_ID, formatSnapshot(newSnapshot));
  await saveSnapshot(newSnapshot);

  const ts = new Date(newSnapshot.scrapedAt).toLocaleString("en-US", { timeZone: "America/Denver", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  await logLineupRun({ label: `Lineup update ${ts}`, gamesCount: newSnapshot.games.length, changesDetected: true });
  return { changed: true, games: newSnapshot.games.length };
}
