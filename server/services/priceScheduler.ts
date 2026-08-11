import type { Asset } from "../../shared/types";
import type { SqliteDatabase } from "../db/database";
import { FinanceRepository } from "./repository";
import {
  describePriceRefreshError,
  type PriceRefreshErrorInfo,
  ProviderPriceRefresher,
} from "./priceRefresh";

const HOUR_MS = 60 * 60 * 1_000;

export interface AssetPriceSchedulerOptions {
  pollMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  onError?: (error: unknown) => void;
}

export type AssetPriceSkipReason =
  | "PRICE_MODE_MANUAL"
  | "PRICE_FRESH"
  | "PRICE_BACKOFF"
  | "PRICE_PROVIDER_DISABLED";

interface AssetPriceTickItem {
  ownerId: string;
  assetId: string;
  name: string;
}

export interface AssetPriceTickResult {
  busy: boolean;
  updated: AssetPriceTickItem[];
  failed: Array<AssetPriceTickItem & { error: PriceRefreshErrorInfo }>;
  skipped: Array<AssetPriceTickItem & { reason: AssetPriceSkipReason }>;
}

interface RetryState {
  failures: number;
  nextAttemptAt: number;
}

interface Candidate {
  key: string;
  ownerId: string;
  repository: FinanceRepository;
  asset: ReturnType<FinanceRepository["getAsset"]>;
}

function duration(value: number | undefined, fallback: number, minimum: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(minimum, Math.floor(value));
}

function emptyTickResult(busy = false): AssetPriceTickResult {
  return { busy, updated: [], failed: [], skipped: [] };
}

function assetKey(ownerId: string, assetId: string): string {
  return `${ownerId}\u0000${assetId}`;
}

export function isAssetPriceDue(asset: Asset, now = new Date()): boolean {
  if (asset.priceMode !== "provider") return false;
  const updatedAt = Date.parse(asset.priceUpdatedAt);
  if (!Number.isFinite(updatedAt)) return true;
  return updatedAt + asset.staleAfterHours * HOUR_MS <= now.getTime();
}

export class AssetPriceScheduler {
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private readonly retryState = new Map<string, RetryState>();
  private readonly pollMs: number;
  private readonly retryBaseMs: number;
  private readonly retryMaxMs: number;
  private readonly onError: (error: unknown) => void;

  public constructor(
    private readonly db: SqliteDatabase,
    private readonly refresher: ProviderPriceRefresher,
    options: AssetPriceSchedulerOptions = {},
  ) {
    this.pollMs = duration(
      options.pollMs ?? Number(process.env.PRICE_SCHEDULER_POLL_MS),
      5 * 60 * 1_000,
      1_000,
    );
    this.retryBaseMs = duration(
      options.retryBaseMs ?? Number(process.env.PRICE_SCHEDULER_RETRY_BASE_MS),
      60_000,
      1_000,
    );
    this.retryMaxMs = Math.max(
      this.retryBaseMs,
      duration(
        options.retryMaxMs ?? Number(process.env.PRICE_SCHEDULER_RETRY_MAX_MS),
        60 * 60 * 1_000,
        1_000,
      ),
    );
    this.onError = options.onError ?? ((error) => {
      console.error("Automatic asset price refresh failed", error);
    });
  }

  public start(): void {
    if (this.timer) return;
    void this.tick().catch(this.onError);
    this.timer = setInterval(() => {
      void this.tick().catch(this.onError);
    }, this.pollMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  public async tick(now = new Date()): Promise<AssetPriceTickResult> {
    if (this.ticking) return emptyTickResult(true);
    this.ticking = true;
    try {
      const result = emptyTickResult();
      const candidates: Candidate[] = [];
      const seenKeys = new Set<string>();
      const owners = this.db.prepare(`
        SELECT id FROM users WHERE status = 'active' ORDER BY created_at, id
      `).all() as Array<{ id: string }>;

      for (const owner of owners) {
        const repository = new FinanceRepository(this.db, owner.id);
        const assets = repository.listAssets().sort((left, right) =>
          left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
        for (const asset of assets) {
          const item = { ownerId: owner.id, assetId: asset.id, name: asset.name };
          const key = assetKey(owner.id, asset.id);
          seenKeys.add(key);

          if (asset.priceMode !== "provider") {
            this.retryState.delete(key);
            result.skipped.push({ ...item, reason: "PRICE_MODE_MANUAL" });
            continue;
          }
          if (this.refresher.providerId === "manual") {
            this.retryState.delete(key);
            result.skipped.push({ ...item, reason: "PRICE_PROVIDER_DISABLED" });
            continue;
          }
          if (!isAssetPriceDue(asset, now)) {
            this.retryState.delete(key);
            result.skipped.push({ ...item, reason: "PRICE_FRESH" });
            continue;
          }
          const retry = this.retryState.get(key);
          if (retry && retry.nextAttemptAt > now.getTime()) {
            result.skipped.push({ ...item, reason: "PRICE_BACKOFF" });
            continue;
          }
          candidates.push({ key, ownerId: owner.id, repository, asset });
        }
      }

      for (const key of this.retryState.keys()) {
        if (!seenKeys.has(key)) this.retryState.delete(key);
      }

      const outcomes = await Promise.all(candidates.map(async (candidate) => {
        const item = {
          ownerId: candidate.ownerId,
          assetId: candidate.asset.id,
          name: candidate.asset.name,
        };
        try {
          await this.refresher.refresh(candidate.repository, candidate.asset);
          this.retryState.delete(candidate.key);
          return { status: "updated" as const, item };
        } catch (error) {
          const errorInfo = describePriceRefreshError(error);
          if (errorInfo.code === "ASSET_CHANGED" || errorInfo.code === "ASSET_NOT_FOUND") {
            this.retryState.delete(candidate.key);
          } else {
            const previousFailures = this.retryState.get(candidate.key)?.failures ?? 0;
            const failures = Math.min(previousFailures + 1, 31);
            const delay = Math.min(
              this.retryMaxMs,
              this.retryBaseMs * (2 ** Math.min(failures - 1, 30)),
            );
            this.retryState.set(candidate.key, {
              failures,
              nextAttemptAt: now.getTime() + delay,
            });
          }
          return {
            status: "failed" as const,
            item: { ...item, error: errorInfo },
          };
        }
      }));

      for (const outcome of outcomes) {
        if (outcome.status === "updated") result.updated.push(outcome.item);
        else result.failed.push(outcome.item);
      }
      return result;
    } finally {
      this.ticking = false;
    }
  }
}
