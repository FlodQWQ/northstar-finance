import Database from "better-sqlite3";
import {
  createHash,
  randomBytes,
  randomUUID,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

export type SqliteDatabase = Database.Database;

export interface DatabaseOptions {
  path?: string;
  seed?: boolean;
}

export interface BootstrapUserIdentity {
  id: string;
  username: string;
}

export const DATABASE_SCHEMA_VERSION = 2;
export const DEFAULT_OWNER_ID = "00000000-0000-4000-8000-000000000000";
export const BOOTSTRAP_USER_ID = "00000000-0000-4000-8000-000000000001";
export const DEFAULT_OWNER_USERNAME = "__northstar_internal_default__";

const legacyTables = [
  "assets",
  "asset_operations",
  "price_snapshots",
  "expected_assets",
  "asset_updates",
  "tracked_events",
  "monitor_runs",
  "email_outbox",
  "settings",
  "ai_command_batches",
  "ai_command_audit",
] as const;

const legacyIndexes = [
  "idx_asset_operations_asset_time",
  "idx_price_snapshots_asset_time",
  "idx_expected_assets_next_check",
  "idx_asset_updates_expected_time",
  "idx_tracked_events_next_run",
  "idx_monitor_runs_event_time",
  "idx_email_outbox_due",
] as const;

function normalizeUsername(username: string): string {
  return username.trim().normalize("NFKC").toLowerCase();
}

export function hashPasswordScrypt(password: string): string {
  if (!password) throw new Error("Password cannot be empty");
  const cost = 32_768;
  const blockSize = 8;
  const parallelization = 1;
  const keyLength = 32;
  const salt = randomBytes(16);
  const digest = scryptSync(password, salt, keyLength, {
    N: cost,
    r: blockSize,
    p: parallelization,
    maxmem: 64 * 1024 * 1024,
  });
  return [
    "",
    "scrypt",
    `N=${cost},r=${blockSize},p=${parallelization},l=${keyLength}`,
    salt.toString("base64url"),
    digest.toString("base64url"),
  ].join("$");
}

export function verifyPasswordScrypt(password: string, encodedHash: string): boolean {
  const parts = encodedHash.split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return false;
  const parameters = /^N=(\d+),r=(\d+),p=(\d+),l=(\d+)$/.exec(parts[2] ?? "");
  if (!parameters) return false;
  const cost = Number(parameters[1]);
  const blockSize = Number(parameters[2]);
  const parallelization = Number(parameters[3]);
  const keyLength = Number(parameters[4]);
  if (
    !Number.isSafeInteger(cost) ||
    cost < 1_024 ||
    cost > 131_072 ||
    (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) ||
    blockSize < 1 ||
    blockSize > 16 ||
    !Number.isSafeInteger(parallelization) ||
    parallelization < 1 ||
    parallelization > 8 ||
    !Number.isSafeInteger(keyLength) ||
    keyLength < 16 ||
    keyLength > 64
  ) {
    return false;
  }

  try {
    const salt = Buffer.from(parts[3] ?? "", "base64url");
    const expected = Buffer.from(parts[4] ?? "", "base64url");
    if (salt.length < 8 || salt.length > 64 || expected.length !== keyLength) return false;
    const requiredMemory = 128 * cost * blockSize + 2 * 1024 * 1024;
    const supplied = scryptSync(password, salt, keyLength, {
      N: cost,
      r: blockSize,
      p: parallelization,
      maxmem: Math.max(64 * 1024 * 1024, requiredMemory),
    });
    return timingSafeEqual(expected, supplied);
  } catch {
    return false;
  }
}

export function hashApiToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function ownerGuardTriggers(
  triggerName: string,
  table: string,
  foreignColumn: string,
  parentTable: string,
  nullable = false,
): string {
  const nullableGuard = nullable ? `NEW.${foreignColumn} IS NOT NULL AND ` : "";
  const mismatch = `${nullableGuard}NOT EXISTS (
    SELECT 1 FROM ${parentTable} parent
    WHERE parent.id = NEW.${foreignColumn} AND parent.owner_id = NEW.owner_id
  )`;
  return `
    CREATE TRIGGER IF NOT EXISTS ${triggerName}_insert
    BEFORE INSERT ON ${table}
    WHEN ${mismatch}
    BEGIN
      SELECT RAISE(ABORT, 'tenant ownership mismatch');
    END;

    CREATE TRIGGER IF NOT EXISTS ${triggerName}_update
    BEFORE UPDATE OF owner_id, ${foreignColumn} ON ${table}
    WHEN ${mismatch}
    BEGIN
      SELECT RAISE(ABORT, 'tenant ownership mismatch');
    END;
  `;
}

function immutableOwnerTrigger(table: string): string {
  return `
    CREATE TRIGGER IF NOT EXISTS trg_${table}_owner_immutable
    BEFORE UPDATE OF owner_id ON ${table}
    WHEN NEW.owner_id <> OLD.owner_id
    BEGIN
      SELECT RAISE(ABORT, 'owner_id is immutable');
    END;
  `;
}

const schema = `
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    email TEXT,
    email_normalized TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    role TEXT NOT NULL CHECK (role IN ('user', 'owner')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent_hash TEXT,
    ip_hash TEXT
  );

  CREATE TABLE IF NOT EXISTS api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE IF NOT EXISTS auth_login_limits (
    identifier_hash TEXT PRIMARY KEY,
    attempts INTEGER NOT NULL CHECK (attempts >= 0),
    reset_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS assets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    UNIQUE(owner_id, asset_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS price_snapshots (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
    asset_id TEXT NOT NULL REFERENCES assets(id) ON DELETE CASCADE,
    price TEXT NOT NULL,
    currency TEXT NOT NULL,
    source TEXT NOT NULL,
    as_of_at TEXT NOT NULL,
    fetched_at TEXT NOT NULL,
    raw_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    UNIQUE(owner_id, asset_id, source, as_of_at)
  );

  CREATE TABLE IF NOT EXISTS expected_assets (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    dedupe_key TEXT NOT NULL,
    created_at TEXT NOT NULL,
    CHECK (target_type <> 'event' OR expected_asset_id IS NULL),
    CHECK (target_type <> 'expected' OR event_id IS NULL),
    UNIQUE(owner_id, dedupe_key)
  );

  CREATE TABLE IF NOT EXISTS email_outbox (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
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
    UNIQUE(owner_id, run_id, recipient)
  );

  CREATE TABLE IF NOT EXISTS settings (
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY(owner_id, key)
  );

  CREATE TABLE IF NOT EXISTS ai_command_batches (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
    idempotency_key TEXT NOT NULL,
    actor TEXT NOT NULL,
    dry_run INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed')),
    request_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    finished_at TEXT,
    UNIQUE(owner_id, idempotency_key)
  );

  CREATE TABLE IF NOT EXISTS ai_command_audit (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL DEFAULT '${DEFAULT_OWNER_ID}' REFERENCES users(id) ON DELETE CASCADE,
    batch_id TEXT NOT NULL REFERENCES ai_command_batches(id) ON DELETE CASCADE,
    command_index INTEGER NOT NULL,
    command_type TEXT NOT NULL,
    target_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('applied', 'proposal', 'dry_run', 'failed')),
    input_json TEXT NOT NULL,
    result_json TEXT NOT NULL DEFAULT '{}',
    error TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    UNIQUE(owner_id, batch_id, command_index)
  );

  CREATE INDEX IF NOT EXISTS idx_sessions_user_expiry
    ON sessions(user_id, revoked_at, idle_expires_at);
  CREATE INDEX IF NOT EXISTS idx_api_tokens_user
    ON api_tokens(user_id, revoked_at, expires_at);
  CREATE INDEX IF NOT EXISTS idx_auth_login_limits_reset
    ON auth_login_limits(reset_at);
  CREATE INDEX IF NOT EXISTS idx_assets_owner_name
    ON assets(owner_id, name COLLATE NOCASE);
  CREATE INDEX IF NOT EXISTS idx_asset_operations_asset_time
    ON asset_operations(owner_id, asset_id, occurred_at DESC);
  CREATE INDEX IF NOT EXISTS idx_price_snapshots_asset_time
    ON price_snapshots(owner_id, asset_id, as_of_at DESC);
  CREATE INDEX IF NOT EXISTS idx_expected_assets_next_check
    ON expected_assets(owner_id, next_check_at);
  CREATE INDEX IF NOT EXISTS idx_asset_updates_expected_time
    ON asset_updates(owner_id, expected_asset_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tracked_events_next_run
    ON tracked_events(owner_id, status, next_run_at);
  CREATE INDEX IF NOT EXISTS idx_monitor_runs_event_time
    ON monitor_runs(owner_id, event_id, scheduled_for DESC);
  CREATE INDEX IF NOT EXISTS idx_monitor_runs_expected_time
    ON monitor_runs(owner_id, expected_asset_id, scheduled_for DESC);
  CREATE INDEX IF NOT EXISTS idx_monitor_runs_recovery
    ON monitor_runs(status, started_at, created_at);
  CREATE INDEX IF NOT EXISTS idx_email_outbox_due
    ON email_outbox(status, next_attempt_at, owner_id);

  ${ownerGuardTriggers("trg_asset_operations_asset_owner", "asset_operations", "asset_id", "assets")}
  ${ownerGuardTriggers("trg_price_snapshots_asset_owner", "price_snapshots", "asset_id", "assets")}
  ${ownerGuardTriggers("trg_expected_assets_link_owner", "expected_assets", "linked_asset_id", "assets", true)}
  ${ownerGuardTriggers("trg_asset_updates_expected_owner", "asset_updates", "expected_asset_id", "expected_assets")}
  ${ownerGuardTriggers("trg_monitor_runs_event_owner", "monitor_runs", "event_id", "tracked_events", true)}
  ${ownerGuardTriggers("trg_monitor_runs_expected_owner", "monitor_runs", "expected_asset_id", "expected_assets", true)}
  ${ownerGuardTriggers("trg_email_outbox_run_owner", "email_outbox", "run_id", "monitor_runs", true)}
  ${ownerGuardTriggers("trg_ai_command_audit_batch_owner", "ai_command_audit", "batch_id", "ai_command_batches")}

  ${[
    "assets",
    "asset_operations",
    "price_snapshots",
    "expected_assets",
    "asset_updates",
    "tracked_events",
    "monitor_runs",
    "email_outbox",
    "settings",
    "ai_command_batches",
    "ai_command_audit",
  ].map(immutableOwnerTrigger).join("\n")}
`;

function getDefaultSettings(): Record<string, string> {
  return {
    baseCurrency: "USD",
    timezone: "Asia/Shanghai",
    locale: "zh-CN",
    proxyUrl: "",
    aiProvider: process.env.NODE_ENV === "production" ? "none" : "mock",
    aiBaseUrl: "",
    aiModel: process.env.NODE_ENV === "production" ? "" : "mock-research-v1",
    smtpHost: "",
    smtpPort: "587",
    smtpSecure: "false",
    smtpFrom: "",
    notificationEmail: "",
  };
}

function shouldSeedDemoData(configured?: boolean): boolean {
  if (configured !== undefined) return configured;

  const environmentValue = process.env.SEED_DEMO_DATA?.trim().toLowerCase();
  if (environmentValue === "true") return true;
  if (environmentValue === "false") return false;
  return process.env.NODE_ENV !== "production";
}

function ensureParentDirectory(databasePath: string): string {
  if (databasePath === ":memory:") return databasePath;
  const resolvedPath = resolve(databasePath);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  return resolvedPath;
}

function runAtomically(db: SqliteDatabase, work: () => void): void {
  if (db.inTransaction) {
    work();
    return;
  }
  db.transaction(work)();
}

function ensureDefaultOwner(db: SqliteDatabase): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR IGNORE INTO users (
      id, username, username_normalized, email, email_normalized,
      password_hash, status, role, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, 'disabled', 'disabled', 'user', ?, ?)
  `).run(
    DEFAULT_OWNER_ID,
    DEFAULT_OWNER_USERNAME,
    normalizeUsername(DEFAULT_OWNER_USERNAME),
    now,
    now,
  );
}

export function initializeUserSettings(db: SqliteDatabase, ownerId: string): void {
  runAtomically(db, () => {
    const now = new Date().toISOString();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO settings (owner_id, key, value, updated_at)
      VALUES (?, ?, ?, ?)
    `);
    for (const [key, value] of Object.entries(getDefaultSettings())) {
      insert.run(ownerId, key, value, now);
    }
  });
}

