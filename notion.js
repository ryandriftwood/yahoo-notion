import { Client as NotionClient } from "@notionhq/client";
import {
	NOTION_TOKEN,
	NOTION_API_UPDATES_LOG_DATABASE_ID,
	requireEnv,
} from "./config.js";

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
	// Archive in small batches to be gentle with rate limits
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

function splitIntoParagraphChunks(text, maxLen = 1800) {
	// Notion rich_text has limits; keep it conservative.
	const lines = text.split("\n");
	const chunks = [];
	let current = "";

	for (const line of lines) {
		// +1 for newline
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
	// 1) Delete existing content
	const blocks = await listAllChildBlocks(pageId);
	if (blocks.length) {
		await archiveBlocks(blocks);
	}

	// 2) Write new content
	const chunks = splitIntoParagraphChunks(markdown);

	const children = chunks.map((chunk) => ({
		object: "block",
		type: "paragraph",
		paragraph: {
			rich_text: [
				{
					type: "text",
					text: { content: chunk },
				},
			],
		},
	}));

	// Append in batches to avoid payload limits
	const batchSize = 20;
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
