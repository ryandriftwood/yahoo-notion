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

	await pool.query(`
		CREATE TABLE IF NOT EXISTS lineup_snapshot (
			id TEXT PRIMARY KEY DEFAULT 'current',
			snapshot JSONB NOT NULL,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
		);
	`);

	await pool.query(`
		CREATE TABLE IF NOT EXISTS player_season_stats (
			player_key   TEXT,
			player_id    TEXT,
			full_name    TEXT,
			mlb_team     TEXT,
			positions    TEXT,
			status       TEXT,
			or_rank      INTEGER,
			stat_key     TEXT,
			stat_value   TEXT,
			updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (player_key, stat_key)
		);
	`);

	await pool.query(`
		CREATE TABLE IF NOT EXISTS player_7day_stats (
			player_key    TEXT,
			full_name     TEXT,
			mlb_team      TEXT,
			positions     TEXT,
			status        TEXT,
			or_rank       INTEGER,
			stat_key      TEXT,
			stat_value    TEXT,
			snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
			updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
			PRIMARY KEY (player_key, stat_key, snapshot_date)
		);
	`);
}
