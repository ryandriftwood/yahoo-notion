// rotowire-projected.js
// Scrapes tomorrow's PROJECTED lineups from Rotowire once per day
// and writes them to a dedicated Notion page.
// No diffing, no snapshot DB, no lineup-log database — just fetch → parse → write.

import axios from "axios";
import { Client as NotionClient } from "@notionhq/client";
import {
  NOTION_TOKEN,
  NOTION_PROJECTED_LINEUP_PAGE_ID,
  BROWSERLESS_TOKEN,
  requireEnv,
} from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_PROJECTED_LINEUP_PAGE_ID", NOTION_PROJECTED_LINEUP_PAGE_ID);
requireEnv("BROWSERLESS_TOKEN", BROWSERLESS_TOKEN);

const notion = new NotionClient({ auth: NOTION_TOKEN });

const ROTOWIRE_TOMORROW_URL =
  "https://www.rotowire.com/baseball/daily-lineups.php?date=tomorrow";

// ---------------------------------------------------------------------------
// BROWSER HELPER
// ---------------------------------------------------------------------------

async function getRenderedHtml() {
  const response = await axios.post(
    `https://production-sfo.browserless.io/content?token=${BROWSERLESS_TOKEN}`,
    {
      url: ROTOWIRE_TOMORROW_URL,
      bestAttempt: true,
      gotoOptions: { waitUntil: "networkidle2" },
      waitForSelector: { selector: ".lineup__player", timeout: 15000 },
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

// ---------------------------------------------------------------------------
// HELPERS
// ---------------------------------------------------------------------------

function getAttr(tagHtml, attrName) {
  const re = new RegExp(`${attrName}="([^"]*)"`, "i");
  return tagHtml.match(re)?.[1] ?? null;
}

// ---------------------------------------------------------------------------
// PARSE ONE LINEUP LIST  (reused pattern from rotowire.js)
// ---------------------------------------------------------------------------

function parseList(listHtml) {
  // Status: projected lineups won't be confirmed, but check anyway
  const status = /class="[^"]*lineup__status[^"]*is-confirmed[^"]*"/.test(listHtml)
    ? "confirmed"
    : "projected";

  // SP
  let sp = null;
  const spLiMatch = listHtml.match(
    /<li[^>]+class="[^"]*lineup__player-highlight[^"]*"[^>]*>([\s\S]*?)<\/li>/
  );
  if (spLiMatch) {
    const spBlock = spLiMatch[1];
    const aMatch = spBlock.match(/<a([^>]*)>([^<]+)<\/a>/);
    if (aMatch) {
      const title = getAttr(aMatch[1], "title");
      const name = (title || aMatch[2]).trim();
      const throwsMatch = spBlock.match(
        /<span[^>]+class="[^"]*lineup__throws[^"]*"[^>]*>([^<]+)<\/span>/
      );
      const throws = throwsMatch?.[1]?.trim() ?? "";
      if (name) sp = { name, throws };
    }
  }

  // Batters
  const liRe =
    /<li[^>]+class="[^"]*\blineup__player\b(?!-highlight)[^"]*"[^>]*>([\s\S]*?)<\/li>/g;
  const players = [];
  let li;
  let order = 1;
  while ((li = liRe.exec(listHtml)) !== null) {
    const liContent = li[1];
    const posMatch = liContent.match(
      /<div[^>]+class="[^"]*lineup__pos[^"]*"[^>]*>([^<]+)<\/div>/
    );
    const position = posMatch?.[1]?.trim() ?? "";
    const aMatch = liContent.match(/<a([^>]+)>([^<]+)<\/a>/);
    if (!aMatch) continue;
    const title = getAttr(aMatch[1], "title");
    const name = (title || aMatch[2]).trim();
    if (!name) continue;
    const batsMatch = liContent.match(
      /<span[^>]+class="[^"]*lineup__bats[^"]*"[^>]*>([^<]+)<\/span>/
    );
    const bats = batsMatch?.[1]?.trim() ?? "";
    players.push({ order, position, name, bats });
    order++;
  }

  return { status, sp, players };
}

// ---------------------------------------------------------------------------
// SCRAPE
// ---------------------------------------------------------------------------

async function scrapeTomorrowLineups() {
  const html = await getRenderedHtml();
  const games = [];

  const gameCardRe =
    /<div[^>]+class="[^"]*lineup is-mlb[^"]*"[^>]*>([\s\S]*?)(?=<div[^>]+class="[^"]*lineup is-mlb|<\/section|$)/g;
  let cardMatch;

  while ((cardMatch = gameCardRe.exec(html)) !== null) {
    const card = cardMatch[1];

    const abbrRe = /<div[^>]+class="[^"]*lineup__abbr[^"]*"[^>]*>([^<]+)<\/div>/g;
    const abbrs = [...card.matchAll(abbrRe)];
    const awayTeam = abbrs[0]?.[1]?.trim() ?? "AWAY";
    const homeTeam = abbrs[1]?.[1]?.trim() ?? "HOME";
    if (awayTeam === "AWAY" && homeTeam === "HOME") continue;

    const timeMatch = card.match(
      /<div[^>]+class="[^"]*lineup__time[^"]*"[^>]*>([^<]+)<\/div>/
    );
    const gameTime = timeMatch?.[1]?.trim() ?? "";

    const listRe = /<ul[^>]+class="[^"]*lineup__list[^"]*"[^>]*>([\s\S]*?)<\/ul>/g;
    const lists = [...card.matchAll(listRe)];

    const awayLineup = lists[0]
      ? parseList(lists[0][1])
      : { status: "projected", sp: null, players: [] };
    const homeLineup = lists[1]
      ? parseList(lists[1][1])
      : { status: "projected", sp: null, players: [] };

    games.push({
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
// FORMAT
// ---------------------------------------------------------------------------

function formatLineupSide(label, lineup) {
  const statusLabel =
    lineup.status === "confirmed" ? "✅ CONFIRMED" : "🕒 PROJECTED";
  const spLine = lineup.sp
    ? `  SP: ${lineup.sp.name}${lineup.sp.throws ? ` (${lineup.sp.throws})` : ""}`
    : "  SP: TBD";
  const playerLines = lineup.players.length
    ? lineup.players.map(
        (p) =>
          `  ${String(p.order).padStart(2)}. ${p.position.padEnd(3)} ${p.name}${p.bats ? ` (${p.bats})` : ""}`
      )
    : ["  (no lineup posted)"];
  return [`${label} — ${statusLabel}`, spLine, ...playerLines].join("\n");
}

function formatSnapshot(snapshot) {
  // Tomorrow's date in MT for the header
  const tomorrow = new Date();
  tomorrow.setDate(tomorrow.getDate() + 1);
  const dateStr = tomorrow.toLocaleDateString("en-US", {
    timeZone: "America/Denver",
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });

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

  const lines = [
    `MLB Projected Lineups — ${dateStr}`,
    `(pulled ${ts} MT)`,
    `${snapshot.games.length} games scheduled`,
    "",
  ];

  for (const game of snapshot.games) {
    lines.push(`▶ ${game.awayTeam} @ ${game.homeTeam}  |  ${game.gameTime}`);
    lines.push(formatLineupSide(game.awayTeam, game.awayLineup));
    lines.push("");
    lines.push(formatLineupSide(game.homeTeam, game.homeLineup));
    lines.push("");
    lines.push("─".repeat(50));
    lines.push("");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// NOTION HELPERS  (same pattern as rotowire.js)
// ---------------------------------------------------------------------------

async function listAllChildBlocks(blockId) {
  let cursor;
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
    await Promise.all(
      blocks
        .slice(i, i + batchSize)
        .map((b) => notion.blocks.update({ block_id: b.id, in_trash: true }))
    );
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

async function writePageContent(pageId, markdown) {
  // Clear existing blocks first
  const existing = await listAllChildBlocks(pageId);
  if (existing.length) await archiveBlocks(existing);

  // Write new blocks
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

// ---------------------------------------------------------------------------
// MAIN ENTRY POINT
// ---------------------------------------------------------------------------

export async function runProjectedLineupSync() {
  console.log("[projected-lineup] Scraping tomorrow's lineups from Rotowire...");

  const snapshot = await scrapeTomorrowLineups();

  if (!snapshot.games.length) {
    console.warn("[projected-lineup] No games found — nothing written to Notion.");
    return { games: 0 };
  }

  console.log(
    `[projected-lineup] Found ${snapshot.games.length} games. Writing to Notion page ${NOTION_PROJECTED_LINEUP_PAGE_ID}...`
  );

  const markdown = formatSnapshot(snapshot);
  await writePageContent(NOTION_PROJECTED_LINEUP_PAGE_ID, markdown);

  console.log("[projected-lineup] Done.");
  return { games: snapshot.games.length };
}
