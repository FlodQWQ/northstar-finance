import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Asset } from "../shared/types";
import { createApp } from "../server/app";
import {
  ManualPriceProvider,
  MultiSourcePriceProvider,
  PriceProviderError,
  createPriceProviderFromEnv,
  type PriceProvider,
} from "../server/providers/price";

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-test",
    version: 1,
    name: "Bitcoin",
    symbol: "BTC",
    kind: "crypto",
    account: "OKX wallet",
    currency: "USDT",
    quantity: "1",
    unitCost: "0",
    currentPrice: "0",
    marketValue: "0",
    costBasis: "0",
    pnl: "0",
    pnlPercent: "0",
    priceMode: "provider",
    priceSource: "manual",
    priceUpdatedAt: new Date().toISOString(),
    staleAfterHours: 24,
    notes: "",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("public market price providers", () => {
  it("prefers the venue named by the account and caches a quote briefly", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      return json({
        code: "0",
        data: [{ instId: "BTC-USDT", last: "65000.125", ts: "1700000000000" }],
      });
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 60_000 });

    const first = await provider.getQuote(asset({ account: "okx wallet" }));
    const second = await provider.getQuote(asset({ account: "okx wallet" }));

    expect(first).toMatchObject({
      price: "65000.125",
      currency: "USDT",
      source: "okx:BTC-USDT",
      asOf: "2023-11-14T22:13:20.000Z",
    });
    expect(second).toEqual(first);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(calls[0]).toContain("www.okx.com/api/v5/market/ticker");
  });

  it("keeps the account venue ahead of a previous fallback source", async () => {
    const calls: string[] = [];
    const provider = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async (url: string) => {
        calls.push(url);
        return json([{ currency_pair: "ETH_USDT", last: "1921.3" }]);
      }),
      cacheTtlMs: 0,
    });

    const quote = await provider.getQuote(asset({
      symbol: "ETH",
      account: "gate",
      priceSource: "binance:ETHUSDT",
    }));

    expect(quote.source).toBe("gate:ETH_USDT");
    expect(calls[0]).toContain("api.gateio.ws");
  });

  it("falls through a blocked venue to another public exchange", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("binance")) return json({}, 451);
      if (url.includes("okx")) {
        return json({ code: "0", data: [{ instId: "ETH-USDT", last: "1770.14" }] });
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({
      fetchImpl,
      preferredVenue: "binance",
      cacheTtlMs: 0,
    });

    const quote = await provider.getQuote(asset({ symbol: "ETH", account: "binance" }));

    expect(quote.source).toBe("okx:ETH-USDT");
    expect(quote.price).toBe("1770.14");
    expect(calls[0]).toContain("api.binance.com");
    expect(calls.filter((url) => url.includes("api.binance.com"))).toHaveLength(1);
    expect(calls.some((url) => url.includes("www.okx.com"))).toBe(true);
  });

  it("queries United Stables U instead of treating it as a USDT label", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("symbol=UUSDT");
      return json({ symbol: "UUSDT", price: "0.999375" });
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    const quote = await provider.getQuote(asset({
      name: "United Stables",
      symbol: "U",
      account: "binance wallet",
    }));

    expect(quote).toMatchObject({ price: "0.999375", source: "binance:UUSDT" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("uses CoinGecko for a CNY-denominated asset", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("api.coingecko.com/api/v3/simple/price");
      expect(url).toContain("vs_currencies=cny");
      return json({ bitcoin: { cny: 439700, last_updated_at: 1_700_000_000 } });
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    const quote = await provider.getQuote(asset({ currency: "CNY", account: "cold wallet" }));

    expect(quote).toMatchObject({
      price: "439700",
      currency: "CNY",
      source: "coingecko:bitcoin:cny",
      asOf: "2023-11-14T22:13:20.000Z",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("parses Bitget, Bybit and Gate response shapes", async () => {
    const responses: Record<string, unknown> = {
      bitget: { code: "00000", data: [{ symbol: "SOLUSDT", lastPr: "80.9" }] },
      bybit: { retCode: 0, result: { list: [{ symbol: "XAUTUSDT", lastPrice: "4161.5", time: "1700000000000" }] } },
      gate: [{ currency_pair: "OKB_USDT", last: "79.83", timestamp: "1700000000" }],
    };
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("bitget")) return json(responses.bitget);
      if (url.includes("bybit")) return json(responses.bybit);
      if (url.includes("gateio")) return json(responses.gate);
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    await expect(provider.getQuote(asset({ symbol: "SOL", account: "bitget" }))).resolves.toMatchObject({
      price: "80.9",
      source: "bitget:SOLUSDT",
    });
    await expect(provider.getQuote(asset({ symbol: "XAUT", account: "bybit" }))).resolves.toMatchObject({
      price: "4161.5",
      source: "bybit:XAUTUSDT",
    });
    await expect(provider.getQuote(asset({ symbol: "OKB", account: "gate" }))).resolves.toMatchObject({
      price: "79.83",
      source: "gate:OKB_USDT",
    });
  });

  it("prices Ondo holdings from their underlying listed security", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("finance.yahoo.com") && url.includes("/chart/NVDA")) {
        return json({
          chart: {
            result: [{
              meta: {
                currency: "USD",
                symbol: "NVDA",
                instrumentType: "EQUITY",
                exchangeName: "NMS",
                regularMarketPrice: 223.96,
                regularMarketTime: 1_700_000_000,
              },
            }],
            error: null,
          },
        });
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0, maxQuoteTimeMs: 5_000 });

    const quote = await provider.getQuote(asset({ symbol: "NVDAon", account: "okx wallet" }));

    expect(quote).toMatchObject({
      price: "223.96",
      currency: "USDT",
      source: "yahoo-underlying:NVDA:USD",
      asOf: "2023-11-14T22:13:20.000Z",
    });
    expect(quote.raw).toMatchObject({
      underlyingProxy: true,
      underlyingSymbol: "NVDA",
    });
    expect(quote.raw).not.toHaveProperty("portfolioSymbol");
    expect(calls[0]).toContain("/chart/NVDA");
    expect(calls.join("\n")).not.toMatch(/XNVDA|RNVDA/);
  });

  it("coalesces concurrent quotes for the same underlying security", async () => {
    const fetchImpl = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({
        chart: {
          result: [{
            meta: {
              currency: "USD",
              symbol: "NVDA",
              instrumentType: "EQUITY",
              exchangeName: "NMS",
              regularMarketPrice: 223.96,
              regularMarketTime: 1_700_000_000,
            },
          }],
          error: null,
        },
      });
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    const quotes = await Promise.all([
      provider.getQuote(asset({ id: "ondo-a", symbol: "NVDAon", account: "binance" })),
      provider.getQuote(asset({ id: "ondo-b", symbol: "NVDAon", account: "okx wallet" })),
    ]);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(quotes.map((quote) => quote.source)).toEqual([
      "yahoo-underlying:NVDA:USD",
      "yahoo-underlying:NVDA:USD",
    ]);
    expect(quotes[0].raw).not.toHaveProperty("portfolioSymbol");
  });

  it("falls back to the exact Ondo token market without using X/R aliases", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("finance.yahoo.com")) return json({}, 503);
      if (url.includes("gateio") && url.includes("QQQON_USDT")) {
        return json([{ currency_pair: "QQQON_USDT", last: "724.73" }]);
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0, maxQuoteTimeMs: 5_000 });

    const quote = await provider.getQuote(asset({ symbol: "QQQon", account: "gate" }));

    expect(quote).toMatchObject({ price: "724.73", source: "gate:QQQON_USDT" });
    expect(calls[0]).toContain("/chart/QQQ");
    expect(calls.some((url) => url.includes("QQQON_USDT"))).toBe(true);
    expect(calls.join("\n")).not.toMatch(/XQQQ|RQQQ/);
  });

  it("falls back from IBM underlying pricing to the exact Ondo CoinGecko id", async () => {
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url);
      if (url.includes("finance.yahoo.com")) return json({}, 503);
      if (url.includes("coingecko")) {
        return json({
          "ibm-ondo-tokenized-stock": { usd: 240.84, last_updated_at: 1_700_000_000 },
        });
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0, maxQuoteTimeMs: 5_000 });

    const quote = await provider.getQuote(asset({ symbol: "IBMon", account: "okx wallet" }));

    expect(quote).toMatchObject({
      price: "240.84",
      source: "coingecko:ibm-ondo-tokenized-stock:usd",
    });
    expect(calls[0]).toContain("/chart/IBM");
    const coinGeckoCall = calls.find((url) => url.includes("coingecko"));
    expect(coinGeckoCall).toContain("ids=ibm-ondo-tokenized-stock");
    expect(calls.join("\n")).not.toMatch(/XIBM|RIBM/);
  });

  it("uses a CoinGecko USD fallback for a synthetic asset missing on exchanges", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("coingecko")) {
        expect(url).toContain("ids=splashing-staked-sei");
        expect(url).toContain("vs_currencies=usd");
        return json({ "splashing-staked-sei": { usd: 0.06, last_updated_at: 1_700_000_000 } });
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0, maxQuoteTimeMs: 5_000 });

    const quote = await provider.getQuote(asset({ symbol: "spSEI", account: "okx wallet" }));

    expect(quote).toMatchObject({
      price: "0.06",
      currency: "USDT",
      source: "coingecko:splashing-staked-sei:usd",
    });
    expect((quote.raw as Record<string, unknown>).approximatePeg).toBe(true);
  });

  it("returns a peg quote for stable/debt rows when all venues are unavailable", async () => {
    const fetchImpl = vi.fn(async () => json({}, 503));
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    const quote = await provider.getQuote(asset({
      name: "usdt debt",
      symbol: "usdt debt",
      account: "binance",
      quantity: "-4000",
    }));

    expect(quote).toMatchObject({ price: "1", currency: "USDT", source: "stable-peg" });
    expect(fetchImpl.mock.calls.length).toBe(0);
  });

  it("does not replace a depegged yield asset with a one-unit fallback", async () => {
    const provider = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async () => json({}, 503)),
      cacheTtlMs: 0,
      maxQuoteTimeMs: 2_000,
    });

    await expect(provider.getQuote(asset({
      name: "Saturn sUSDat",
      symbol: "sUSDat",
      account: "okx wallet",
      currentPrice: "0.8859",
    }))).rejects.toMatchObject({ code: "PRICE_UNAVAILABLE" });
  });

  it("recognizes a blank stablecoin symbol from its denomination", async () => {
    const provider = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async () => json({}, 503)),
      cacheTtlMs: 0,
      maxQuoteTimeMs: 2_000,
    });
    await expect(provider.getQuote(asset({ symbol: "", name: "", account: "gate", currency: "USDT" }))).resolves.toMatchObject({
      price: "1",
      source: "stable-peg",
    });
  });

  it("does not label a one-unit stable peg as one CNY", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      expect(url).toContain("ids=tether");
      expect(url).toContain("vs_currencies=cny");
      return json({ tether: { cny: 6.79, last_updated_at: 1_700_000_000 } });
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0 });

    const quote = await provider.getQuote(asset({ symbol: "USDT", name: "Tether", currency: "CNY" }));

    expect(quote).toMatchObject({ price: "6.79", currency: "CNY", source: "coingecko:tether:cny" });
    expect((quote.raw as Record<string, unknown>).approximatePeg).toBeUndefined();
  });

  it("rejects malformed upstream values and oversized responses", async () => {
    const invalid = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async (url: string) => {
        if (url.includes("okx")) return json({ code: "0", data: [{ last: "NaN" }] });
        return json({}, 404);
      }),
      cacheTtlMs: 0,
    });
    await expect(invalid.getQuote(asset({ symbol: "ETH" }))).rejects.toMatchObject({
      code: "PRICE_UNAVAILABLE",
    });

    const oversized = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async () => new Response("{}", {
        status: 200,
        headers: { "content-length": "999999999" },
      })),
      cacheTtlMs: 0,
    });
    await expect(oversized.getQuote(asset({ symbol: "ETH" }))).rejects.toBeInstanceOf(PriceProviderError);
  });

  it("keeps the default provider offline and validates configuration", () => {
    expect(createPriceProviderFromEnv({ PRICE_PROVIDER: "manual" })).toBeInstanceOf(ManualPriceProvider);
    expect(createPriceProviderFromEnv({ PRICE_PROVIDER: "multi", PRICE_CACHE_TTL_MS: "0" })).toBeInstanceOf(
      MultiSourcePriceProvider,
    );
    expect(() => createPriceProviderFromEnv({ PRICE_PROVIDER: "unknown" })).toThrowError(PriceProviderError);
    expect(() => createPriceProviderFromEnv({ PRICE_PROVIDER: "multi", PRICE_TIMEOUT_MS: "fast" })).toThrowError(
      PriceProviderError,
    );
    expect(() => createPriceProviderFromEnv({ PRICE_PROVIDER: "multi", PRICE_PROXY: "not a url" })).toThrowError(
      PriceProviderError,
    );
  });

  it("does not inherit generic localhost proxies in production", () => {
    const provider = createPriceProviderFromEnv({
      NODE_ENV: "production",
      PRICE_PROVIDER: "multi",
      HTTPS_PROXY: "http://127.0.0.1:7890",
    });
    expect(provider).toBeInstanceOf(MultiSourcePriceProvider);
  });
});

