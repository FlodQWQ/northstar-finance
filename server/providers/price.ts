import { Decimal } from "decimal.js";
import { ProxyAgent, type Dispatcher } from "undici";
import type { Asset } from "../../shared/types";

/** A normalized quote returned by every market-data adapter. */
export interface PriceQuote {
  price: string;
  currency: string;
  source: string;
  asOf: string;
  raw?: unknown;
}

export interface ConnectionTestResult {
  ok: boolean;
  status: "connected" | "skipped" | "failed";
  message: string;
}

export interface PriceProvider {
  readonly id: string;
  getQuote(asset: Asset): Promise<PriceQuote>;
  testConnection(): Promise<ConnectionTestResult>;
}

export class ManualPriceProvider implements PriceProvider {
  public readonly id = "manual";

  public async getQuote(asset: Asset): Promise<PriceQuote> {
    return {
      price: asset.currentPrice,
      currency: asset.currency,
      source: "manual",
      asOf: new Date().toISOString(),
      raw: { mode: "manual", reusedLastValue: true },
    };
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return {
      ok: true,
      status: "connected",
      message: "Manual pricing is available; no external connection is required.",
    };
  }
}

export class MockPriceProvider implements PriceProvider {
  public readonly id = "mock";

  public constructor(private readonly prices: Record<string, string> = {}) {}

  public async getQuote(asset: Asset): Promise<PriceQuote> {
    const configured = this.prices[asset.symbol.toUpperCase()];
    const price = configured ?? new Decimal(asset.currentPrice || "0").mul("1.001").toFixed();
    return {
      price,
      currency: asset.currency,
      source: this.id,
      asOf: new Date().toISOString(),
      raw: { mocked: true },
    };
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, status: "connected", message: "Mock price provider is ready." };
  }
}

/**
 * A structured error lets the HTTP layer distinguish an unavailable market
 * from an application bug without exposing upstream response bodies.
 */
export class PriceProviderError extends Error {
  public constructor(
    message: string,
    public readonly code = "PRICE_UNAVAILABLE",
    public readonly status = 502,
  ) {
    super(message);
    this.name = "PriceProviderError";
  }
}

type FetchInit = RequestInit & { dispatcher?: Dispatcher };
export type PriceFetch = (url: string, init?: FetchInit) => Promise<Response>;

export interface MarketPriceProviderOptions {
  /** Optional outbound proxy. Only HTTP(S) proxy URLs are accepted. */
  proxyUrl?: string;
  timeoutMs?: number;
  /** Upper bound for the complete fallback chain for one asset. */
  maxQuoteTimeMs?: number;
  cacheTtlMs?: number;
  /** Override the public fetch implementation in tests or a worker. */
  fetchImpl?: PriceFetch;
  /** Prefer the named venue when an asset account does not identify one. */
  preferredVenue?: PriceVenue;
  /** Additional CoinGecko ids, keyed by normalized symbol. */
  coingeckoIds?: Record<string, string>;
  /** Additional exchange symbol aliases, keyed by normalized symbol. */
  symbolAliases?: Record<string, string>;
}

export type PriceVenue =
  | "binance"
  | "okx"
  | "bitget"
  | "bybit"
  | "gate"
  | "coingecko"
  | "yahoo";

interface MarketRequest {
  base: string;
  quote: string;
  outputCurrency: string;
  asset: Asset;
  timeoutMs?: number;
}

interface PriceAdapter {
  readonly id: PriceVenue;
  getQuote(request: MarketRequest): Promise<PriceQuote | null>;
}

const DEFAULT_TIMEOUT_MS = 6_000;
const DEFAULT_MAX_QUOTE_TIME_MS = 15_000;
const DEFAULT_CACHE_TTL_MS = 15_000;
const MAX_RESPONSE_BYTES = 512 * 1024;
const MAX_CACHE_ENTRIES = 512;

const ALLOWED_HOSTS = new Set([
  "api.binance.com",
  "www.okx.com",
  "api.bitget.com",
  "api.bybit.com",
  "api.gateio.ws",
  "api.coingecko.com",
  "query1.finance.yahoo.com",
]);

