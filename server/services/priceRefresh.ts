import { ZodError } from "zod";
import type { PriceProvider } from "../providers/price";
import { PriceProviderError } from "../providers/price";
import { nonNegativeDecimalString } from "../validation";
import { DomainError, type FinanceRepository, type VersionedAsset } from "./repository";

export interface PriceRefreshErrorInfo {
  code: string;
  message: string;
}

function normalizeConcurrency(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.min(32, Math.floor(value))) : 4;
}

function createAsyncLimiter(concurrency: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  return async function runLimited<T>(task: () => Promise<T>): Promise<T> {
    if (active >= concurrency) {
      await new Promise<void>((resolve) => queue.push(resolve));
    }
    active += 1;
    try {
      return await task();
    } finally {
      active -= 1;
      queue.shift()?.();
    }
  };
}

export function describePriceRefreshError(error: unknown): PriceRefreshErrorInfo {
  if (error instanceof ZodError) {
    return {
      code: "PRICE_INVALID",
      message: "Price provider returned an invalid price",
    };
  }
  if (error instanceof PriceProviderError) {
    const code = /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code)
      ? error.code
      : "PRICE_REFRESH_FAILED";
    return {
      code,
      message: "Price provider could not return a quote",
    };
  }
  if (error instanceof DomainError) {
    return {
      code: error.code,
      message: error.code === "ASSET_CHANGED"
        ? "Asset changed while its provider price was being fetched"
        : "Asset price could not be updated",
    };
  }
  return {
    code: "PRICE_REFRESH_FAILED",
    message: "Price refresh failed",
  };
}

export class ProviderPriceRefresher {
  private readonly runLimited: <T>(task: () => Promise<T>) => Promise<T>;

  public constructor(
    private readonly provider: PriceProvider,
    concurrency = 4,
  ) {
    this.runLimited = createAsyncLimiter(normalizeConcurrency(concurrency));
  }

  public get providerId(): string {
    return this.provider.id;
  }

  public async refresh(
    repository: FinanceRepository,
    asset: VersionedAsset,
  ): Promise<VersionedAsset> {
    return this.runLimited(async () => {
      // Network work stays outside a database transaction. The repository
      // applies the quote only if owner, version, and provider mode still match.
      const quote = await this.provider.getQuote(asset);
      const validatedQuote = {
        ...quote,
        price: nonNegativeDecimalString.parse(quote.price),
      };
      return repository.updateProviderPrice(asset.id, asset.version, validatedQuote);
    });
  }
}
