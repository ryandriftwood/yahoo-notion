// notionTables.js
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
					archived: true,
				})
			)
		);
	}
}

function rt(text) {
	return [{ type: "text", text: { content: String(text ?? "").slice(0, 2000) } }];
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

	// build table
	const tableRows = [];

	// header row
	tableRows.push({
		object: "block",
		type: "table_row",
		table_row: {
			cells: columns.map((c) => rt(c)),
		},
	});

	for (const r of rows) {
		tableRows.push({
			object: "block",
			type: "table_row",
			table_row: {
				cells: r.map((cell) => rt(cell ?? "")),
			},
		});
	}

	children.push({
		object: "block",
		type: "table",
		table: {
			table_width: columns.length,
			has_column_header: true,
			has_row_header: false,
			children: tableRows,
		},
	});

	// append (Notion API limit: keep batches small)
	const batchSize = 10;
	for (let i = 0; i < children.length; i += batchSize) {
		await notion.blocks.children.append({
			block_id: pageId,
			children: children.slice(i, i + batchSize),
		});
	}
}