const DEFAULT_COINGECKO_IDS: Record<string, string> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  SOL: "solana",
  CFX: "conflux-token",
  OKB: "okb",
  XAUT: "tether-gold",
  USDT: "tether",
  U: "united-stables",
  USDC: "usd-coin",
  SEI: "sei-network",
  RLUSD: "ripple-usd",
  USD1: "usd1-wlfi",
  XPL: "plasma",
  NVDAON: "nvidia-ondo-tokenized-stock",
  QQQON: "invesco-qqq-etf-ondo-tokenized-etf",
  IBMON: "ibm-ondo-tokenized-stock",
  SPSEI: "splashing-staked-sei",
  PREOPAI: "openai-republic-pre-ipo",
  SUSDAT: "saturn-susdat",
};

const DEFAULT_VENUE_SYMBOL_ALIASES: Record<string, string> = {};

// The user elected to value Ondo holdings from their underlying securities;
// Yahoo quotes are therefore recorded explicitly as proxies. Similar
// X-prefixed and R-prefixed tickers are separate tokenized products and must
// not be treated as aliases merely because their prices are close.
const DEFAULT_SOURCE_VENUES: Partial<Record<string, readonly PriceVenue[]>> = {
  NVDAON: ["yahoo", "gate", "coingecko"],
  QQQON: ["yahoo", "gate", "coingecko"],
  IBMON: ["yahoo", "coingecko"],
  SPSEI: ["coingecko"],
  SUSDAT: ["coingecko"],
};

const DEFAULT_UNDERLYING_SECURITY_SYMBOLS: Record<string, string> = {
  NVDAON: "NVDA",
  QQQON: "QQQ",
  IBMON: "IBM",
};

// These assets are either stable-value instruments or account labels rather
// than exchange symbols. Explicit pegs avoid needless upstream calls. sUSDat
// is intentionally excluded: it can trade away from its target, so an
// upstream outage must not silently replace its last quote with 1 USDT.
const PEGGED_SYMBOLS = new Set(["USDT", "USD1", "RLUSD", "USDTDEBT"]);
const STABLE_SYMBOLS = new Set([...PEGGED_SYMBOLS, "U"]);
const PEG_COMPATIBLE_CURRENCIES = new Set(["USD", "USDT", "USDC", "USD1", "RLUSD"]);

function normalizeSymbol(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeCurrency(value: string): string {
  return value.normalize("NFKC").trim().toUpperCase();
}

function normalizeAliasMap(input: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    const normalizedKey = key.includes(":")
      ? `${key.slice(0, key.indexOf(":")).trim().toUpperCase()}:${normalizeSymbol(key.slice(key.indexOf(":") + 1))}`
      : normalizeSymbol(key);
    const normalizedValue = normalizeSymbol(value);
    if (normalizedKey && normalizedValue && normalizedValue.length <= 40) {
      output[normalizedKey] = normalizedValue;
    }
  }
  return output;
}

function normalizeCoinGeckoMap(input: Record<string, string> | undefined): Record<string, string> {
  const output: Record<string, string> = {};
  if (!input) return output;
  for (const [key, value] of Object.entries(input).slice(0, 100)) {
    const normalizedKey = normalizeSymbol(key);
    const id = value.trim();
    if (normalizedKey && /^[a-z0-9][a-z0-9-]{0,99}$/i.test(id)) output[normalizedKey] = id;
  }
  return output;
}

function venueFromText(value: string): PriceVenue | undefined {
  const normalized = value.normalize("NFKC").toLowerCase();
  if (normalized.includes("binance")) return "binance";
  if (normalized.includes("okx") || normalized.includes("okex")) return "okx";
  if (normalized.includes("bitget")) return "bitget";
  if (normalized.includes("bybit")) return "bybit";
  if (normalized.includes("gate")) return "gate";
  if (normalized.includes("coingecko") || normalized.includes("coin gecko")) return "coingecko";
  if (normalized.includes("yahoo")) return "yahoo";
  return undefined;
}

function chooseOutputQuotes(currency: string): string[] {
  const normalized = normalizeCurrency(currency);
  // Spot venues consistently publish USDT pairs. USD is treated as a 1:1
  // display denomination only as a final exchange fallback; CoinGecko can
  // provide an actual USD quote for supported assets.
  if (normalized === "USD") return ["USD", "USDT"];
  if (normalized === "CNY") return ["CNY"];
  if (normalized === "USDT" || normalized === "USDC" || normalized === "USD1" || normalized === "RLUSD") {
    return ["USDT"];
  }
  return [normalized];
}

