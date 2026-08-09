import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type SqliteDatabase = Database.Database;

export interface DatabaseOptions {
  path?: string;
  seed?: boolean;
}

function shouldSeedDemoData(configured?: boolean): boolean {
  if (configured !== undefined) return configured;

  const environmentValue = process.env.SEED_DEMO_DATA?.trim().toLowerCase();
  if (environmentValue === "true") return true;
  if (environmentValue === "false") return false;
  return process.env.NODE_ENV !== "production";
}

const schema = `
  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('crypto', 'stock', 'fund', 'wealth', 'cash', 'other')),
    account TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL,
    quantity TEXT NOT NULL DEFAULT '0',
    unit_cost TEXT NOT NULL DEFAULT '0',
    current_price TEXT NOT NULL DEFAULT '0',
    price_mode TEXT NOT NULL DEFAULT 'manual' CHECK (price_mode IN ('manual', 'provider')),
    price_source TEXT NOT NULL DEFAULT 'manual',
    price_updated_at TEXT NOT NULL,
    stale_after_hours INTEGER NOT NULL DEFAULT 24 CHECK (stale_after_hours > 0),
    notes TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_operations (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    operation_type TEXT NOT NULL CHECK (operation_type IN (
      'opening', 'buy', 'sell', 'transfer_in', 'transfer_out',
      'dividend', 'interest', 'fee', 'adjustment', 'claim'
    )),
    quantity_delta TEXT NOT NULL DEFAULT '0',
    unit_price TEXT NOT NULL DEFAULT '0',
    fee TEXT NOT NULL DEFAULT '0',
    currency TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    occurred_at TEXT NOT NULL,
    idempotency_key TEXT,
    created_at TEXT NOT NULL,
    UNIQUE(asset_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id TEXT PRIMARY KEY,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    price TEXT NOT NULL,
    currency TEXT NOT NULL,
    source TEXT NOT NULL,
    as_of_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(asset_id, source, as_of_at)
  );

  CREATE TABLE IF NOT EXISTS expected_assets (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    ecosystem TEXT NOT NULL DEFAULT '',
    stage TEXT NOT NULL CHECK (stage IN (
      'discovered', 'watching', 'eligible', 'claimable',
      'claimed', 'missed', 'expired', 'rejected'
    )),
    health TEXT NOT NULL CHECK (health IN ('healthy', 'due', 'failed', 'risk')),
    next_action TEXT NOT NULL DEFAULT '',
    deadline TEXT,
    estimated_low TEXT NOT NULL DEFAULT '0',
    estimated_high TEXT NOT NULL DEFAULT '0',
    currency TEXT NOT NULL,
    invested_cost TEXT NOT NULL DEFAULT '0',
    confidence TEXT NOT NULL CHECK (confidence IN ('low', 'medium', 'high')),
    source_url TEXT NOT NULL DEFAULT '',
    keywords_json TEXT NOT NULL DEFAULT '[]',
    latest_update TEXT NOT NULL DEFAULT '',
    last_checked_at TEXT NOT NULL,
    next_check_at TEXT NOT NULL,
    notes TEXT NOT NULL DEFAULT '',
    linked_asset_id TEXT REFERENCES assets(id) ON DELETE SET NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS asset_updates (
    id TEXT PRIMARY KEY,
    expected_asset_id TEXT NOT NULL REFERENCES expected_assets(id) ON DELETE CASCADE,
    update_type TEXT NOT NULL DEFAULT 'research',
    title TEXT NOT NULL,
    summary TEXT NOT NULL,
    source_url TEXT NOT NULL DEFAULT '',
    provider TEXT NOT NULL DEFAULT 'manual',
    published_at TEXT,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS tracked_events (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    topic TEXT NOT NULL,
    instructions TEXT NOT NULL,
    schedule TEXT NOT NULL,
    schedule_label TEXT NOT NULL,
    timezone TEXT NOT NULL,
    next_run_at TEXT,
    last_run_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('active', 'paused', 'expired')),
    notify_on_change_only INTEGER NOT NULL DEFAULT 1,
    email_enabled INTEGER NOT NULL DEFAULT 0,
    email_to TEXT NOT NULL DEFAULT '',
    last_run_status TEXT CHECK (last_run_status IS NULL OR last_run_status IN (
      'queued', 'running', 'success', 'no_change', 'failed'
    )),
    last_summary TEXT NOT NULL DEFAULT '',
    version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS monitor_runs (
    id TEXT PRIMARY KEY,
    target_type TEXT NOT NULL CHECK (target_type IN ('event', 'expected')),
    event_id TEXT REFERENCES tracked_events(id) ON DELETE SET NULL,
    expected_asset_id TEXT REFERENCES expected_assets(id) ON DELETE SET NULL,
    status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'success', 'no_change', 'failed')),
    scheduled_for TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    summary TEXT NOT NULL DEFAULT '',
    change_summary TEXT NOT NULL DEFAULT '',
    sources_json TEXT NOT NULL DEFAULT '[]',
    provider TEXT NOT NULL DEFAULT '',
    email_status TEXT NOT NULL DEFAULT 'skipped' CHECK (email_status IN ('skipped', 'pending', 'sent', 'failed')),
    error TEXT NOT NULL DEFAULT '',
    dedupe_key TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    run_id TEXT REFERENCES monitor_runs(id) ON DELETE SET NULL,
    recipient TEXT NOT NULL,
    subject TEXT NOT NULL,
    text_body TEXT NOT NULL,
    html_body TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL CHECK (status IN ('skipped', 'pending', 'sent', 'failed')),
    attempts INTEGER NOT NULL DEFAULT 0,
    next_attempt_at TEXT NOT NULL,
    provider_message_id TEXT NOT NULL DEFAULT '',
    last_error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    sent_at TEXT,
    UNIQUE(run_id, recipient)
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS ai_command_batches (
    id TEXT PRIMARY KEY,
    idempotency_key TEXT NOT NULL UNIQUE,
    actor TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    finished_at TEXT
  );

  CREATE TABLE IF NOT EXISTS ai_command_audit (
    id TEXT PRIMARY KEY,
    batch_id TEXT NOT NULL REFERENCES ai_command_batches(id) ON DELETE CASCADE,
    command_index INTEGER NOT NULL,
    command_type TEXT NOT NULL,
    target_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('applied', 'proposal', 'dry_run', 'failed')),
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(batch_id, command_index)
  );

  CREATE INDEX IF NOT EXISTS idx_asset_operations_asset_time
    ON asset_operations(asset_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_price_snapshots_asset_time
    ON price_snapshots(asset_id, as_of_at DESC);
  CREATE INDEX IF NOT EXISTS idx_expected_assets_next_check
    ON expected_assets(next_check_at);
  CREATE INDEX IF NOT EXISTS idx_asset_updates_expected_time
    ON asset_updates(expected_asset_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tracked_events_next_run
    ON tracked_events(status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_monitor_runs_event_time
    ON monitor_runs(event_id, scheduled_for DESC);
  CREATE INDEX IF NOT EXISTS idx_email_outbox_due
    ON email_outbox(status, next_attempt_at);
`;

