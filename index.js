import express from "express";
import { Client } from "@notionhq/client";

const app = express();

const notion = new Client({
	auth: process.env.NOTION_TOKEN,
});

app.get("/", (req, res) => {
	res.send("OK - Yahoo/Notion sync service is running");
});

// Keep this route because Yahoo will redirect here later.
app.get("/callback/yahoo", (req, res) => {
	res.send("OK - Yahoo callback endpoint reached (we will add OAuth next)");
});

/**
 * Test route: writes to Notion
 * - Appends a paragraph block to your League State page
 * - Creates a new row in your API Updates Log database
 */
app.get("/notion/test", async (req, res) => {
	try {
		const leagueStatePageId = process.env.NOTION_LEAGUE_STATE_PAGE_ID;
		const updatesLogDatabaseId = process.env.NOTION_API_UPDATES_LOG_DATABASE_ID;

		if (!leagueStatePageId) {
			return res.status(400).send("Missing env var NOTION_LEAGUE_STATE_PAGE_ID");
		}
		if (!updatesLogDatabaseId) {
			return res.status(400).send("Missing env var NOTION_API_UPDATES_LOG_DATABASE_ID");
		}

		const now = new Date().toISOString();

		// 1) Append a paragraph block to the league state page
		await notion.blocks.children.append({
			block_id: leagueStatePageId,
			children: [
				{
					object: "block",
					type: "paragraph",
					paragraph: {
						rich_text: [
							{
								type: "text",
								text: { content: `✅ Notion write test from Render at ${now}` },
							},
						],
					},
				},
			],
		});

		// 2) Create a log row in the API Updates Log database
		// NOTE: This assumes your database has at least a Title property (default).
		await notion.pages.create({
			parent: { database_id: updatesLogDatabaseId },
			properties: {
				Name: {
					title: [
						{
							type: "text",
							text: { content: `Sync test ${now}` },
						},
					],
				},
			},
		});

		res.send("Wrote to Notion successfully ✅");
	} catch (err) {
		console.error(err);
		res.status(500).send(`Notion write failed: ${err.message || String(err)}`);
	}
});

const port = process.env.PORT || 3000;
app.listen(port, () => {
	console.log(`Server running on port ${port}`);
});