function assetBaseSymbol(asset: Asset, aliases: Record<string, string>): string {
  const rawSymbol = normalizeSymbol(asset.symbol);
  const rawName = normalizeSymbol(asset.name);
  const explicit = aliases[rawSymbol] ?? aliases[rawName];
  if (explicit) return explicit;
  if (rawName === "USDTDEBT" || rawSymbol === "USDTDEBT") return "USDT";
  if (!rawSymbol && rawName === "GATE") return "USDT";
  if (!rawSymbol) {
    const currency = normalizeCurrency(asset.currency);
    if (STABLE_SYMBOLS.has(currency)) return currency === "U" ? "USDT" : currency;
  }
  return rawSymbol;
}

function isStableAsset(asset: Asset, base: string): boolean {
  const symbol = normalizeSymbol(asset.symbol);
  const name = normalizeSymbol(asset.name);
  return STABLE_SYMBOLS.has(base) || STABLE_SYMBOLS.has(symbol) || STABLE_SYMBOLS.has(name);
}

function isExplicitPeg(asset: Asset, base: string): boolean {
  const symbol = normalizeSymbol(asset.symbol);
  const name = normalizeSymbol(asset.name);
  return PEGGED_SYMBOLS.has(base) || PEGGED_SYMBOLS.has(symbol) || PEGGED_SYMBOLS.has(name);
}

function isPegCompatibleCurrency(currency: string): boolean {
  return PEG_COMPATIBLE_CURRENCIES.has(currency);
}

function validDecimal(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(text)) return null;
  try {
    const decimal = new Decimal(text);
    if (!decimal.isFinite() || decimal.isNegative()) return null;
    return decimal.toFixed();
  } catch {
    return null;
  }
}

function quoteFromValue(
  value: unknown,
  source: string,
  currency: string,
  raw: unknown,
  asOf?: unknown,
): PriceQuote | null {
  const price = validDecimal(value);
  if (!price) return null;
  const numericAsOf = typeof asOf === "number"
    ? asOf
    : typeof asOf === "string" && /^\d+(?:\.\d+)?$/.test(asOf.trim())
      ? Number(asOf)
      : undefined;
  let parsedAsOf = new Date().toISOString();
  try {
    if (numericAsOf !== undefined && Number.isFinite(numericAsOf)) {
      const date = new Date(numericAsOf > 10_000_000_000 ? numericAsOf : numericAsOf * 1_000);
      if (!Number.isNaN(date.getTime())) parsedAsOf = date.toISOString();
    } else if (typeof asOf === "string" && !Number.isNaN(Date.parse(asOf))) {
      parsedAsOf = new Date(asOf).toISOString();
    }
  } catch {
    // A malformed upstream timestamp must not discard an otherwise valid quote.
  }
  return { price, currency, source, asOf: parsedAsOf, raw };
}

function exchangeRaw(request: MarketRequest, raw: Record<string, unknown>): Record<string, unknown> {
  return request.quote === request.outputCurrency
    ? raw
    : {
        market: raw,
        sourceCurrency: request.quote,
        outputCurrency: request.outputCurrency,
        approximatePeg: true,
      };
}

class JsonHttpClient {
  private readonly fetchImpl: PriceFetch;
  private readonly dispatcher?: Dispatcher;