const defaultSettings: Record<string, string> = {
  baseCurrency: "USD",
  timezone: "Asia/Shanghai",
  locale: "zh-CN",
  proxyUrl: process.env.HTTPS_PROXY ?? process.env.HTTP_PROXY ?? "",
  aiProvider: process.env.AI_PROVIDER ?? (process.env.NODE_ENV === "production" ? "none" : "mock"),
  aiBaseUrl: process.env.OPENAI_BASE_URL ?? "",
  aiModel: process.env.OPENAI_MODEL ?? (process.env.NODE_ENV === "production" ? "" : "mock-research-v1"),
  smtpHost: process.env.SMTP_HOST ?? "",
  smtpPort: process.env.SMTP_PORT ?? "587",
  smtpSecure: process.env.SMTP_SECURE ?? "false",
  smtpFrom: process.env.SMTP_FROM ?? "",
  notificationEmail: process.env.NOTIFICATION_EMAIL ?? "",
};

function ensureParentDirectory(databasePath: string): string {
  if (databasePath === ":memory:") return databasePath;
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

function initializeSettings(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES (?, ?, ?)",
  );
  const transaction = db.transaction(() => {
    for (const [key, value] of Object.entries(defaultSettings)) {
      insert.run(key, value, now);
    }
  });
  transaction();
}

