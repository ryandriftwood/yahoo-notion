import { Client as NotionClient } from "@notionhq/client";

import { NOTION_TOKEN, requireEnv } from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);

const notion = new NotionClient({ auth: NOTION_TOKEN });

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

cursor = [resp.next](http://resp.next)_cursor;

}

return all;

}

async function archiveBlocks(blocks) {

const batchSize = 10;

for (let i = 0; i < blocks.length; i += batchSize) {

const batch = blocks.slice(i, i + batchSize);

await Promise.all(

[batch.map](http://batch.map)((b) =>

notion.blocks.update({

block_id: [b.id](http://b.id),

archived: true,

})

)

);

}

}

function rt(text) {

return [{ type: "text", text: { content: String(text ?? "").slice(0, 2000) } }];

}

function makeTableBlock(columns, rowsChunk) {

// Notion limit: table children (rows) must be <= 100.

// We'll use 1 header row + up to 99 data rows per table.

const tableRows = [];

// Header row

tableRows.push({

object: "block",

type: "table_row",

table_row: {

cells: [columns.map](http://columns.map)((c) => rt(c)),

},

});

for (const r of rowsChunk) {

tableRows.push({

object: "block",

type: "table_row",

table_row: {

cells: [r.map](http://r.map)((cell) => rt(cell ?? "")),

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

export async function overwritePageWithTable(pageId, headerLines, columns, rows) {

// headerLines: string[]

// columns: string[]

// rows: Array<Array<string | number | null>>

requireEnv("pageId", pageId);

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

// Optional label before each table (helps when there are multiple)

if (total > chunkSize) {

children.push({

object: "block",

type: "paragraph",

paragraph: {

rich_text: rt(`Rows ${i + 1}–${Math.min(i + chunk.length, total)}`),

},

});

}

children.push(makeTableBlock(columns, chunk));

// Divider between tables

if (i + chunkSize < total) {

children.push({ object: "block", type: "divider", divider: {} });

}

}

// append (batch small; table blocks can be large)

const batchSize = 10;

for (let i = 0; i < children.length; i += batchSize) {

await notion.blocks.children.append({

block_id: pageId,

children: children.slice(i, i + batchSize),

});

}

}