  public constructor(
    private readonly timeoutMs: number,
    fetchImpl?: PriceFetch,
    proxyUrl?: string,
  ) {
    this.fetchImpl = fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    if (proxyUrl) {
      let parsed: URL;
      try {
        parsed = new URL(proxyUrl);
      } catch {
        throw new PriceProviderError("Price proxy URL is invalid", "PRICE_PROXY_INVALID", 500);
      }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new PriceProviderError("Price proxy must use HTTP(S)", "PRICE_PROXY_INVALID", 500);
      }
      this.dispatcher = new ProxyAgent(parsed.toString());
    }
  }

  public async getJson(url: string, timeoutMs = this.timeoutMs): Promise<unknown> {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !ALLOWED_HOSTS.has(parsed.hostname)) {
      throw new PriceProviderError("Price provider target is not allowed", "PRICE_TARGET_BLOCKED", 500);
    }

    let response: Response;
    let lastError: unknown;
    const deadline = Date.now() + timeoutMs;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) break;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remainingMs);
      try {
        response = await this.fetchImpl(url, {
          method: "GET",
          headers: {
            accept: "application/json",
            "user-agent": "Mozilla/5.0 (compatible; NorthstarFinance/0.1)",
          },
          redirect: "error",
          signal: controller.signal,
          ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
        });
        if ((response.status === 429 || response.status >= 500) && attempt === 0) {
          await response.body?.cancel().catch(() => undefined);
          const retryAfter = Number(response.headers.get("retry-after") ?? "0");
          const delay = Number.isFinite(retryAfter) && retryAfter > 0
            ? Math.min(1_000, retryAfter * 1_000)
            : 100;
          const boundedDelay = Math.min(delay, Math.max(0, deadline - Date.now()));
          if (boundedDelay > 0) await new Promise((resolve) => setTimeout(resolve, boundedDelay));
          continue;
        }
        if (!response.ok) {
          await response.body?.cancel().catch(() => undefined);
          throw new PriceProviderError(`Upstream returned HTTP ${response.status}`, "UPSTREAM_HTTP_ERROR");
        }
        const contentLength = Number(response.headers.get("content-length") ?? "0");
        if (Number.isFinite(contentLength) && contentLength > MAX_RESPONSE_BYTES) {
          throw new PriceProviderError("Upstream response is too large", "UPSTREAM_RESPONSE_TOO_LARGE");
        }
        const body = await this.readBody(response);
        try {
          return JSON.parse(body) as unknown;
        } catch {
          throw new PriceProviderError("Upstream returned invalid JSON", "UPSTREAM_INVALID_JSON");
        }
      } catch (error) {
        lastError = error;
        // Transient HTTP statuses already take the retry branch above. DNS,
        // connection, timeout, 4xx, parsing and size errors fall through to
        // the next provider instead of multiplying fallback latency.
        break;
      } finally {
        clearTimeout(timer);
      }
    }
    if (lastError instanceof PriceProviderError) throw lastError;
    if (Date.now() >= deadline) {
      throw new PriceProviderError("Price upstream request timed out", "UPSTREAM_TIMEOUT");
    }
    throw new PriceProviderError("Price upstream request failed", "UPSTREAM_REQUEST_FAILED");
  }

  private async readBody(response: Response): Promise<string> {
    if (!response.body) {
      const body = await response.text();
      if (Buffer.byteLength(body, "utf8") > MAX_RESPONSE_BYTES) {
        throw new PriceProviderError("Upstream response is too large", "UPSTREAM_RESPONSE_TOO_LARGE");
      }
      return body;
    }
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        total += chunk.byteLength;
        if (total > MAX_RESPONSE_BYTES) {
          await reader.cancel();
          throw new PriceProviderError("Upstream response is too large", "UPSTREAM_RESPONSE_TOO_LARGE");
        }
        chunks.push(chunk);
      }
    } finally {
      reader.releaseLock();
    }
    const result = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(result);
  }
}

abstract class ExchangeAdapter implements PriceAdapter {
  public abstract readonly id: PriceVenue;

  public constructor(protected readonly http: JsonHttpClient) {}

  public abstract getQuote(request: MarketRequest): Promise<PriceQuote | null>;
}

class BinanceAdapter extends ExchangeAdapter {
  public readonly id = "binance" as const;

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (request.quote !== "USDT") return null;
    const symbol = `${request.base}${request.quote}`;
    const body = await this.http.getJson(
      `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(symbol)}`,
      request.timeoutMs,
    );
    if (!body || typeof body !== "object") return null;
    const bodyObject = body as Record<string, unknown>;
    if (typeof bodyObject.symbol === "string" && bodyObject.symbol !== symbol) return null;
    const value = bodyObject.price;
    return quoteFromValue(value, `binance:${symbol}`, request.outputCurrency, exchangeRaw(request, bodyObject));
  }
}

class OkxAdapter extends ExchangeAdapter {
  public readonly id = "okx" as const;

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (request.quote !== "USDT") return null;
    const instId = `${request.base}-${request.quote}`;
    const body = await this.http.getJson(
      `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(instId)}`,
      request.timeoutMs,
    );
    if (!body || typeof body !== "object") return null;
    const bodyObject = body as Record<string, unknown>;
    if (bodyObject.code !== "0") return null;
    const rows = bodyObject.data;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const value = (row as Record<string, unknown>).last;
    const rowObject = row as Record<string, unknown>;
    return quoteFromValue(
      value,
      `okx:${instId}`,
      request.outputCurrency,
      exchangeRaw(request, rowObject),
      rowObject.ts,
    );
  }
}