describe("price provider API integration", () => {
  it("updates an owned asset through the configured provider boundary", async () => {
    const provider = new MultiSourcePriceProvider({
      fetchImpl: vi.fn(async () => json({ code: "0", data: [{ last: "1921.39", ts: "1700000000000" }] })),
      cacheTtlMs: 0,
    });
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider: provider,
    });
    try {
      await request(app).post("/api/assets").send({
        id: "provider-eth",
        name: "Ethereum",
        symbol: "ETH",
        kind: "crypto",
        account: "okx wallet",
        currency: "USDT",
        quantity: "0.5",
        unitCost: "1800",
        currentPrice: "0",
        priceMode: "provider",
        priceSource: "okx",
      }).expect(201);

      const response = await request(app).post("/api/assets/provider-eth/price").send({}).expect(200);
      expect(response.body.data).toMatchObject({
        currentPrice: "1921.39",
        priceSource: "okx:ETH-USDT",
        currency: "USDT",
      });
    } finally {
      app.finance.close();
    }
  });

  it("returns a structured upstream error without exposing response bodies", async () => {
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider: {
        id: "failed",
        getQuote: async () => {
          throw new PriceProviderError("No quote available", "PRICE_UNAVAILABLE", 502);
        },
        testConnection: async () => ({ ok: false, status: "failed", message: "unavailable" }),
      },
    });
    try {
      await request(app).post("/api/assets").send({
        id: "provider-failed",
        name: "Unknown",
        symbol: "UNKNOWN",
        kind: "crypto",
        account: "wallet",
        currency: "USDT",
        quantity: "0",
        unitCost: "0",
        currentPrice: "0",
        priceMode: "provider",
        priceSource: "multi",
      }).expect(201);

      const response = await request(app).post("/api/assets/provider-failed/price").send({}).expect(502);
      expect(response.body.error).toEqual({ code: "PRICE_UNAVAILABLE", message: "No quote available" });
    } finally {
      app.finance.close();
    }
  });

  it("batch refreshes provider assets with four workers and isolates item failures", async () => {
    let activeRequests = 0;
    let maxActiveRequests = 0;
    const providerCalls: string[] = [];
    const transactionStates: boolean[] = [];
    let app: ReturnType<typeof createApp>;
    const provider: PriceProvider = {
      id: "batch-test",
      getQuote: async (current) => {
        providerCalls.push(current.id);
        transactionStates.push(app.finance.db.inTransaction);
        activeRequests += 1;
        maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
        await new Promise((resolve) => setTimeout(resolve, 10));
        activeRequests -= 1;
        if (current.symbol === "NOQUOTE") {
          throw new PriceProviderError(
            "raw upstream body: secret-provider-payload",
            "PRICE_UNAVAILABLE",
            502,
          );
        }
        if (current.symbol === "BROKEN") {
          throw new Error("raw upstream body: secret-unexpected-payload");
        }
        if (current.symbol === "NEGATIVE") {
          return {
            price: "-1",
            currency: "USDT",
            source: "batch-test",
            asOf: "2026-08-10T08:00:00.000Z",
          };
        }
        return {
          price: String(100 + Number(current.symbol.slice(-1))),
          currency: "USDT",
          source: `batch-test:${current.symbol}`,
          asOf: "2026-08-10T08:00:00.000Z",
        };
      },
      testConnection: async () => ({ ok: true, status: "connected", message: "ready" }),
    };
    app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      disableAuthenticationForTests: true,
      priceProvider: provider,
    });

    try {
      const createAsset = async (id: string, symbol: string, priceMode: "manual" | "provider") => {
        await request(app).post("/api/assets").send({
          id,
          name: id,
          symbol,
          kind: "crypto",
          account: "test",
          currency: "USDT",
          quantity: "1",
          unitCost: "0",
          currentPrice: "0",
          priceMode,
          priceSource: priceMode,
        }).expect(201);
      };
      await Promise.all([
        createAsset("provider-good-1", "GOOD1", "provider"),
        createAsset("provider-good-2", "GOOD2", "provider"),
        createAsset("provider-good-3", "GOOD3", "provider"),
        createAsset("provider-good-4", "GOOD4", "provider"),
        createAsset("provider-no-quote", "NOQUOTE", "provider"),
        createAsset("provider-broken", "BROKEN", "provider"),
        createAsset("provider-negative", "NEGATIVE", "provider"),
        createAsset("manual-asset", "MANUAL", "manual"),
      ]);

      const response = await request(app)
        .post("/api/assets/prices/refresh")
        .send({})
        .expect(200);

      expect(response.body.data.updated).toHaveLength(4);
      expect(response.body.data.skipped).toEqual([
        { id: "manual-asset", name: "manual-asset", reason: "PRICE_MODE_MANUAL" },
      ]);
      expect(response.body.data.failed).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "provider-no-quote",
          error: {
            code: "PRICE_UNAVAILABLE",
            message: "Price provider could not return a quote",
          },
        }),
        expect.objectContaining({
          id: "provider-broken",
          error: { code: "PRICE_REFRESH_FAILED", message: "Price refresh failed" },
        }),
        expect.objectContaining({
          id: "provider-negative",
          error: { code: "PRICE_INVALID", message: "Price provider returned an invalid price" },
        }),
      ]));
      expect(JSON.stringify(response.body)).not.toContain("secret-provider-payload");
      expect(JSON.stringify(response.body)).not.toContain("secret-unexpected-payload");
      expect(providerCalls).not.toContain("manual-asset");
      expect(maxActiveRequests).toBe(4);
      expect(transactionStates.every((state) => state === false)).toBe(true);
      expect(app.finance.db.prepare("SELECT COUNT(*) FROM price_snapshots").pluck().get()).toBe(4);
    } finally {
      app.finance.close();
    }
  });

  it("batch refreshes only assets owned by the authenticated tenant", async () => {
    const origin = "http://northstar-price.test";
    const providerCalls: string[] = [];
    const app = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      appBaseUrl: origin,
      priceProvider: {
        id: "tenant-test",
        getQuote: async (current) => {
          providerCalls.push(current.id);
          return {
            price: current.symbol === "ALICE" ? "11" : "22",
            currency: "USDT",
            source: "tenant-test",
            asOf: "2026-08-10T08:00:00.000Z",
          };
        },
        testConnection: async () => ({ ok: true, status: "connected", message: "ready" }),
      },
    });

    try {
      const signedIn = async (username: string) => {
        const user = await app.finance.authService.register({
          username,
          password: "correct horse battery staple",
        });
        app.finance.db.prepare("UPDATE users SET status = 'active' WHERE id = ?").run(user.id);
        const created = app.finance.authService.createSession(user.id, {
          userAgent: "price provider tenant test",
          ip: "127.0.0.1",
        });
        return {
          cookie: app.finance.authService.serializeSessionCookie(created).split(";", 1)[0] ?? "",
          csrfToken: created.session.csrfToken,
        };
      };
      const createOwnedAsset = async (
        account: Awaited<ReturnType<typeof signedIn>>,
        id: string,
        symbol: string,
      ) => {
        await request(app)
          .post("/api/assets")
          .set("Cookie", account.cookie)
          .set("Origin", origin)
          .set("X-CSRF-Token", account.csrfToken)
          .send({
            id,
            name: id,
            symbol,
            kind: "crypto",
            account: "test",
            currency: "USDT",
            quantity: "1",
            unitCost: "0",
            currentPrice: "0",
            priceMode: "provider",
            priceSource: "tenant-test",
          })
          .expect(201);
      };
      const alice = await signedIn("price-alice");
      const bob = await signedIn("price-bob");
      await createOwnedAsset(alice, "alice-provider-asset", "ALICE");
      await createOwnedAsset(bob, "bob-provider-asset", "BOB");

      const response = await request(app)
        .post("/api/assets/prices/refresh")
        .set("Cookie", alice.cookie)
        .set("Origin", origin)
        .set("X-CSRF-Token", alice.csrfToken)
        .send({})
        .expect(200);

      expect(response.body.data.updated.map((item: { id: string }) => item.id)).toEqual([
        "alice-provider-asset",
      ]);
      expect(providerCalls).toEqual(["alice-provider-asset"]);
      expect(app.finance.db.prepare(
        "SELECT current_price FROM assets WHERE id = 'alice-provider-asset'",
      ).pluck().get()).toBe("11");
      expect(app.finance.db.prepare(
        "SELECT current_price FROM assets WHERE id = 'bob-provider-asset'",
      ).pluck().get()).toBe("0");
      expect(app.finance.db.prepare(
        "SELECT COUNT(*) FROM price_snapshots WHERE asset_id = 'bob-provider-asset'",
      ).pluck().get()).toBe(0);
    } finally {
      app.finance.close();
    }
  });
});