export function getBootstrapUser(db: SqliteDatabase): BootstrapUserIdentity | null {
  const row = db.prepare("SELECT id, username FROM users WHERE id = ?").get(BOOTSTRAP_USER_ID) as
    | BootstrapUserIdentity
    | undefined;
  return row ?? null;
}

export function getBootstrapUserId(db: SqliteDatabase): string | null {
  return getBootstrapUser(db)?.id ?? null;
}

function createBootstrapUser(db: SqliteDatabase): BootstrapUserIdentity {
  const username = process.env.APP_AUTH_USERNAME?.trim() ?? "";
  const password = process.env.APP_AUTH_PASSWORD ?? "";
  if (!username || !password) {
    throw new Error(
      "APP_AUTH_USERNAME and APP_AUTH_PASSWORD are required to migrate the legacy database",
    );
  }
  if (normalizeUsername(username) === normalizeUsername(DEFAULT_OWNER_USERNAME)) {
    throw new Error("APP_AUTH_USERNAME conflicts with the reserved internal account");
  }

  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO users (
      id, username, username_normalized, email, email_normalized,
      password_hash, status, role, created_at, updated_at
    ) VALUES (?, ?, ?, NULL, NULL, ?, 'active', 'owner', ?, ?)
  `).run(
    BOOTSTRAP_USER_ID,
    username,
    normalizeUsername(username),
    hashPasswordScrypt(password),
    now,
    now,
  );

  const aiToken = process.env.AI_API_TOKEN?.trim() ?? "";
  if (aiToken) {
    db.prepare(`
      INSERT INTO api_tokens (
        id, user_id, name, token_hash, token_prefix, scopes_json,
        created_at, last_used_at, expires_at, revoked_at
      ) VALUES (?, ?, 'Migrated AI API token', ?, ?, ?, ?, NULL, NULL, NULL)
    `).run(
      randomUUID(),
      BOOTSTRAP_USER_ID,
      hashApiToken(aiToken),
      aiToken.slice(0, 12),
      JSON.stringify([
        "ai:read",
        "finance:read",
        "finance:write",
        "assets:write",
        "prices:write",
        "operations:write",
        "expected:write",
        "events:write",
      ]),
      now,
    );
  }

  return { id: BOOTSTRAP_USER_ID, username };
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
  );
}

function tableHasColumn(db: SqliteDatabase, table: string, column: string): boolean {
  return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).some(
    (entry) => entry.name === column,
  );
}

function assertForeignKeys(db: SqliteDatabase): void {
  const violations = db.pragma("foreign_key_check") as Array<Record<string, unknown>>;
  if (violations.length > 0) {
    throw new Error(`Database migration produced ${violations.length} foreign key violation(s)`);
  }
}

function installFreshSchema(db: SqliteDatabase): void {
  runAtomically(db, () => {
    db.exec(schema);
    ensureDefaultOwner(db);
    initializeUserSettings(db, DEFAULT_OWNER_ID);
    const bootstrapUsername = process.env.APP_AUTH_USERNAME?.trim() ?? "";
    const bootstrapPassword = process.env.APP_AUTH_PASSWORD ?? "";
    if (!getBootstrapUser(db) && (bootstrapUsername || bootstrapPassword)) {
      const bootstrap = createBootstrapUser(db);
      initializeUserSettings(db, bootstrap.id);
    }
    assertForeignKeys(db);
    db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
  });
}

function migrateLegacySchema(db: SqliteDatabase): void {
  runAtomically(db, () => {
    for (const index of legacyIndexes) db.exec(`DROP INDEX IF EXISTS ${index}`);
    for (const table of legacyTables) {
      if (!tableExists(db, table)) {
        throw new Error(`Legacy database is missing required table: ${table}`);
      }
      db.exec(`ALTER TABLE ${table} RENAME TO legacy_v1_${table}`);
    }

    db.exec(schema);
    ensureDefaultOwner(db);
    const bootstrap = createBootstrapUser(db);

    db.prepare(`
      INSERT INTO assets (
        id, owner_id, name, symbol, kind, account, currency, quantity, unit_cost,
        current_price, price_mode, price_source, price_updated_at, stale_after_hours,
        notes, version, created_at, updated_at
      )
      SELECT id, ?, name, symbol, kind, account, currency, quantity, unit_cost,
        current_price, price_mode, price_source, price_updated_at, stale_after_hours,
        notes, version, created_at, updated_at
      FROM legacy_v1_assets
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO asset_operations (
        id, owner_id, asset_id, operation_type, quantity_delta, unit_price, fee,
        currency, note, occurred_at, idempotency_key, created_at
      )
      SELECT id, ?, asset_id, operation_type, quantity_delta, unit_price, fee,
        currency, note, occurred_at, idempotency_key, created_at
      FROM legacy_v1_asset_operations
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO price_snapshots (
        id, owner_id, asset_id, price, currency, source, as_of_at,
        fetched_at, raw_json, created_at
      )
      SELECT id, ?, asset_id, price, currency, source, as_of_at,
        fetched_at, raw_json, created_at
      FROM legacy_v1_price_snapshots
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO expected_assets (
        id, owner_id, name, category, ecosystem, stage, health, next_action,
        deadline, estimated_low, estimated_high, currency, invested_cost,
        confidence, source_url, keywords_json, latest_update, last_checked_at,
        next_check_at, notes, linked_asset_id, version, created_at, updated_at
      )
      SELECT id, ?, name, category, ecosystem, stage, health, next_action,
        deadline, estimated_low, estimated_high, currency, invested_cost,
        confidence, source_url, keywords_json, latest_update, last_checked_at,
        next_check_at, notes, linked_asset_id, version, created_at, updated_at
      FROM legacy_v1_expected_assets
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO asset_updates (
        id, owner_id, expected_asset_id, update_type, title, summary,
        source_url, provider, published_at, created_at
      )
      SELECT id, ?, expected_asset_id, update_type, title, summary,
        source_url, provider, published_at, created_at
      FROM legacy_v1_asset_updates
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO tracked_events (
        id, owner_id, name, topic, instructions, schedule, schedule_label,
        timezone, next_run_at, last_run_at, status, notify_on_change_only,
        email_enabled, email_to, last_run_status, last_summary, version,
        created_at, updated_at
      )
      SELECT id, ?, name, topic, instructions, schedule, schedule_label,
        timezone, next_run_at, last_run_at, status, notify_on_change_only,
        email_enabled, email_to, last_run_status, last_summary, version,
        created_at, updated_at
      FROM legacy_v1_tracked_events
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO monitor_runs (
        id, owner_id, target_type, event_id, expected_asset_id, status,
        scheduled_for, started_at, finished_at, summary, change_summary,
        sources_json, provider, email_status, error, dedupe_key, created_at
      )
      SELECT id, ?, target_type, event_id, expected_asset_id, status,
        scheduled_for, started_at, finished_at, summary, change_summary,
        sources_json, provider, email_status, error, dedupe_key, created_at
      FROM legacy_v1_monitor_runs
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO email_outbox (
        id, owner_id, run_id, recipient, subject, text_body, html_body,
        status, attempts, next_attempt_at, provider_message_id, last_error,
        created_at, sent_at
      )
      SELECT id, ?, run_id, recipient, subject, text_body, html_body,
        status, attempts, next_attempt_at, provider_message_id, last_error,
        created_at, sent_at
      FROM legacy_v1_email_outbox
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO settings (owner_id, key, value, updated_at)
      SELECT ?, key, value, updated_at FROM legacy_v1_settings
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO ai_command_batches (
        id, owner_id, idempotency_key, actor, dry_run, status,
        request_json, result_json, created_at, finished_at
      )
      SELECT id, ?, idempotency_key, actor, dry_run, status,
        request_json, result_json, created_at, finished_at
      FROM legacy_v1_ai_command_batches
    `).run(bootstrap.id);

    db.prepare(`
      INSERT INTO ai_command_audit (
        id, owner_id, batch_id, command_index, command_type, target_id,
        status, input_json, result_json, error, created_at
      )
      SELECT id, ?, batch_id, command_index, command_type, target_id,
        status, input_json, result_json, error, created_at
      FROM legacy_v1_ai_command_audit
    `).run(bootstrap.id);

    initializeUserSettings(db, DEFAULT_OWNER_ID);
    initializeUserSettings(db, bootstrap.id);

    for (const table of [...legacyTables].reverse()) {
      db.exec(`DROP TABLE legacy_v1_${table}`);
    }

    db.exec(schema);
    assertForeignKeys(db);
    db.pragma(`user_version = ${DATABASE_SCHEMA_VERSION}`);
  });
}

function initializeSchema(db: SqliteDatabase): void {
  const userVersion = Number(db.pragma("user_version", { simple: true }));
  if (userVersion > DATABASE_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${userVersion} is newer than supported version ${DATABASE_SCHEMA_VERSION}`,
    );
  }

  const hasAssets = tableExists(db, "assets");
  const hasOwnerColumns = hasAssets && tableHasColumn(db, "assets", "owner_id");
  if (userVersion === DATABASE_SCHEMA_VERSION && !hasOwnerColumns) {
    throw new Error("Database schema version is inconsistent with its table definitions");
  }

  const foreignKeysWereEnabled = Number(db.pragma("foreign_keys", { simple: true })) === 1;
  db.pragma("foreign_keys = OFF");
  try {
    if (!hasAssets) {
      installFreshSchema(db);
    } else if (!hasOwnerColumns) {
      migrateLegacySchema(db);
    } else {
      installFreshSchema(db);
    }
  } finally {
    db.pragma(`foreign_keys = ${foreignKeysWereEnabled ? "ON" : "OFF"}`);
  }
}

