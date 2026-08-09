import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import type { Asset } from "../shared/types";
import { createApp } from "../server/app";
import {
  ManualPriceProvider,
  MultiSourcePriceProvider,
  PriceProviderError,
  createPriceProviderFromEnv,
} from "../server/providers/price";

function asset(overrides: Partial<Asset> = {}): Asset {
  return {
    id: "asset-test",
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

  it("maps tokenized equity labels to each venue's market symbol", async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes("okx") && url.includes("XIBM-USDT")) {
        return json({ code: "0", data: [{ instId: "XIBM-USDT", last: "237.73" }] });
      }
      return json({}, 404);
    });
    const provider = new MultiSourcePriceProvider({ fetchImpl, cacheTtlMs: 0, maxQuoteTimeMs: 5_000 });

    const quote = await provider.getQuote(asset({ symbol: "IBMon", account: "okx wallet" }));

    expect(quote).toMatchObject({ price: "237.73", source: "okx:XIBM-USDT" });
    expect(fetchImpl.mock.calls[0]?.[0]).toContain("XIBM-USDT");
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
});