class BitgetAdapter extends ExchangeAdapter {
  public readonly id = "bitget" as const;

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (request.quote !== "USDT") return null;
    const symbol = `${request.base}${request.quote}`;
    const body = await this.http.getJson(
      `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${encodeURIComponent(symbol)}`,
      request.timeoutMs,
    );
    if (!body || typeof body !== "object") return null;
    const bodyObject = body as Record<string, unknown>;
    if (bodyObject.code !== "00000") return null;
    const rows = bodyObject.data;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const value = (row as Record<string, unknown>).lastPr;
    return quoteFromValue(
      value,
      `bitget:${symbol}`,
      request.outputCurrency,
      exchangeRaw(request, row as Record<string, unknown>),
      bodyObject.requestTime,
    );
  }
}

class BybitAdapter extends ExchangeAdapter {
  public readonly id = "bybit" as const;

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (request.quote !== "USDT") return null;
    const symbol = `${request.base}${request.quote}`;
    const body = await this.http.getJson(
      `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(symbol)}`,
      request.timeoutMs,
    );
    if (!body || typeof body !== "object") return null;
    const bodyObject = body as Record<string, unknown>;
    if (bodyObject.retCode !== 0 && bodyObject.retCode !== "0") return null;
    const result = bodyObject.result;
    const rows = result && typeof result === "object"
      ? (result as Record<string, unknown>).list
      : undefined;
    const row = Array.isArray(rows) ? rows[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const value = (row as Record<string, unknown>).lastPrice;
    return quoteFromValue(
      value,
      `bybit:${symbol}`,
      request.outputCurrency,
      exchangeRaw(request, row as Record<string, unknown>),
      bodyObject.time,
    );
  }
}

class GateAdapter extends ExchangeAdapter {
  public readonly id = "gate" as const;

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (request.quote !== "USDT") return null;
    const pair = `${request.base}_${request.quote}`;
    const body = await this.http.getJson(
      `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(pair)}`,
      request.timeoutMs,
    );
    const row = Array.isArray(body) ? body[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const rowObject = row as Record<string, unknown>;
    if (typeof rowObject.currency_pair === "string" && rowObject.currency_pair !== pair) return null;
    const value = rowObject.last;
    return quoteFromValue(
      value,
      `gate:${pair}`,
      request.outputCurrency,
      exchangeRaw(request, rowObject),
      rowObject.timestamp,
    );
  }
}

class YahooFinanceAdapter implements PriceAdapter {
  public readonly id = "yahoo" as const;