function seedDemoData(db: SqliteDatabase): void {
  const alreadySeeded = db.prepare(`
    SELECT value FROM settings WHERE owner_id = ? AND key = 'demoSeeded'
  `).get(DEFAULT_OWNER_ID) as { value: string } | undefined;
  if (alreadySeeded) return;

  const now = new Date();
  const nowIso = now.toISOString();
  const yesterdayIso = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  const tomorrowIso = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  const nextWeekIso = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const seed = db.transaction(() => {
    db.prepare(`
      INSERT INTO assets (
        id, owner_id, name, symbol, kind, account, currency, quantity, unit_cost,
        current_price, price_mode, price_source, price_updated_at,
        stale_after_hours, notes, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "demo-btc",
      DEFAULT_OWNER_ID,
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
        id, owner_id, asset_id, operation_type, quantity_delta, unit_price, fee,
        currency, note, occurred_at, idempotency_key, created_at
      ) VALUES (?, ?, ?, 'opening', ?, ?, '0', ?, ?, ?, ?, ?)
    `).run(
      randomUUID(),
      DEFAULT_OWNER_ID,
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
        id, owner_id, asset_id, price, currency, source, as_of_at,
        fetched_at, raw_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
    `).run(
      randomUUID(),
      DEFAULT_OWNER_ID,
      "demo-btc",
      "68420",
      "USD",
      "manual",
      yesterdayIso,
      nowIso,
      nowIso,
    );

    db.prepare(`
      INSERT INTO expected_assets (
        id, owner_id, name, category, ecosystem, stage, health, next_action,
        deadline, estimated_low, estimated_high, currency, invested_cost,
        confidence, source_url, keywords_json, latest_update, last_checked_at,
        next_check_at, notes, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      "demo-airdrop",
      DEFAULT_OWNER_ID,
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
        id, owner_id, name, topic, instructions, schedule, schedule_label,
        timezone, next_run_at, last_run_at, status, notify_on_change_only,
        email_enabled, email_to, last_run_status, last_summary, version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'active', 1, 0, '', NULL, '', 1, ?, ?)
    `).run(
      "demo-event",
      DEFAULT_OWNER_ID,
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

    db.prepare(`
      INSERT INTO settings (owner_id, key, value, updated_at)
      VALUES (?, 'demoSeeded', 'true', ?)
      ON CONFLICT(owner_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `).run(DEFAULT_OWNER_ID, nowIso);
  });

  seed();
}

export function openDatabase(options: DatabaseOptions = {}): SqliteDatabase {
  const databasePath = ensureParentDirectory(
    options.path ?? process.env.DATABASE_PATH ?? "./data/finance.sqlite",
  );
  const db = new Database(databasePath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
    initializeSchema(db);
    db.pragma("foreign_keys = ON");
    assertForeignKeys(db);
    if (shouldSeedDemoData(options.seed)) seedDemoData(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}
