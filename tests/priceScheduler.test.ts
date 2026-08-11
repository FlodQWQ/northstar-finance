import { describe, expect, it, vi } from "vitest";
import { openDatabase, type SqliteDatabase } from "../server/db/database";
import type { PriceProvider } from "../server/providers/price";
import { AuthService } from "../server/services/auth";
import { AssetPriceScheduler } from "../server/services/priceScheduler";
import { ProviderPriceRefresher } from "../server/services/priceRefresh";
import { FinanceRepository } from "../server/services/repository";
import { assetCreateSchema } from "../server/validation";

const password = "correct horse battery staple";

async function createOwner(
  db: SqliteDatabase,
  auth: AuthService,
  username: string,
  active = true,
): Promise<{ id: string; repository: FinanceRepository }> {
  const user = await auth.register({ username, password });
  db.prepare("UPDATE users SET status = ? WHERE id = ?")
    .run(active ? "active" : "pending", user.id);
  return { id: user.id, repository: new FinanceRepository(db, user.id) };
}

function createAsset(
  repository: FinanceRepository,
  id: string,
  overrides: Record<string, unknown> = {},
): void {
  repository.createAsset(assetCreateSchema.parse({
    id,
    name: id,
    symbol: id.toUpperCase(),
    kind: "crypto",
    account: "scheduler-test",
    currency: "USDT",
    quantity: "1",
    unitCost: "1",
    currentPrice: "1",
    priceMode: "provider",
    priceSource: "initial",
    priceUpdatedAt: "2026-08-01T00:00:00.000Z",
    staleAfterHours: 1,
    ...overrides,
  }));
}

function provider(
  id: string,
  getQuote: PriceProvider["getQuote"],
): PriceProvider {
  return {
    id,
    getQuote,
    testConnection: async () => ({ ok: true, status: "connected", message: "ready" }),
  };
}