  public constructor(private readonly http: JsonHttpClient) {}

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    if (!isPegCompatibleCurrency(request.outputCurrency)) return null;
    const body = await this.http.getJson(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(request.base)}?interval=1d&range=5d`,
      request.timeoutMs,
    );
    if (!body || typeof body !== "object") return null;
    const chart = (body as Record<string, unknown>).chart;
    if (!chart || typeof chart !== "object") return null;
    const result = (chart as Record<string, unknown>).result;
    const row = Array.isArray(result) ? result[0] : undefined;
    if (!row || typeof row !== "object") return null;
    const meta = (row as Record<string, unknown>).meta;
    if (!meta || typeof meta !== "object") return null;
    const metaObject = meta as Record<string, unknown>;
    if (metaObject.currency !== "USD") return null;
    if (
      typeof metaObject.symbol === "string"
      && normalizeSymbol(metaObject.symbol) !== request.base
    ) return null;
    return quoteFromValue(
      metaObject.regularMarketPrice,
      `yahoo-underlying:${request.base}:USD`,
      request.outputCurrency,
      {
        symbol: metaObject.symbol,
        instrumentType: metaObject.instrumentType,
        exchangeName: metaObject.exchangeName,
        marketCurrency: "USD",
        approximatePeg: request.outputCurrency !== "USD",
        underlyingProxy: true,
        underlyingSymbol: request.base,
      },
      metaObject.regularMarketTime,
    );
  }
}

class CoinGeckoAdapter implements PriceAdapter {
  public readonly id = "coingecko" as const;

  public constructor(
    private readonly http: JsonHttpClient,
    private readonly ids: Record<string, string>,
  ) {}

  public async getQuote(request: MarketRequest): Promise<PriceQuote | null> {
    const id = this.ids[request.base];
    if (!id) return null;
    // CoinGecko's free endpoint does not expose a `usdt` denomination. USD is
    // a deliberate 1:1 fallback for USDT-like portfolio display currencies;
    // exchange adapters remain preferred whenever they are reachable.
    const sourceCurrency = request.outputCurrency === "USDT"
      || request.outputCurrency === "USDC"
      || request.outputCurrency === "USD1"
      || request.outputCurrency === "RLUSD"
      ? "usd"
      : request.outputCurrency.toLowerCase();
    const quoteCurrency = sourceCurrency;
    if (!/^[a-z]{2,8}$/.test(quoteCurrency)) return null;
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(id)}&vs_currencies=${encodeURIComponent(quoteCurrency)}&include_last_updated_at=true`;
    const body = await this.http.getJson(url, request.timeoutMs);
    if (!body || typeof body !== "object") return null;
    const row = (body as Record<string, unknown>)[id];
    if (!row || typeof row !== "object") return null;
    const rowObject = row as Record<string, unknown>;
    return quoteFromValue(
      rowObject[quoteCurrency],
      `coingecko:${id}:${quoteCurrency}`,
      request.outputCurrency,
      request.outputCurrency.toLowerCase() === quoteCurrency
        ? row
        : { ...rowObject, sourceCurrency, approximatePeg: true },
      rowObject.last_updated_at,
    );
  }

}

interface CachedQuote {
  quote: PriceQuote;
  expiresAt: number;
}

/**
 * Public, keyless market-data provider.
 *
 * Account names are used only as a preference hint (for example, "OKX wallet"
 * prefers OKX). A failed or missing market falls through to the other public
 * venues and finally CoinGecko. No provider receives database access or user
 * supplied URLs.
 */
export class MultiSourcePriceProvider implements PriceProvider {
  public readonly id = "multi";
  private readonly http: JsonHttpClient;
  private readonly adapters: Map<PriceVenue, PriceAdapter>;
  private readonly timeoutMs: number;
  private readonly maxQuoteTimeMs: number;
  private readonly cacheTtlMs: number;
  private readonly preferredVenue?: PriceVenue;
  private readonly symbolAliases: Record<string, string>;
  private readonly coingeckoIds: Record<string, string>;
  private readonly cache = new Map<string, CachedQuote>();
  private readonly inFlight = new Map<string, Promise<PriceQuote | null>>();

