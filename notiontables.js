import { Client as NotionClient } from "@notionhq/client";
import { NOTION_TOKEN, requireEnv } from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);

const notion = new NotionClient({
  auth: NOTION_TOKEN,
  // If you've pinned an API version, keep or add this:
  // notionVersion: "2026-03-11",
});

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
        notion.blocks.update({
          block_id: b.id,
          in_trash: true,
        })
      )
    );
  }
}

function rt(text) {
  return [
    {
      type: "text",
      text: {
        content: String(text ?? "").slice(0, 2000),
      },
    },
  ];
}

function makeTableBlock(columns, rowsChunk) {
  const tableRows = [];

  // Header row
  tableRows.push({
    object: "block",
    type: "table_row",
    table_row: {
      cells: columns.map((c) => rt(c)),
    },
  });

  for (const r of rowsChunk) {
    if (r.length !== columns.length) {
      throw new Error(
        `Row length ${r.length} does not match columns length ${columns.length}`
      );
    }

    tableRows.push({
      object: "block",
      type: "table_row",
      table_row: {
        cells: r.map((cell) => rt(cell ?? "")),
      },
    });
  }

  return {
    object: "block",
    type: "table",
    table: {
      table_width: columns.length,
      has_column_header: true,
      has_row_header: false,
      children: tableRows,
    },
  };
}

export async function overwritePageWithTable(
  pageId,
  headerLines,
  columns,
  rows
) {
  if (!pageId) {
    throw new Error("pageId is required");
  }

  // wipe
  const blocks = await listAllChildBlocks(pageId);
  if (blocks.length) await archiveBlocks(blocks);

  const children = [];

  // header lines as paragraphs
  for (const line of headerLines || []) {
    children.push({
      object: "block",
      type: "paragraph",
      paragraph: { rich_text: rt(line) },
    });
  }

  children.push({ object: "block", type: "divider", divider: {} });

  // Chunk rows into multiple tables (max 99 data rows per table)
  const chunkSize = 99;
  const total = rows.length;

  for (let i = 0; i < total; i += chunkSize) {
    const chunk = rows.slice(i, i + chunkSize);

    if (total > chunkSize) {
      children.push({
        object: "block",
        type: "paragraph",
        paragraph: {
          rich_text: rt(
            `Rows ${i + 1}–${Math.min(i + chunk.length, total)}`
          ),
        },
      });
    }

    children.push(makeTableBlock(columns, chunk));

    if (i + chunkSize < total) {
      children.push({ object: "block", type: "divider", divider: {} });
    }
  }

  const batchSize = 10;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + batchSize),
    });
  }
}

/**
 * appendRankedListToPage
 *
 * Appends a divider, a heading, and a numbered list to an already-written page.
 * Does NOT wipe existing content — call this AFTER overwritePageWithTable.
 *
 * @param {string}   pageId    - Notion page ID
 * @param {string}   heading   - e.g. "PROJECTED RUNS RANKING — HIGH TO LOW"
 * @param {string[]} items     - ordered strings, e.g. ["Los Angeles Dodgers — 5.4", ...]
 */
export async function appendRankedListToPage(pageId, heading, items) {
  if (!pageId) throw new Error("pageId is required");

  const children = [
    // visual separator
    { object: "block", type: "divider", divider: {} },
    // bold heading so it's impossible to miss
    {
      object: "block",
      type: "heading_2",
      heading_2: { rich_text: rt(heading) },
    },
  ];

  for (const item of items) {
    children.push({
      object: "block",
      type: "numbered_list_item",
      numbered_list_item: { rich_text: rt(item) },
    });
  }

  // Notion append limit is 100 children per request
  const batchSize = 50;
  for (let i = 0; i < children.length; i += batchSize) {
    await notion.blocks.children.append({
      block_id: pageId,
      children: children.slice(i, i + batchSize),
    });
  }
}