function seedDemoData(db: SqliteDatabase): void {
  const alreadySeeded = db
    .prepare("SELECT value FROM settings WHERE key = 'demoSeeded'")
    .get() as { value: string } | undefined;
  if (alreadySeeded) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const yesterdayIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrowIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const nextWeekIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const seed = db.transaction(() => {
    db.prepare(`
      INSERT INTO assets (
        id, name, symbol, kind, account, currency, quantity, unit_cost,
        current_price, price_mode, price_source, price_updated_at,
        stale_after_hours, notes, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "demo-btc",
      "Bitcoin",
      "BTC",
      "crypto",
      "Demo Wallet",
      "USD",
      "0.25",
      "42000",
      "68420",
      "manual",
      "manual",
      yesterdayIso,
      24,
      "Example asset; replace it with your own holding.",
      nowIso,
      nowIso,
    );

    db.prepare(`
      INSERT INTO asset_operations (
        id, asset_id, operation_type, quantity_delta, unit_price, fee,
        currency, note, occurred_at, idempotency_key, created_at
      ) VALUES (?, ?, 'opening', ?, ?, '0', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      "demo-btc",
      "0.25",
      "42000",
      "USD",
      "Demo opening balance",
      yesterdayIso,
      "demo-opening-btc",
      nowIso,
    );

    db.prepare(`
      INSERT INTO price_snapshots (
        id, asset_id, price, currency, source, as_of_at, fetched_at, raw_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(randomUUID(), "demo-btc", "68420", "USD", "manual", yesterdayIso, nowIso, nowIso);

    db.prepare(`
      INSERT INTO expected_assets (
        id, name, category, ecosystem, stage, health, next_action, deadline,
        estimated_low, estimated_high, currency, invested_cost, confidence,
        source_url, keywords_json, latest_update, last_checked_at, next_check_at,
        notes, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "demo-airdrop",
      "Example Protocol Airdrop",
      "airdrop",
      "Ethereum",
      "watching",
      "due",
      "Check official eligibility announcement",
      nextWeekIso,
      "100",
      "500",
      "USD",
      "25",
      "low",
      "https://example.com",
      JSON.stringify(["airdrop", "eligibility"]),
      "Awaiting the first research check.",
      yesterdayIso,
      nowIso,
      "Example expected asset.",
      nowIso,
      nowIso,
    );

    db.prepare(`
      INSERT INTO tracked_events (
        id, name, topic, instructions, schedule, schedule_label, timezone,
        next_run_at, last_run_at, status, notify_on_change_only, email_enabled,
        email_to, last_run_status, last_summary, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 1, 0, '', NULL, '', 1, ?, ?)
    `).run(
      "demo-event",
      "Weekly market policy watch",
      "Digital asset regulation",
      "Find material policy changes and cite primary sources.",
      "0 9 * * 1",
      "Every Monday at 09:00",
      "Asia/Shanghai",
      tomorrowIso,
      nowIso,
      nowIso,
    );

    db.prepare(
      "INSERT INTO settings (key, value, updated_at) VALUES ('demoSeeded', 'true', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
    ).run(nowIso);
  });

  seed();
}

export function openDatabase(options: DatabaseOptions = {}): SqliteDatabase {
  const databasePath = ensureParentDirectory(
    options.path ?? process.env.DATABASE_PATH ?? "./data/finance.sqlite",
  );
  const db = new Database(databasePath);
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("journal_mode = WAL");
  db.exec(schema);
  initializeSettings(db);
  if (shouldSeedDemoData(options.seed)) seedDemoData(db);
  return db;
}