  public constructor(options: MarketPriceProviderOptions = {}) {
    this.timeoutMs = clampInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, 1_000, 30_000);
    this.maxQuoteTimeMs = clampInteger(
      options.maxQuoteTimeMs ?? DEFAULT_MAX_QUOTE_TIME_MS,
      2_000,
      60_000,
    );
    this.cacheTtlMs = clampInteger(options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS, 0, 10 * 60_000);
    this.preferredVenue = options.preferredVenue;
    this.symbolAliases = {
      ...DEFAULT_VENUE_SYMBOL_ALIASES,
      ...normalizeAliasMap(options.symbolAliases),
    };
    this.coingeckoIds = {
      ...DEFAULT_COINGECKO_IDS,
      ...normalizeCoinGeckoMap(options.coingeckoIds),
    };
    this.http = new JsonHttpClient(this.timeoutMs, options.fetchImpl, options.proxyUrl);
    const adapters: PriceAdapter[] = [
      new BinanceAdapter(this.http),
      new OkxAdapter(this.http),
      new BitgetAdapter(this.http),
      new BybitAdapter(this.http),
      new GateAdapter(this.http),
      new YahooFinanceAdapter(this.http),
      new CoinGeckoAdapter(this.http, this.coingeckoIds),
    ];
    this.adapters = new Map(adapters.map((adapter) => [adapter.id, adapter]));
  }

  public async getQuote(asset: Asset): Promise<PriceQuote> {
    const base = assetBaseSymbol(asset, this.symbolAliases);
    if (!base) {
      throw new PriceProviderError("Asset has no market symbol", "PRICE_SYMBOL_MISSING", 422);
    }
    if (base.length > 40) {
      throw new PriceProviderError("Asset market symbol is too long", "PRICE_SYMBOL_INVALID", 422);
    }
    const outputCurrency = normalizeCurrency(asset.currency);
    if (!outputCurrency) {
      throw new PriceProviderError("Asset has no quote currency", "PRICE_CURRENCY_MISSING", 422);
    }

    if (isExplicitPeg(asset, base) && isPegCompatibleCurrency(outputCurrency)) {
      return quoteFromValue("1", "stable-peg", outputCurrency, {
        stablePeg: true,
        symbol: asset.symbol,
      }) as PriceQuote;
    }
    const stableFallback = isStableAsset(asset, base);
    const venues = this.orderedVenues(asset, base);
    const deadline = Date.now() + this.maxQuoteTimeMs;
    const errors: string[] = [];
    for (const venue of venues) {
      const adapter = this.adapters.get(venue);
      if (!adapter) continue;
      for (const quoteCurrency of chooseOutputQuotes(outputCurrency)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        // CoinGecko uses the requested display currency; exchanges use USDT.
        if (venue !== "coingecko" && venue !== "yahoo" && quoteCurrency !== "USDT") continue;
        const request: MarketRequest = {
          base: this.marketBaseFor(venue, base),
          quote: quoteCurrency,
          outputCurrency,
          asset,
          timeoutMs: Math.min(this.timeoutMs, remainingMs),
        };
        const cacheKey = `${venue}:${base}:${quoteCurrency}:${outputCurrency}`;
        const cached = this.cache.get(cacheKey);
        if (cached && cached.expiresAt > Date.now()) return cached.quote;
        if (cached) this.cache.delete(cacheKey);
        try {
          const quote = await this.getQuoteInFlight(cacheKey, adapter, request);
          if (!quote) continue;
          this.putCache(cacheKey, quote);
          return quote;
        } catch (error) {
          errors.push(`${venue}:${error instanceof Error ? error.message : "request failed"}`);
        }
      }
    }

    // Stable balances and debt rows have an explicit 1-unit peg fallback. It
    // avoids turning a temporary venue outage into a zero-valued liability.
    if (stableFallback && isPegCompatibleCurrency(outputCurrency)) {
      const quote = quoteFromValue(
        "1",
        "stable-peg",
        outputCurrency,
        { stablePeg: true, upstreamErrors: errors.slice(0, 3) },
      );
      if (quote) return quote;
    }
    throw new PriceProviderError(
      errors.length > 0
        ? `No public quote available for ${base}/${outputCurrency}`
        : `No public market is configured for ${base}/${outputCurrency}`,
      "PRICE_UNAVAILABLE",
      502,
    );
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    const now = new Date().toISOString();
    try {
      const quote = await this.getQuote({
        id: "price-provider-test",
        name: "Bitcoin",
        symbol: "BTC",
        kind: "crypto",
        account: this.preferredVenue ?? "",
        currency: "USDT",
        quantity: "0",
        unitCost: "0",
        currentPrice: "0",
        marketValue: "0",
        costBasis: "0",
        pnl: "0",
        pnlPercent: "0",
        priceMode: "provider",
        priceSource: this.preferredVenue ?? "multi",
        priceUpdatedAt: now,
        staleAfterHours: 24,
        notes: "",
        createdAt: now,
        updatedAt: now,
      });
      return {
        ok: true,
        status: "connected",
        message: `Public market data is reachable via ${quote.source.split(":", 1)[0]}.`,
      };
    } catch {
      return {
        ok: false,
        status: "failed",
        message: "No configured public market-data source responded.",
      };
    }
  }

  private orderedVenues(asset: Asset, normalizedBase: string): PriceVenue[] {
    const hinted = venueFromText(asset.account ?? "") ?? venueFromText(asset.priceSource ?? "");
    const first = hinted ?? this.preferredVenue;
    const semanticSources = DEFAULT_SOURCE_VENUES[normalizedBase] ?? [];
    const all: PriceVenue[] = ["binance", "okx", "bitget", "bybit", "gate", "coingecko"];
    return [...semanticSources, first, ...all]
      .filter((venue): venue is PriceVenue => venue !== undefined)
      .filter((venue, index, venues) => venues.indexOf(venue) === index);
  }

  private getQuoteInFlight(
    cacheKey: string,
    adapter: PriceAdapter,
    request: MarketRequest,
  ): Promise<PriceQuote | null> {
    const existing = this.inFlight.get(cacheKey);
    if (existing) return existing;
    const pending = adapter.getQuote(request).finally(() => {
      if (this.inFlight.get(cacheKey) === pending) this.inFlight.delete(cacheKey);
    });
    this.inFlight.set(cacheKey, pending);
    return pending;
  }

  private marketBaseFor(venue: PriceVenue, normalizedBase: string): string {
    return this.symbolAliases[`${venue.toUpperCase()}:${normalizedBase}`]
      ?? (venue === "yahoo" ? DEFAULT_UNDERLYING_SECURITY_SYMBOLS[normalizedBase] : undefined)
      ?? this.symbolAliases[normalizedBase]
      ?? normalizedBase;
  }

  private putCache(key: string, quote: PriceQuote): void {
    if (this.cacheTtlMs <= 0) return;
    this.cache.set(key, { quote, expiresAt: Date.now() + this.cacheTtlMs });
    while (this.cache.size > MAX_CACHE_ENTRIES) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
    }
  }
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.min(maximum, Math.max(minimum, Math.trunc(value)));
}

