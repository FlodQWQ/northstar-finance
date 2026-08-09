import { Decimal } from "decimal.js";
import type { Asset } from "../../shared/types";

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
