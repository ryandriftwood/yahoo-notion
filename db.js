import pg from "pg";
import { DATABASE_URL, requireEnv } from "./config.js";

const { Pool } = pg;

requireEnv("DATABASE_URL", DATABASE_URL);

export const pool = new Pool({ connectionString: DATABASE_URL });

export async function ensureTables() {
	await pool.query(`
		CREATE TABLE IF NOT EXISTS yahoo_oauth2_tokens (
			id TEXT PRIMARY KEY DEFAULT 'main',
			access_token TEXT,
			refresh_token TEXT,
			token_type TEXT,
			expires_at BIGINT,
			scope TEXT,
			raw_json TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);
}
