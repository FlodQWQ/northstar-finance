import request from "supertest";
import { describe, expect, it } from "vitest";
import { createApp } from "../server/app";
import { ManualPriceProvider, type PriceProvider } from "../server/providers/price";

const assetInput = (id: string) => ({
  id,
  name: id,
  symbol: "TEST",
  kind: "crypto",
  account: "test",
  currency: "USDT",
  quantity: "1",
  unitCost: "5",
  currentPrice: "10",
  priceMode: "provider",
  priceSource: "initial",
  priceUpdatedAt: "2026-08-01T00:00:00.000Z",
});

describe("batch price refresh safety", () => {
  it("does not rewrite provider assets when the deployment provider is manual", async () => {
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider: new ManualPriceProvider(),
    });

    try {
      await request(app).post("/api/assets").send(assetInput("manual-provider-asset")).expect(201);
      const before = app.finance.repository.getAsset("manual-provider-asset");
      const snapshotsBefore = app.finance.db.prepare(`
        SELECT COUNT(*) FROM price_snapshots WHERE asset_id = ?
      `).pluck().get("manual-provider-asset");

      const response = await request(app)
        .post("/api/assets/prices/refresh")
        .send({})
        .expect(200);

      expect(response.body.data).toMatchObject({
        updated: [],
        skipped: [],
        failed: [{
          id: "manual-provider-asset",
          error: {
            code: "PRICE_PROVIDER_DISABLED",
            message: "Price provider is disabled",
          },
        }],
      });
      expect(app.finance.repository.getAsset("manual-provider-asset")).toMatchObject({
        currentPrice: before.currentPrice,
        priceSource: before.priceSource,
        priceUpdatedAt: before.priceUpdatedAt,
        version: before.version,
      });
      expect(app.finance.db.prepare(`
        SELECT COUNT(*) FROM price_snapshots WHERE asset_id = ?
      `).pluck().get("manual-provider-asset")).toBe(snapshotsBefore);
    } finally {
      app.finance.close();
    }
  });

  it("does not overwrite an asset changed while its provider quote is in flight", async () => {
    let app: ReturnType<typeof createApp>;
    const priceProvider: PriceProvider = {
      id: "race-test",
      getQuote: async (asset) => {
        await Promise.resolve();
        app.finance.repository.updateAsset(asset.id, {
          notes: "changed while quote was in flight",
        });
        return {
          price: "99",
          currency: "USDT",
          source: "provider-after-race",
          asOf: "2026-08-10T08:00:02.000Z",
        };
      },
      testConnection: async () => ({ ok: true, status: "connected", message: "ready" }),
    };
    app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider,
    });

    try {
      await request(app).post("/api/assets").send(assetInput("changed-during-refresh")).expect(201);

      const response = await request(app)
        .post("/api/assets/prices/refresh")
        .send({})
        .expect(200);

      expect(response.body.data.updated).toEqual([]);
      expect(response.body.data.failed).toEqual([
        {
          id: "changed-during-refresh",
          name: "changed-during-refresh",
          error: {
            code: "ASSET_CHANGED",
            message: "Asset changed while its provider price was being fetched",
          },
        },
      ]);
      expect(app.finance.repository.getAsset("changed-during-refresh")).toMatchObject({
        currentPrice: "10",
        priceMode: "provider",
        priceSource: "initial",
        priceUpdatedAt: "2026-08-01T00:00:00.000Z",
        notes: "changed while quote was in flight",
        version: 2,
      });
      expect(app.finance.db.prepare(`
        SELECT COUNT(*) FROM price_snapshots WHERE asset_id = ? AND source = ?
      `).pluck().get("changed-during-refresh", "provider-after-race")).toBe(0);
    } finally {
      app.finance.close();
    }
  });

  it("requires provider mode even when the expected version still matches", async () => {
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider: new ManualPriceProvider(),
    });

    try {
      await request(app).post("/api/assets").send(assetInput("mode-changed-without-version")).expect(201);
      const asset = app.finance.repository.getAsset("mode-changed-without-version");
      app.finance.db.prepare(`
        UPDATE assets SET price_mode = 'manual' WHERE owner_id = ? AND id = ?
      `).run(app.finance.repository.ownerId, asset.id);

      expect(() => app.finance.repository.updateProviderPrice(asset.id, asset.version, {
        price: "99",
        currency: "USDT",
        source: "must-not-write",
        asOf: "2026-08-10T08:00:02.000Z",
      })).toThrowError(expect.objectContaining({ code: "ASSET_CHANGED" }));
      expect(app.finance.repository.getAsset(asset.id)).toMatchObject({
        currentPrice: "10",
        priceMode: "manual",
        version: asset.version,
      });
      expect(app.finance.db.prepare(`
        SELECT COUNT(*) FROM price_snapshots WHERE asset_id = ? AND source = ?
      `).pluck().get(asset.id, "must-not-write")).toBe(0);
    } finally {
      app.finance.close();
    }
  });

  it("limits provider work across simultaneous refresh requests", async () => {
    let active = 0;
    let peak = 0;
    const priceProvider: PriceProvider = {
      id: "global-limit-test",
      getQuote: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return {
          price: "12",
          currency: "USDT",
          source: "global-limit-test",
          asOf: "2026-08-10T08:00:02.000Z",
        };
      },
      testConnection: async () => ({ ok: true, status: "connected", message: "ready" }),
    };
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider,
    });

    try {
      for (let index = 0; index < 8; index += 1) {
        await request(app).post("/api/assets").send({
          ...assetInput(`limited-${index}`),
          symbol: `TEST${index}`,
        }).expect(201);
      }

      await Promise.all([
        request(app).post("/api/assets/prices/refresh").send({}).expect(200),
        request(app).post("/api/assets/prices/refresh").send({}).expect(200),
      ]);

      expect(peak).toBe(4);
    } finally {
      app.finance.close();
    }
  });
});
