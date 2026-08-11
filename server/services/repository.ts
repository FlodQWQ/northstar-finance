import { randomUUID } from "node:crypto";
import { Decimal } from "decimal.js";
import type {
  AppSettings,
  Asset,
  DashboardData,
  ExpectedAsset,
  MonitorRun,
  TrackedEvent,
} from "../../shared/types";
import { deploymentAIStatus } from "../providers/aiFactory";
import { DEFAULT_OWNER_ID, type SqliteDatabase } from "../db/database";
import type {
  AssetBalanceInput,
  AssetCreateInput,
  AssetPatchInput,
  EventCreateInput,
  EventPatchInput,
  ExpectedCreateInput,
  ExpectedPatchInput,
  OperationCreateInput,
} from "../validation";

type Row = Record<string, unknown>;

export class DomainError extends Error {
  public constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "DOMAIN_ERROR",
  ) {
    super(message);
  }
}

function stringValue(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function parseJsonArray<T>(value: unknown): T[] {
  try {
    const parsed = JSON.parse(stringValue(value, "[]"));
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function parseMonitorSources(value: unknown): Pick<MonitorRun, "sources" | "searchEvidence"> {
  try {
    const parsed = JSON.parse(stringValue(value, "[]")) as unknown;
    if (Array.isArray(parsed)) {
      return { sources: parsed as MonitorRun["sources"] };
    }
    if (!parsed || typeof parsed !== "object") return { sources: [] };
    const record = parsed as { sources?: unknown; searchEvidence?: unknown };
    const sources = Array.isArray(record.sources) ? record.sources as MonitorRun["sources"] : [];
    const evidence = record.searchEvidence;
    if (
      evidence
      && typeof evidence === "object"
      && (evidence as { mode?: unknown }).mode === "live"
      && typeof (evidence as { query?: unknown }).query === "string"
      && typeof (evidence as { searchedAt?: unknown }).searchedAt === "string"
      && Array.isArray((evidence as { observedUrls?: unknown }).observedUrls)
    ) {
      return {
        sources,
        searchEvidence: evidence as NonNullable<MonitorRun["searchEvidence"]>,
      };
    }
    return { sources };
  } catch {
    return { sources: [] };
  }
}

function formatDecimal(value: Decimal.Value): string {
  const decimal = new Decimal(value);
  if (decimal.isZero()) return "0";
  return decimal.toFixed(decimal.decimalPlaces());
}

function boolValue(value: unknown): boolean {
  return Number(value) === 1;
}

export type VersionedAsset = Asset & { version: number };
export type VersionedExpectedAsset = ExpectedAsset & {
  version: number;
  linkedAssetId: string | null;
};
export type VersionedTrackedEvent = TrackedEvent & { version: number };

export function mapAsset(row: Row): VersionedAsset {
  const quantity = new Decimal(stringValue(row.quantity, "0"));
  const unitCost = new Decimal(stringValue(row.unit_cost, "0"));
  const currentPrice = new Decimal(stringValue(row.current_price, "0"));
  const marketValue = quantity.mul(currentPrice);
  const costBasis = quantity.mul(unitCost);
  const pnl = marketValue.minus(costBasis);
  const pnlPercent = costBasis.isZero() ? new Decimal(0) : pnl.div(costBasis).mul(100);

  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    symbol: stringValue(row.symbol),
    kind: stringValue(row.kind) as Asset["kind"],
    account: stringValue(row.account),
    currency: stringValue(row.currency),
    quantity: formatDecimal(quantity),
    unitCost: formatDecimal(unitCost),
    currentPrice: formatDecimal(currentPrice),
    marketValue: formatDecimal(marketValue),
    costBasis: formatDecimal(costBasis),
    pnl: formatDecimal(pnl),
    pnlPercent: formatDecimal(pnlPercent),
    priceMode: stringValue(row.price_mode) as Asset["priceMode"],
    priceSource: stringValue(row.price_source),
    priceUpdatedAt: stringValue(row.price_updated_at),
    staleAfterHours: Number(row.stale_after_hours),
    notes: stringValue(row.notes),
    version: Number(row.version),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

export function mapExpectedAsset(row: Row): VersionedExpectedAsset {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    category: stringValue(row.category),
    ecosystem: stringValue(row.ecosystem),
    stage: stringValue(row.stage) as ExpectedAsset["stage"],
    health: stringValue(row.health) as ExpectedAsset["health"],
    nextAction: stringValue(row.next_action),
    deadline: row.deadline === null ? null : stringValue(row.deadline),
    estimatedLow: stringValue(row.estimated_low, "0"),
    estimatedHigh: stringValue(row.estimated_high, "0"),
    currency: stringValue(row.currency),
    investedCost: stringValue(row.invested_cost, "0"),
    confidence: stringValue(row.confidence) as ExpectedAsset["confidence"],
    sourceUrl: stringValue(row.source_url),
    keywords: parseJsonArray<string>(row.keywords_json),
    latestUpdate: stringValue(row.latest_update),
    lastCheckedAt: stringValue(row.last_checked_at),
    nextCheckAt: stringValue(row.next_check_at),
    notes: stringValue(row.notes),
    linkedAssetId: row.linked_asset_id === null ? null : stringValue(row.linked_asset_id),
    version: Number(row.version),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

export function mapTrackedEvent(row: Row): VersionedTrackedEvent {
  return {
    id: stringValue(row.id),
    name: stringValue(row.name),
    topic: stringValue(row.topic),
    instructions: stringValue(row.instructions),
    schedule: stringValue(row.schedule),
    scheduleLabel: stringValue(row.schedule_label),
    timezone: stringValue(row.timezone),
    nextRunAt: row.next_run_at === null ? null : stringValue(row.next_run_at),
    lastRunAt: row.last_run_at === null ? null : stringValue(row.last_run_at),
    status: stringValue(row.status) as TrackedEvent["status"],
    notifyOnChangeOnly: boolValue(row.notify_on_change_only),
    emailEnabled: boolValue(row.email_enabled),
    emailTo: stringValue(row.email_to),
    lastRunStatus:
      row.last_run_status === null
        ? null
        : (stringValue(row.last_run_status) as TrackedEvent["lastRunStatus"]),
    lastSummary: stringValue(row.last_summary),
    version: Number(row.version),
    createdAt: stringValue(row.created_at),
    updatedAt: stringValue(row.updated_at),
  };
}

export function mapMonitorRun(row: Row): MonitorRun {
  const sourceData = parseMonitorSources(row.sources_json);
  return {
    id: stringValue(row.id),
    eventId: stringValue(row.event_id ?? row.expected_asset_id),
    status: stringValue(row.status) as MonitorRun["status"],
    scheduledFor: stringValue(row.scheduled_for),
    startedAt: row.started_at === null ? null : stringValue(row.started_at),
    finishedAt: row.finished_at === null ? null : stringValue(row.finished_at),
    summary: stringValue(row.summary),
    changeSummary: stringValue(row.change_summary),
    ...sourceData,
    provider: stringValue(row.provider),
    emailStatus: stringValue(row.email_status) as MonitorRun["emailStatus"],
    error: stringValue(row.error),
  };
}

export class FinanceRepository {
  public constructor(
    public readonly db: SqliteDatabase,
    public readonly ownerId = DEFAULT_OWNER_ID,
  ) {}

  public listAssets(): VersionedAsset[] {
    return (this.db.prepare(`
      SELECT * FROM assets WHERE owner_id = ? ORDER BY name COLLATE NOCASE
    `).all(this.ownerId) as Row[]).map(mapAsset);
  }

  public getAsset(id: string): VersionedAsset {
    const row = this.db.prepare("SELECT * FROM assets WHERE owner_id = ? AND id = ?")
      .get(this.ownerId, id) as Row | undefined;
    if (!row) throw new DomainError("Asset not found", 404, "ASSET_NOT_FOUND");
    return mapAsset(row);
  }

  public createAsset(input: AssetCreateInput): VersionedAsset {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const priceUpdatedAt = input.priceUpdatedAt ?? now;

    const create = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO assets (
          id, owner_id, name, symbol, kind, account, currency, quantity, unit_cost,
          current_price, price_mode, price_source, price_updated_at,
          stale_after_hours, notes, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        id,
        this.ownerId,
        input.name,
        input.symbol,
        input.kind,
        input.account,
        input.currency,
        input.quantity,
        input.unitCost,
        input.currentPrice,
        input.priceMode,
        input.priceSource,
        priceUpdatedAt,
        input.staleAfterHours,
        input.notes,
        now,
        now,
      );

      if (!new Decimal(input.quantity).isZero()) {
        this.db.prepare(`
          INSERT INTO asset_operations (
            id, owner_id, asset_id, operation_type, quantity_delta, unit_price, fee,
            currency, note, occurred_at, idempotency_key, created_at
          ) VALUES (?, ?, ?, 'opening', ?, ?, '0', ?, ?, ?, ?, ?)
        `).run(
          randomUUID(),
          this.ownerId,
          id,
          input.quantity,
          input.unitCost,
          input.currency,
          "Opening balance",
          now,
          `asset-create:${id}`,
          now,
        );
      }

      if (!new Decimal(input.currentPrice).isZero()) {
        this.db.prepare(`
          INSERT INTO price_snapshots (
            id, owner_id, asset_id, price, currency, source, as_of_at, fetched_at, raw_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
        `).run(
          randomUUID(),
          this.ownerId,
          id,
          input.currentPrice,
          input.currency,
          input.priceSource,
          priceUpdatedAt,
          now,
          now,
        );
      }
    });
    create();
    return this.getAsset(id);
  }

  public updateAsset(id: string, input: AssetPatchInput): VersionedAsset {
    const current = this.getAsset(id);
    const columnMap: Record<string, string> = {
      name: "name",
      symbol: "symbol",
      kind: "kind",
      account: "account",
      currency: "currency",
      currentPrice: "current_price",
      priceMode: "price_mode",
      priceSource: "price_source",
      priceUpdatedAt: "price_updated_at",
      staleAfterHours: "stale_after_hours",
      notes: "notes",
    };
    const now = new Date().toISOString();
    const normalizedInput: AssetPatchInput =
      input.currentPrice !== undefined && input.priceUpdatedAt === undefined
        ? { ...input, priceUpdatedAt: now }
        : input;
    const entries = Object.entries(normalizedInput).filter(([key]) => key in columnMap);

    const update = this.db.transaction(() => {
      const assignments = entries.map(([key]) => `${columnMap[key]} = ?`);
      const values = entries.map(([, value]) => value);
      this.db.prepare(
        `UPDATE assets SET ${assignments.join(", ")}, version = version + 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
      ).run(...values, now, this.ownerId, id);

      if (input.currentPrice !== undefined && input.currentPrice !== current.currentPrice) {
        const asOf = normalizedInput.priceUpdatedAt ?? now;
        this.db.prepare(`
          INSERT OR IGNORE INTO price_snapshots (
            id, owner_id, asset_id, price, currency, source, as_of_at, fetched_at, raw_json, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '{}', ?)
        `).run(
          randomUUID(),
          this.ownerId,
          id,
          input.currentPrice,
          input.currency ?? current.currency,
          input.priceSource ?? current.priceSource,
          asOf,
          now,
          now,
        );
      }
    });
    update();
    return this.getAsset(id);
  }

  public calibrateAssetBalance(id: string, input: AssetBalanceInput): VersionedAsset {
    const now = new Date().toISOString();
    const occurredAt = input.asOf ?? now;

    const calibrate = this.db.transaction(() => {
      const current = this.getAsset(id);
      const delta = new Decimal(input.quantity).minus(current.quantity);
      const result = this.db.prepare(`
        UPDATE assets
        SET quantity = ?, unit_cost = COALESCE(?, unit_cost),
            version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ? AND version = ?
      `).run(
        input.quantity,
        input.unitCost ?? null,
        now,
        this.ownerId,
        id,
        input.expectedVersion,
      );

      if (result.changes === 0) {
        throw new DomainError(
          "Asset version does not match the expected version",
          409,
          "ASSET_VERSION_CONFLICT",
        );
      }

      this.db.prepare(`
        INSERT INTO asset_operations (
          id, owner_id, asset_id, operation_type, quantity_delta, unit_price, fee,
          currency, note, occurred_at, idempotency_key, created_at
        ) VALUES (?, ?, ?, 'adjustment', ?, ?, '0', ?, ?, ?, NULL, ?)
      `).run(
        randomUUID(),
        this.ownerId,
        id,
        formatDecimal(delta),
        input.unitCost ?? current.unitCost,
        current.currency,
        input.note,
        occurredAt,
        now,
      );

      return this.getAsset(id);
    });

    return calibrate();
  }

  public deleteAsset(id: string): void {
    const result = this.db.prepare("DELETE FROM assets WHERE owner_id = ? AND id = ?")
      .run(this.ownerId, id);
    if (result.changes === 0) throw new DomainError("Asset not found", 404, "ASSET_NOT_FOUND");
  }

  public listOperations(assetId: string): Row[] {
    this.getAsset(assetId);
    return (this.db.prepare(`
      SELECT id, asset_id, operation_type, quantity_delta, unit_price, fee,
             currency, note, occurred_at, idempotency_key, created_at
      FROM asset_operations
      WHERE owner_id = ? AND asset_id = ?
      ORDER BY occurred_at DESC, created_at DESC
    `).all(this.ownerId, assetId) as Row[]).map((row) => ({
      id: row.id,
      assetId: row.asset_id,
      type: row.operation_type,
      quantityDelta: row.quantity_delta,
      unitPrice: row.unit_price,
      fee: row.fee,
      currency: row.currency,
      note: row.note,
      occurredAt: row.occurred_at,
      idempotencyKey: row.idempotency_key,
      createdAt: row.created_at,
    }));
  }

  public recordOperationWithAsset(
    assetId: string,
    input: OperationCreateInput,
  ): { operation: Row; asset: VersionedAsset } {
    const write = this.db.transaction(() => {
      const asset = this.getAsset(assetId);
      if (input.idempotencyKey) {
        const existing = this.db.prepare(
          "SELECT * FROM asset_operations WHERE owner_id = ? AND asset_id = ? AND idempotency_key = ?",
        ).get(this.ownerId, assetId, input.idempotencyKey) as Row | undefined;
        if (existing) {
          return {
            operation: this.listOperations(assetId).find((item) => item.id === existing.id) ?? existing,
            asset,
          };
        }
      }

      const quantityRequired = ["opening", "buy", "sell", "transfer_in", "transfer_out", "claim"];
      if (
        quantityRequired.includes(input.type) &&
        input.quantity === undefined &&
        input.quantityDelta === undefined
      ) {
        throw new DomainError("This operation type requires a quantity", 400, "QUANTITY_REQUIRED");
      }

      let delta = new Decimal(input.quantityDelta ?? input.quantity ?? "0");
      if (input.quantityDelta === undefined && ["sell", "transfer_out"].includes(input.type)) {
        delta = delta.negated();
      }
      if (["dividend", "interest", "fee"].includes(input.type)) delta = new Decimal(0);

      const currentQuantity = new Decimal(asset.quantity);
      const nextQuantity = currentQuantity.plus(delta);
      if (currentQuantity.gte(0) && nextQuantity.isNegative()) {
        throw new DomainError("Operation would make the holding quantity negative", 409, "NEGATIVE_QUANTITY");
      }

      let nextUnitCost = new Decimal(asset.unitCost);
      if (delta.isPositive() && ["opening", "buy", "transfer_in", "claim"].includes(input.type)) {
        const existingCost = currentQuantity.mul(asset.unitCost);
        const addedCost = delta.mul(input.unitPrice).plus(input.fee);
        nextUnitCost = nextQuantity.isZero() ? new Decimal(0) : existingCost.plus(addedCost).div(nextQuantity);
      } else if (nextQuantity.isZero()) {
        nextUnitCost = new Decimal(0);
      }

      const id = input.id ?? randomUUID();
      const now = new Date().toISOString();
      const occurredAt = input.occurredAt ?? now;
      const operationCurrency = input.currency ?? asset.currency;

      this.db.prepare(`
        INSERT INTO asset_operations (
          id, owner_id, asset_id, operation_type, quantity_delta, unit_price, fee,
          currency, note, occurred_at, idempotency_key, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        this.ownerId,
        assetId,
        input.type,
        formatDecimal(delta),
        input.unitPrice,
        input.fee,
        operationCurrency,
        input.note,
        occurredAt,
        input.idempotencyKey ?? null,
        now,
      );
      this.db.prepare(`
        UPDATE assets
        SET quantity = ?, unit_cost = ?, version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(formatDecimal(nextQuantity), formatDecimal(nextUnitCost), now, this.ownerId, assetId);

      return {
        operation: this.listOperations(assetId).find((item) => item.id === id) as Row,
        asset: this.getAsset(assetId),
      };
    });
    return write();
  }

  public recordOperation(assetId: string, input: OperationCreateInput): Row {
    return this.recordOperationWithAsset(assetId, input).operation;
  }

  public updatePrice(
    assetId: string,
    quote: { price: string; currency: string; source: string; asOf: string; raw?: unknown },
  ): VersionedAsset {
    this.getAsset(assetId);
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      this.db.prepare(`
        INSERT OR IGNORE INTO price_snapshots (
          id, owner_id, asset_id, price, currency, source, as_of_at, fetched_at, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        this.ownerId,
        assetId,
        quote.price,
        quote.currency,
        quote.source,
        quote.asOf,
        now,
        JSON.stringify(quote.raw ?? {}),
        now,
      );
      this.db.prepare(`
        UPDATE assets
        SET current_price = ?, currency = ?, price_source = ?, price_updated_at = ?,
            version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(quote.price, quote.currency, quote.source, quote.asOf, now, this.ownerId, assetId);
    });
    write();
    return this.getAsset(assetId);
  }

  public updateProviderPrice(
    assetId: string,
    expectedVersion: number,
    quote: { price: string; currency: string; source: string; asOf: string; raw?: unknown },
  ): VersionedAsset {
    const now = new Date().toISOString();
    const write = this.db.transaction(() => {
      const result = this.db.prepare(`
        UPDATE assets
        SET current_price = ?, currency = ?, price_source = ?, price_updated_at = ?,
            version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ? AND version = ? AND price_mode = 'provider'
      `).run(
        quote.price,
        quote.currency,
        quote.source,
        quote.asOf,
        now,
        this.ownerId,
        assetId,
        expectedVersion,
      );
      if (result.changes !== 1) {
        const exists = this.db.prepare("SELECT 1 FROM assets WHERE owner_id = ? AND id = ?")
          .get(this.ownerId, assetId);
        if (!exists) throw new DomainError("Asset not found", 404, "ASSET_NOT_FOUND");
        throw new DomainError(
          "Asset changed while its market price was being fetched",
          409,
          "ASSET_CHANGED",
        );
      }

      this.db.prepare(`
        INSERT OR IGNORE INTO price_snapshots (
          id, owner_id, asset_id, price, currency, source, as_of_at, fetched_at, raw_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        randomUUID(),
        this.ownerId,
        assetId,
        quote.price,
        quote.currency,
        quote.source,
        quote.asOf,
        now,
        JSON.stringify(quote.raw ?? {}),
        now,
      );
    });
    write();
    return this.getAsset(assetId);
  }

  public listPrices(assetId: string): Row[] {
    this.getAsset(assetId);
    return (this.db.prepare(`
      SELECT id, price, currency, source, as_of_at, fetched_at
      FROM price_snapshots WHERE owner_id = ? AND asset_id = ? ORDER BY as_of_at DESC LIMIT 500
    `).all(this.ownerId, assetId) as Row[]).map((row) => ({
      id: row.id,
      assetId,
      price: row.price,
      currency: row.currency,
      source: row.source,
      asOf: row.as_of_at,
      fetchedAt: row.fetched_at,
    }));
  }

  public listExpectedAssets(): VersionedExpectedAsset[] {
    return (this.db.prepare(`
      SELECT * FROM expected_assets
      WHERE owner_id = ?
      ORDER BY next_check_at, name COLLATE NOCASE
    `).all(this.ownerId) as Row[]).map(mapExpectedAsset);
  }

  public getExpectedAsset(id: string): VersionedExpectedAsset {
    const row = this.db.prepare("SELECT * FROM expected_assets WHERE owner_id = ? AND id = ?")
      .get(this.ownerId, id) as Row | undefined;
    if (!row) throw new DomainError("Expected asset not found", 404, "EXPECTED_ASSET_NOT_FOUND");
    return mapExpectedAsset(row);
  }

  public createExpectedAsset(input: ExpectedCreateInput): VersionedExpectedAsset {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    const lastCheckedAt = input.lastCheckedAt ?? now;
    const nextCheckAt = input.nextCheckAt ?? new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    this.db.prepare(`
      INSERT INTO expected_assets (
        id, owner_id, name, category, ecosystem, stage, health, next_action, deadline,
        estimated_low, estimated_high, currency, invested_cost, confidence,
        source_url, keywords_json, latest_update, last_checked_at, next_check_at,
        notes, linked_asset_id, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?)
    `).run(
      id,
      this.ownerId,
      input.name,
      input.category,
      input.ecosystem,
      input.stage,
      input.health,
      input.nextAction,
      input.deadline,
      input.estimatedLow,
      input.estimatedHigh,
      input.currency,
      input.investedCost,
      input.confidence,
      input.sourceUrl,
      JSON.stringify(input.keywords),
      input.latestUpdate,
      lastCheckedAt,
      nextCheckAt,
      input.notes,
      now,
      now,
    );
    return this.getExpectedAsset(id);
  }

  public updateExpectedAsset(id: string, input: ExpectedPatchInput): VersionedExpectedAsset {
    const current = this.getExpectedAsset(id);
    const combinedLow = input.estimatedLow ?? current.estimatedLow;
    const combinedHigh = input.estimatedHigh ?? current.estimatedHigh;
    if (new Decimal(combinedHigh).lt(combinedLow)) {
      throw new DomainError("estimatedHigh must be greater than or equal to estimatedLow");
    }
    const columnMap: Record<string, string> = {
      name: "name",
      category: "category",
      ecosystem: "ecosystem",
      stage: "stage",
      health: "health",
      nextAction: "next_action",
      deadline: "deadline",
      estimatedLow: "estimated_low",
      estimatedHigh: "estimated_high",
      currency: "currency",
      investedCost: "invested_cost",
      confidence: "confidence",
      sourceUrl: "source_url",
      keywords: "keywords_json",
      latestUpdate: "latest_update",
      lastCheckedAt: "last_checked_at",
      nextCheckAt: "next_check_at",
      notes: "notes",
    };
    const entries = Object.entries(input).filter(([key]) => key in columnMap);
    const assignments = entries.map(([key]) => `${columnMap[key]} = ?`);
    const values = entries.map(([key, value]) => (key === "keywords" ? JSON.stringify(value) : value));
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE expected_assets SET ${assignments.join(", ")}, version = version + 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
    ).run(...values, now, this.ownerId, id);
    return this.getExpectedAsset(id);
  }

  public deleteExpectedAsset(id: string): void {
    const result = this.db.prepare("DELETE FROM expected_assets WHERE owner_id = ? AND id = ?")
      .run(this.ownerId, id);
    if (result.changes === 0) {
      throw new DomainError("Expected asset not found", 404, "EXPECTED_ASSET_NOT_FOUND");
    }
  }

  public listExpectedUpdates(id: string): Row[] {
    this.getExpectedAsset(id);
    return (this.db.prepare(`
      SELECT * FROM asset_updates
      WHERE owner_id = ? AND expected_asset_id = ?
      ORDER BY created_at DESC
    `).all(this.ownerId, id) as Row[]).map((row) => ({
      id: row.id,
      expectedAssetId: row.expected_asset_id,
      type: row.update_type,
      title: row.title,
      summary: row.summary,
      sourceUrl: row.source_url,
      provider: row.provider,
      publishedAt: row.published_at,
      createdAt: row.created_at,
    }));
  }

  public listExpectedRuns(expectedAssetId: string): MonitorRun[] {
    this.getExpectedAsset(expectedAssetId);
    return (this.db.prepare(`
      SELECT * FROM monitor_runs
      WHERE owner_id = ? AND expected_asset_id = ?
      ORDER BY scheduled_for DESC LIMIT 200
    `).all(this.ownerId, expectedAssetId) as Row[]).map(mapMonitorRun);
  }

  public listEvents(): VersionedTrackedEvent[] {
    return (this.db.prepare(`
      SELECT * FROM tracked_events
      WHERE owner_id = ?
      ORDER BY CASE WHEN next_run_at IS NULL THEN 1 ELSE 0 END, next_run_at, name COLLATE NOCASE
    `).all(this.ownerId) as Row[]).map(mapTrackedEvent);
  }

  public getEvent(id: string): VersionedTrackedEvent {
    const row = this.db.prepare("SELECT * FROM tracked_events WHERE owner_id = ? AND id = ?")
      .get(this.ownerId, id) as Row | undefined;
    if (!row) throw new DomainError("Tracked event not found", 404, "EVENT_NOT_FOUND");
    return mapTrackedEvent(row);
  }

  public createEvent(input: EventCreateInput, calculatedNextRunAt: string | null): VersionedTrackedEvent {
    const id = input.id ?? randomUUID();
    const now = new Date().toISOString();
    this.db.prepare(`
      INSERT INTO tracked_events (
        id, owner_id, name, topic, instructions, schedule, schedule_label, timezone,
        next_run_at, last_run_at, status, notify_on_change_only, email_enabled,
        email_to, last_run_status, last_summary, version, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, NULL, '', 1, ?, ?)
    `).run(
      id,
      this.ownerId,
      input.name,
      input.topic,
      input.instructions,
      input.schedule,
      input.scheduleLabel,
      input.timezone,
      input.nextRunAt ?? calculatedNextRunAt,
      input.status,
      input.notifyOnChangeOnly ? 1 : 0,
      input.emailEnabled ? 1 : 0,
      input.emailTo,
      now,
      now,
    );
    return this.getEvent(id);
  }

  public updateEvent(
    id: string,
    input: EventPatchInput,
    calculatedNextRunAt?: string | null,
  ): VersionedTrackedEvent {
    const current = this.getEvent(id);
    const emailEnabled = input.emailEnabled ?? current.emailEnabled;
    const emailTo = input.emailTo ?? current.emailTo;
    if (emailEnabled && !emailTo) {
      throw new DomainError(
        "An email recipient is required when event email is enabled",
        400,
        "EMAIL_RECIPIENT_REQUIRED",
      );
    }
    const columnMap: Record<string, string> = {
      name: "name",
      topic: "topic",
      instructions: "instructions",
      schedule: "schedule",
      scheduleLabel: "schedule_label",
      timezone: "timezone",
      nextRunAt: "next_run_at",
      status: "status",
      notifyOnChangeOnly: "notify_on_change_only",
      emailEnabled: "email_enabled",
      emailTo: "email_to",
    };
    const normalized: Record<string, unknown> = { ...input };
    if (calculatedNextRunAt !== undefined && input.nextRunAt === undefined) {
      normalized.nextRunAt = calculatedNextRunAt;
    }
    const entries = Object.entries(normalized).filter(([key]) => key in columnMap);
    const assignments = entries.map(([key]) => `${columnMap[key]} = ?`);
    const values = entries.map(([key, value]) =>
      key === "notifyOnChangeOnly" || key === "emailEnabled" ? (value ? 1 : 0) : value,
    );
    const now = new Date().toISOString();
    this.db.prepare(
      `UPDATE tracked_events SET ${assignments.join(", ")}, version = version + 1, updated_at = ? WHERE owner_id = ? AND id = ?`,
    ).run(...values, now, this.ownerId, id);
    return this.getEvent(id);
  }

  public deleteEvent(id: string): void {
    const result = this.db.prepare("DELETE FROM tracked_events WHERE owner_id = ? AND id = ?")
      .run(this.ownerId, id);
    if (result.changes === 0) throw new DomainError("Tracked event not found", 404, "EVENT_NOT_FOUND");
  }

  public listEventRuns(eventId: string): MonitorRun[] {
    this.getEvent(eventId);
    return (this.db.prepare(`
      SELECT * FROM monitor_runs
      WHERE owner_id = ? AND event_id = ?
      ORDER BY scheduled_for DESC LIMIT 200
    `).all(this.ownerId, eventId) as Row[]).map(mapMonitorRun);
  }

  public getRun(id: string): MonitorRun {
    const row = this.db.prepare("SELECT * FROM monitor_runs WHERE owner_id = ? AND id = ?")
      .get(this.ownerId, id) as Row | undefined;
    if (!row) throw new DomainError("Monitor run not found", 404, "RUN_NOT_FOUND");
    return mapMonitorRun(row);
  }

  public getSettings(): AppSettings {
    const rows = this.db.prepare("SELECT key, value FROM settings WHERE owner_id = ?")
      .all(this.ownerId) as Array<{ key: string; value: string }>;
    const values = Object.fromEntries(rows.map((row) => [row.key, row.value]));
    const deploymentAI = deploymentAIStatus();
    const notificationEmail = values.notificationEmail ?? "";
    return {
      baseCurrency: values.baseCurrency ?? "USD",
      timezone: values.timezone ?? "Asia/Shanghai",
      locale: values.locale ?? "zh-CN",
      proxyUrl: values.proxyUrl ?? "",
      aiProvider: deploymentAI.provider,
      aiBaseUrl: process.env.OPENAI_BASE_URL?.trim() ?? "",
      aiModel: process.env.CODEX_MODEL?.trim()
        || process.env.OPENCODE_MODEL?.trim()
        || process.env.OPENAI_MODEL?.trim()
        || "",
      aiConfigured: deploymentAI.configured,
      smtpHost: values.smtpHost ?? "",
      smtpPort: Number(values.smtpPort ?? 587),
      smtpSecure: values.smtpSecure === "true",
      smtpFrom: values.smtpFrom ?? "",
      notificationEmail,
      smtpConfigured: Boolean(
        process.env.SMTP_HOST?.trim() && process.env.SMTP_FROM?.trim(),
      ),
    };
  }

  public updateSettings(input: Partial<AppSettings>): AppSettings {
    const derivedKeys = new Set(["aiConfigured", "smtpConfigured"]);
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO settings (owner_id, key, value, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(owner_id, key)
      DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
    `);
    const update = this.db.transaction(() => {
      for (const [key, rawValue] of Object.entries(input)) {
        if (derivedKeys.has(key) || rawValue === undefined) continue;
        statement.run(this.ownerId, key, String(rawValue), now);
      }
    });
    update();
    return this.getSettings();
  }

  public getDashboard(): DashboardData {
    const assets = this.listAssets();
    const expected = this.listExpectedAssets();
    const events = this.listEvents();
    const baseCurrency = this.getSettings().baseCurrency;
    const baseAssets = assets.filter((asset) => asset.currency === baseCurrency);
    const activeExpected = expected.filter(
      (asset) => !["claimed", "missed", "expired", "rejected"].includes(asset.stage),
    );
    const baseExpected = activeExpected.filter((asset) => asset.currency === baseCurrency);
    const netWorth = baseAssets.reduce((sum, asset) => sum.plus(asset.marketValue), new Decimal(0));
    const costBasis = baseAssets.reduce((sum, asset) => sum.plus(asset.costBasis), new Decimal(0));
    const expectedLow = baseExpected
      .reduce((sum, asset) => sum.plus(asset.estimatedLow), new Decimal(0));
    const expectedHigh = baseExpected
      .reduce((sum, asset) => sum.plus(asset.estimatedHigh), new Decimal(0));
    const now = Date.now();
    const nextWeek = now + 7 * 24 * 60 * 60 * 1000;
    const staleAssetCount = assets.filter((asset) => {
      const updated = Date.parse(asset.priceUpdatedAt);
      return !Number.isFinite(updated) || now - updated > asset.staleAfterHours * 60 * 60 * 1000;
    }).length;
    const dueExpectedCount = expected.filter(
      (asset) => asset.health === "due" || asset.health === "failed" || Date.parse(asset.nextCheckAt) <= now,
    ).length;
    const upcomingEvents = events.filter((event) => {
      if (event.status !== "active" || event.nextRunAt === null) return false;
      const next = Date.parse(event.nextRunAt);
      return next >= now && next <= nextWeek;
    });

    const allocationMap = new Map<string, Decimal>();
    for (const asset of baseAssets) {
      allocationMap.set(asset.kind, (allocationMap.get(asset.kind) ?? new Decimal(0)).plus(asset.marketValue));
    }
    const colors: Record<string, string> = {
      crypto: "#2563eb",
      stock: "#16a34a",
      fund: "#7c3aed",
      wealth: "#ca8a04",
      cash: "#0891b2",
      other: "#64748b",
    };
    const allocation = [...allocationMap.entries()].map(([name, value]) => ({
      name,
      value: value.toNumber(),
      color: colors[name] ?? colors.other,
    }));

    const trend: Array<{ date: string; value: number }> = [];
    const trendStatement = this.db.prepare(`
      SELECT a.quantity,
             COALESCE((
               SELECT p.price FROM price_snapshots p
               WHERE p.owner_id = a.owner_id AND p.asset_id = a.id AND p.as_of_at <= ?
               ORDER BY p.as_of_at DESC LIMIT 1
             ), a.current_price) AS price
      FROM assets a
      WHERE a.owner_id = ? AND a.currency = ?
    `);
    for (let daysAgo = 6; daysAgo >= 0; daysAgo -= 1) {
      const day = new Date(now - daysAgo * 24 * 60 * 60 * 1000);
      const end = new Date(day);
      end.setUTCHours(23, 59, 59, 999);
      const value = (trendStatement.all(end.toISOString(), this.ownerId, baseCurrency) as Row[]).reduce(
        (sum, row) => sum.plus(new Decimal(stringValue(row.quantity, "0")).mul(stringValue(row.price, "0"))),
        new Decimal(0),
      );
      trend.push({ date: day.toISOString().slice(0, 10), value: value.toNumber() });
    }

    const recentOperations = this.db.prepare(`
      SELECT o.id, o.asset_id AS assetId, a.name AS assetName, a.symbol AS assetSymbol,
             o.operation_type AS type, o.quantity_delta AS quantityDelta,
             o.unit_price AS unitPrice, o.fee, o.currency, o.note,
             o.occurred_at AS occurredAt
      FROM asset_operations o
      JOIN assets a ON a.owner_id = o.owner_id AND a.id = o.asset_id
      WHERE o.owner_id = ?
      ORDER BY o.occurred_at DESC LIMIT 10
    `).all(this.ownerId) as Array<Record<string, unknown>>;

    return {
      baseCurrency,
      netWorth: formatDecimal(netWorth),
      costBasis: formatDecimal(costBasis),
      totalPnl: formatDecimal(netWorth.minus(costBasis)),
      expectedLow: formatDecimal(expectedLow),
      expectedHigh: formatDecimal(expectedHigh),
      staleAssetCount,
      dueExpectedCount,
      upcomingEventCount: upcomingEvents.length,
      unconvertedAssetCount: assets.length - baseAssets.length,
      unconvertedExpectedCount: activeExpected.length - baseExpected.length,
      allocation,
      trend,
      recentOperations,
      upcomingEvents,
    };
  }
}