describe("automatic asset price scheduler", () => {
  it("skips manual assets and provider assets whose own freshness window has not elapsed", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    try {
      const owner = await createOwner(db, auth, "price-fresh-owner");
      createAsset(owner.repository, "manual-asset", { priceMode: "manual" });
      createAsset(owner.repository, "fresh-asset", {
        priceUpdatedAt: "2026-08-11T00:30:00.000Z",
        staleAfterHours: 2,
      });
      const getQuote = vi.fn<PriceProvider["getQuote"]>();
      const scheduler = new AssetPriceScheduler(
        db,
        new ProviderPriceRefresher(provider("test", getQuote)),
      );

      const result = await scheduler.tick(new Date("2026-08-11T01:00:00.000Z"));

      expect(getQuote).not.toHaveBeenCalled();
      expect(result.updated).toEqual([]);
      expect(result.failed).toEqual([]);
      expect(result.skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetId: "manual-asset", reason: "PRICE_MODE_MANUAL" }),
        expect.objectContaining({ assetId: "fresh-asset", reason: "PRICE_FRESH" }),
      ]));
    } finally {
      db.close();
    }
  });

  it("refreshes due assets for each active owner with a shared concurrency limit", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    let active = 0;
    let peak = 0;
    const calls: string[] = [];
    try {
      const alice = await createOwner(db, auth, "price-scheduler-alice");
      const bob = await createOwner(db, auth, "price-scheduler-bob");
      const pending = await createOwner(db, auth, "price-scheduler-pending", false);
      for (const id of ["alice-1", "alice-2"]) createAsset(alice.repository, id);
      for (const id of ["bob-1", "bob-2"]) createAsset(bob.repository, id);
      createAsset(pending.repository, "pending-1");

      const priceProvider = provider("owner-test", async (asset) => {
        calls.push(asset.id);
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return {
          price: asset.id.startsWith("alice") ? "11" : "22",
          currency: "USDT",
          source: "automatic-owner-test",
          asOf: "2026-08-11T02:00:00.000Z",
        };
      });
      const scheduler = new AssetPriceScheduler(
        db,
        new ProviderPriceRefresher(priceProvider, 2),
      );

      const result = await scheduler.tick(new Date("2026-08-11T02:00:00.000Z"));

      expect(peak).toBe(2);
      expect(calls.sort()).toEqual(["alice-1", "alice-2", "bob-1", "bob-2"]);
      expect(result.updated).toHaveLength(4);
      expect(alice.repository.getAsset("alice-1")).toMatchObject({
        currentPrice: "11",
        priceSource: "automatic-owner-test",
      });
      expect(bob.repository.getAsset("bob-1")).toMatchObject({
        currentPrice: "22",
        priceSource: "automatic-owner-test",
      });
      expect(pending.repository.getAsset("pending-1")).toMatchObject({
        currentPrice: "1",
        priceSource: "initial",
      });
      const snapshotOwners = db.prepare(`
        SELECT DISTINCT owner_id FROM price_snapshots
        WHERE source = 'automatic-owner-test' ORDER BY owner_id
      `).pluck().all();
      expect(snapshotOwners).toEqual([alice.id, bob.id].sort());
    } finally {
      db.close();
    }
  });

  it("isolates failures and retries a failed asset with capped exponential backoff", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    const calls = new Map<string, number>();
    try {
      const owner = await createOwner(db, auth, "price-retry-owner");
      createAsset(owner.repository, "failing-asset");
      createAsset(owner.repository, "healthy-asset");
      const priceProvider = provider("retry-test", async (asset) => {
        const count = (calls.get(asset.id) ?? 0) + 1;
        calls.set(asset.id, count);
        if (asset.id === "failing-asset" && count < 4) throw new Error("upstream unavailable");
        return {
          price: asset.id === "failing-asset" ? "99" : "12",
          currency: "USDT",
          source: "retry-test",
          asOf: "2026-08-11T03:00:00.000Z",
        };
      });
      const scheduler = new AssetPriceScheduler(
        db,
        new ProviderPriceRefresher(priceProvider, 2),
        { retryBaseMs: 1_000, retryMaxMs: 2_000 },
      );
      const at = (milliseconds: number) => new Date(Date.parse("2026-08-11T03:00:00.000Z") + milliseconds);

      const first = await scheduler.tick(at(0));
      expect(first.updated).toEqual([
        expect.objectContaining({ assetId: "healthy-asset" }),
      ]);
      expect(first.failed).toEqual([
        expect.objectContaining({
          assetId: "failing-asset",
          error: expect.objectContaining({ code: "PRICE_REFRESH_FAILED" }),
        }),
      ]);
      expect(owner.repository.getAsset("healthy-asset").currentPrice).toBe("12");
      expect(owner.repository.getAsset("failing-asset").currentPrice).toBe("1");

      expect((await scheduler.tick(at(999))).skipped).toEqual(expect.arrayContaining([
        expect.objectContaining({ assetId: "failing-asset", reason: "PRICE_BACKOFF" }),
      ]));
      await scheduler.tick(at(1_000));
      expect(calls.get("failing-asset")).toBe(2);
      await scheduler.tick(at(2_999));
      expect(calls.get("failing-asset")).toBe(2);
      await scheduler.tick(at(3_000));
      expect(calls.get("failing-asset")).toBe(3);
      await scheduler.tick(at(4_999));
      expect(calls.get("failing-asset")).toBe(3);
      const recovered = await scheduler.tick(at(5_000));
      expect(calls.get("failing-asset")).toBe(4);
      expect(recovered.updated).toEqual([
        expect.objectContaining({ assetId: "failing-asset" }),
      ]);
      expect(owner.repository.getAsset("failing-asset")).toMatchObject({
        currentPrice: "99",
        priceSource: "retry-test",
      });
    } finally {
      db.close();
    }
  });

  it("does not overwrite an asset that changes while an automatic quote is in flight", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    try {
      const owner = await createOwner(db, auth, "price-conflict-owner");
      createAsset(owner.repository, "conflict-asset");
      const priceProvider = provider("conflict-test", async (asset) => {
        owner.repository.updateAsset(asset.id, { notes: "changed during quote" });
        return {
          price: "88",
          currency: "USDT",
          source: "must-not-write",
          asOf: "2026-08-11T04:00:00.000Z",
        };
      });
      const scheduler = new AssetPriceScheduler(
        db,
        new ProviderPriceRefresher(priceProvider),
      );

      const result = await scheduler.tick(new Date("2026-08-11T04:00:00.000Z"));

      expect(result.updated).toEqual([]);
      expect(result.failed).toEqual([
        expect.objectContaining({
          assetId: "conflict-asset",
          error: expect.objectContaining({ code: "ASSET_CHANGED" }),
        }),
      ]);
      expect(owner.repository.getAsset("conflict-asset")).toMatchObject({
        currentPrice: "1",
        priceSource: "initial",
        notes: "changed during quote",
        version: 2,
      });
      expect(db.prepare(`
        SELECT COUNT(*) FROM price_snapshots WHERE source = 'must-not-write'
      `).pluck().get()).toBe(0);
    } finally {
      db.close();
    }
  });

  it("ticks immediately on start and continues on the configured interval", async () => {
    const db = openDatabase({ path: ":memory:", seed: false });
    const auth = new AuthService(db, {
      passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    });
    const getQuote = vi.fn<PriceProvider["getQuote"]>().mockRejectedValue(new Error("offline"));
    let scheduler: AssetPriceScheduler | undefined;
    try {
      const owner = await createOwner(db, auth, "price-start-owner");
      createAsset(owner.repository, "start-asset");
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-08-11T05:00:00.000Z"));
      scheduler = new AssetPriceScheduler(
        db,
        new ProviderPriceRefresher(provider("start-test", getQuote)),
        { pollMs: 1_000, retryBaseMs: 1_000, retryMaxMs: 1_000 },
      );

      scheduler.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(getQuote).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(getQuote).toHaveBeenCalledTimes(2);
    } finally {
      scheduler?.stop();
      vi.useRealTimers();
      db.close();
    }
  });
});
