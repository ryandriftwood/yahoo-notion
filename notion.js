// notion.js
import { Client as NotionClient } from "@notionhq/client";
import { NOTION_TOKEN, NOTION_API_UPDATES_LOG_DATABASE_ID, requireEnv } from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_API_UPDATES_LOG_DATABASE_ID", NOTION_API_UPDATES_LOG_DATABASE_ID);

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

export async function overwritePageWithMarkdown(pageId, markdown) {
	// True overwrite: delete existing children, then write fresh content
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

export async function overwritePageWithNumberedList(pageId, headerLines, items) {
	// headerLines: string[]
	// items: string[] (NOT pre-numbered)
	const blocks = await listAllChildBlocks(pageId);
	if (blocks.length) await archiveBlocks(blocks);

	const children = [];

	for (const line of headerLines) {
		children.push({
			object: "block",
			type: "paragraph",
			paragraph: {
				rich_text: [{ type: "text", text: { content: String(line).slice(0, 1900) } }],
			},
		});
	}

	children.push({ object: "block", type: "divider", divider: {} });

	for (const item of items) {
		children.push({
			object: "block",
			type: "numbered_list_item",
			numbered_list_item: {
				rich_text: [{ type: "text", text: { content: String(item).slice(0, 1900) } }],
			},
		});
	}

	const batchSize = 50;
	for (let i = 0; i < children.length; i += batchSize) {
		await notion.blocks.children.append({
			block_id: pageId,
			children: children.slice(i, i + batchSize),
		});
	}
}

export async function logRun({ name }) {
	await notion.pages.create({
		parent: { database_id: NOTION_API_UPDATES_LOG_DATABASE_ID },
		properties: {
			Name: { title: [{ type: "text", text: { content: name } }] },
		},
	});
}
