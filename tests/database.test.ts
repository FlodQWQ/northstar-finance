import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "../server/db/database";

const temporaryDirectories: string[] = [];
const openDatabases: SqliteDatabase[] = [];

function createFileDatabase(seed?: boolean): {
  db: SqliteDatabase;
  path: string;
} {
  const directory = mkdtempSync(join(tmpdir(), "northstar-finance-test-"));
  const path = join(directory, "finance.sqlite");
  const db = openDatabase({ path, seed });
  temporaryDirectories.push(directory);
  openDatabases.push(db);
  return { db, path };
}

function insertAsset(db: SqliteDatabase, id = "asset-test"): void {
  const timestamp = "2026-08-09T00:00:00.000Z";
  db.prepare(`
    INSERT INTO assets (
      id, name, symbol, kind, account, currency, quantity, unit_cost,
      current_price, price_mode, price_source, price_updated_at,
      stale_after_hours, notes, version, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    "Test Bitcoin",
    "BTC",
    "crypto",
    "Cold wallet",
    "USD",
    "0.123456789123456789",
    "42000.00000001",
    "68000.00000001",
    "manual",
    "manual",
    timestamp,
    24,
    "",
    timestamp,
    timestamp,
  );
}

afterEach(() => {
  for (const db of openDatabases.splice(0)) {
    if (db.open) db.close();
  }
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe("openDatabase", () => {
  it("does not seed demo records by default in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEED_DEMO_DATA", "");

    const { db } = createFileDatabase();

    expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM expected_assets").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM tracked_events").pluck().get()).toBe(0);
  });

  it("creates a one-time production owner only from explicit bootstrap credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("APP_AUTH_USERNAME", "deployment-owner");
    vi.stubEnv("APP_AUTH_PASSWORD", "correct horse battery staple");

    const { db } = createFileDatabase(false);
    const owner = db.prepare(`
      SELECT username, password_hash, status, role FROM users
      WHERE username_normalized = 'deployment-owner'
    `).get() as {
      username: string;
      password_hash: string;
      status: string;
      role: string;
    };

    expect(owner).toMatchObject({
      username: "deployment-owner",
      status: "active",
      role: "owner",
    });
    expect(owner.password_hash).toMatch(/^\$scrypt\$/);
    expect(owner.password_hash).not.toContain("correct horse battery staple");
  });

  it("allows demo records to be explicitly enabled in production", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SEED_DEMO_DATA", "true");

    const { db } = createFileDatabase();

    expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM expected_assets").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM tracked_events").pluck().get()).toBe(1);
  });

  it("creates the required schema, settings, WAL mode, and foreign keys", () => {
    const { db } = createFileDatabase(false);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all()
      .map((row) => (row as { name: string }).name);

    expect(tables).toEqual(
      expect.arrayContaining([
        "assets",
        "asset_operations",
        "price_snapshots",
        "expected_assets",
        "asset_updates",
        "tracked_events",
        "monitor_runs",
        "email_outbox",
        "settings",
      ]),
    );
    expect(db.pragma("journal_mode", { simple: true })).toBe("wal");
    expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      db.prepare("SELECT value FROM settings WHERE key = 'timezone'").pluck().get(),
    ).toBe("Asia/Shanghai");
    expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(0);
  });

  it("does not copy deployment connection values into newly registered account defaults", () => {
    vi.stubEnv("HTTPS_PROXY", "http://proxy-user:proxy-pass@proxy.internal:7890");
    vi.stubEnv("OPENAI_BASE_URL", "https://private-ai.internal/v1");
    vi.stubEnv("SMTP_HOST", "smtp.internal");
    vi.stubEnv("SMTP_FROM", "private@example.com");
    vi.stubEnv("NOTIFICATION_EMAIL", "operator@example.com");

    const { db } = createFileDatabase(false);
    const values = Object.fromEntries(
      (db.prepare("SELECT key, value FROM settings").all() as Array<{ key: string; value: string }>)
        .map((row) => [row.key, row.value]),
    );

    expect(values).toMatchObject({
      proxyUrl: "",
      aiBaseUrl: "",
      smtpHost: "",
      smtpFrom: "",
      notificationEmail: "",
    });
  });

  it("keeps decimal input exact and enforces operation idempotency and cascades", () => {
    const { db } = createFileDatabase(false);
    insertAsset(db);

    const storedAsset = db
      .prepare("SELECT quantity, unit_cost, current_price FROM assets WHERE id = ?")
      .get("asset-test");
    expect(storedAsset).toEqual({
      quantity: "0.123456789123456789",
      unit_cost: "42000.00000001",
      current_price: "68000.00000001",
    });

    const insertOperation = db.prepare(`
      INSERT INTO asset_operations (
        id, asset_id, operation_type, quantity_delta, unit_price, fee,
        currency, note, occurred_at, idempotency_key, created_at
      ) VALUES (?, ?, 'buy', ?, ?, '0', 'USD', '', ?, ?, ?)
    `);
    const timestamp = "2026-08-09T01:00:00.000Z";
    insertOperation.run(
      "operation-1",
      "asset-test",
      "0.01",
      "65000",
      timestamp,
      "broker-fill-123",
      timestamp,
    );

    expect(() =>
      insertOperation.run(
        "operation-2",
        "asset-test",
        "0.01",
        "65000",
        timestamp,
        "broker-fill-123",
        timestamp,
      ),
    ).toThrow(/UNIQUE constraint failed/);

    db.prepare(`
      INSERT INTO price_snapshots (
        id, asset_id, price, currency, source, as_of_at,
        fetched_at, raw_json, created_at
      ) VALUES (?, ?, ?, 'USD', 'manual', ?, ?, '{}', ?)
    `).run("price-1", "asset-test", "68000.00000001", timestamp, timestamp, timestamp);

    db.prepare("DELETE FROM assets WHERE id = ?").run("asset-test");
    expect(db.prepare("SELECT COUNT(*) FROM asset_operations").pluck().get()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) FROM price_snapshots").pluck().get()).toBe(0);
  });

  it("seeds demo records only once across process restarts", () => {
    const { db, path } = createFileDatabase(true);

    expect(db.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM expected_assets").pluck().get()).toBe(1);
    expect(db.prepare("SELECT COUNT(*) FROM tracked_events").pluck().get()).toBe(1);
    db.close();

    const reopened = openDatabase({ path, seed: true });
    openDatabases.push(reopened);
    expect(reopened.prepare("SELECT COUNT(*) FROM assets").pluck().get()).toBe(1);
    expect(reopened.prepare("SELECT COUNT(*) FROM expected_assets").pluck().get()).toBe(1);
    expect(reopened.prepare("SELECT COUNT(*) FROM tracked_events").pluck().get()).toBe(1);
    expect(
      reopened.prepare("SELECT value FROM settings WHERE key = 'demoSeeded'").pluck().get(),
    ).toBe("true");
  });
});