function parseJsonObject(value: string | undefined, label: string): Record<string, string> {
  if (!value?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("must be a JSON object");
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof item === "string") result[key] = item;
    }
    return result;
  } catch {
    throw new PriceProviderError(`${label} must be a JSON object`, "PRICE_CONFIG_INVALID", 500);
  }
}

function parseOptionalNumber(value: string | undefined, label: string): number | undefined {
  if (!value?.trim()) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new PriceProviderError(`${label} must be a finite number`, "PRICE_CONFIG_INVALID", 500);
  }
  return parsed;
}

/** Build the provider selected by environment without making a network call. */
export function createPriceProviderFromEnv(env: NodeJS.ProcessEnv = process.env): PriceProvider {
  const configured = (env.PRICE_PROVIDER ?? "manual").trim().toLowerCase();
  if (configured === "manual" || configured === "none" || configured === "disabled") {
    return new ManualPriceProvider();
  }
  if (configured === "mock") return new MockPriceProvider();
  const supported: PriceVenue[] = ["binance", "okx", "bitget", "bybit", "gate", "coingecko"];
  const preferredVenue = supported.includes(configured as PriceVenue)
    ? configured as PriceVenue
    : undefined;
  if (configured !== "multi" && configured !== "public" && !preferredVenue) {
    throw new PriceProviderError(
      "PRICE_PROVIDER must be manual, mock, multi, public, or a supported venue",
      "PRICE_CONFIG_INVALID",
      500,
    );
  }
  // Explicit PRICE_PROXY wins. Container-specific values are safe deployment
  // fallbacks; generic proxy variables are only read in local development so
  // a host-local 127.0.0.1 proxy is never inherited accidentally in production.
  const proxyUrl = env.PRICE_PROXY?.trim()
    || env.CONTAINER_HTTPS_PROXY?.trim()
    || env.CONTAINER_HTTP_PROXY?.trim()
    || (env.NODE_ENV !== "production" ? env.HTTPS_PROXY?.trim() || env.HTTP_PROXY?.trim() : undefined)
    || undefined;
  const timeoutMs = parseOptionalNumber(env.PRICE_TIMEOUT_MS, "PRICE_TIMEOUT_MS");
  const maxQuoteTimeMs = parseOptionalNumber(env.PRICE_MAX_QUOTE_TIME_MS, "PRICE_MAX_QUOTE_TIME_MS");
  const cacheTtlMs = parseOptionalNumber(env.PRICE_CACHE_TTL_MS, "PRICE_CACHE_TTL_MS");
  return new MultiSourcePriceProvider({
    proxyUrl,
    timeoutMs,
    maxQuoteTimeMs,
    cacheTtlMs,
    preferredVenue,
    symbolAliases: parseJsonObject(env.PRICE_SYMBOL_ALIASES_JSON, "PRICE_SYMBOL_ALIASES_JSON"),
    coingeckoIds: parseJsonObject(env.PRICE_COINGECKO_IDS_JSON, "PRICE_COINGECKO_IDS_JSON"),
  });
}
