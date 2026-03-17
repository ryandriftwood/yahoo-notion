import { Client as NotionClient } from "@notionhq/client";
import {
	NOTION_TOKEN,
	NOTION_API_UPDATES_LOG_DATABASE_ID,
	requireEnv,
} from "./config.js";

requireEnv("NOTION_TOKEN", NOTION_TOKEN);
requireEnv("NOTION_API_UPDATES_LOG_DATABASE_ID", NOTION_API_UPDATES_LOG_DATABASE_ID);

const notion = new NotionClient({ auth: NOTION_TOKEN });

export async function overwritePageWithMarkdown(pageId, markdown) {
	// Easiest reliable overwrite: append a single big paragraph-ish block set.
	// Notion API doesn’t support “delete all blocks” cleanly without listing/pagination,
	// so we replace by writing a new “Sync Output” section at the top and rely on a consistent marker.
	// v1 approach: append only (simple). v2: we can implement full delete.
	await notion.blocks.children.append({
		block_id: pageId,
		children: [
			{
				object: "block",
				type: "paragraph",
				paragraph: {
					rich_text: [{ type: "text", text: { content: markdown.slice(0, 1900) } }],
				},
			},
		],
	});
}

export async function logRun({ name }) {
	await notion.pages.create({
		parent: { database_id: NOTION_API_UPDATES_LOG_DATABASE_ID },
		properties: {
			Name: { title: [{ type: "text", text: { content: name } }] },
		},
	});
}
