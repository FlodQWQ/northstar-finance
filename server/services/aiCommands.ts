import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Decimal } from "decimal.js";
import { z } from "zod";
import type { SqliteDatabase } from "../db/database";
import {
  assetCreateSchema,
  entityId,
  eventCreateSchema,
  eventPatchSchema,
  expectedCreateSchema,
  expectedPatchSchema,
  operationCreateSchema,
  priceUpdateSchema,
} from "../validation";
import { calculateNextRunAt } from "./scheduler";
import { DomainError, FinanceRepository } from "./repository";

const commandBase = {
  commandId: z.string().trim().min(1).max(120).optional(),
  confirmed: z.boolean().default(false),
};

const assetCreateCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("asset.create"),
    payload: assetCreateSchema,
  })
  .strict();

const assetPriceCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("asset.price.update"),
    payload: priceUpdateSchema
      .extend({ assetId: entityId, price: priceUpdateSchema.shape.price.unwrap() })
      .strict(),
  })
  .strict();

const assetOperationCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("asset.operation.record"),
    payload: operationCreateSchema.extend({ assetId: entityId }).strict(),
  })
  .strict();

const expectedUpdateCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("expected.update"),
    payload: z.object({ id: entityId, changes: expectedPatchSchema }).strict(),
  })
  .strict();

const expectedCreateCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("expected.create"),
    payload: expectedCreateSchema,
  })
  .strict();

const eventCreateCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("event.create"),
    payload: eventCreateSchema,
  })
  .strict();

const eventUpdateCommandSchema = z
  .object({
    ...commandBase,
    type: z.literal("event.update"),
    payload: z.object({ id: entityId, changes: eventPatchSchema }).strict(),
  })
  .strict();

export const aiCommandSchema = z.discriminatedUnion("type", [
  assetCreateCommandSchema,
  assetPriceCommandSchema,
  assetOperationCommandSchema,
  expectedCreateCommandSchema,
  expectedUpdateCommandSchema,
  eventCreateCommandSchema,
  eventUpdateCommandSchema,
]);

export const aiCommandBatchSchema = z
  .object({
    idempotencyKey: z.string().trim().min(1).max(200),
    actor: z.string().trim().min(1).max(120),
    dryRun: z.boolean().default(false),
    expectedVersions: z.record(z.string().min(1).max(260), z.number().int().min(1)).default({}),
    commands: z.array(aiCommandSchema).min(1).max(50),
  })
  .strict();

export type AICommandBatchInput = z.infer<typeof aiCommandBatchSchema>;

export interface AICommandResult {
  index: number;
  commandId: string;
  type: z.infer<typeof aiCommandSchema>["type"];
  status: "applied" | "proposal" | "dry_run" | "failed";
  targetId: string | null;
  result: unknown;
}

export interface AICommandBatchResult {
  batchId: string;
  idempotencyKey: string;
  actor: string;
  dryRun: boolean;
  status: "success" | "failed";
  replayed: boolean;
  results: AICommandResult[];
  error?: string;
  errorCode?: string;
}

function getExpectedVersion(
  versions: Record<string, number>,
  entityType: "asset" | "expected" | "event",
  id: string,
): number | undefined {
  return versions[`${entityType}:${id}`];
}

function assertVersion(
  versions: Record<string, number>,
  entityType: "asset" | "expected" | "event",
  id: string,
  actual: number,
): void {
  const expected = getExpectedVersion(versions, entityType, id);
  if (expected === undefined) {
    throw new DomainError(
      `Expected version is required for ${entityType}:${id}`,
      428,
      "EXPECTED_VERSION_REQUIRED",
    );
  }
  if (expected !== actual) {
    throw new DomainError(
      `Version conflict for ${entityType}:${id}; expected ${expected}, found ${actual}`,
      409,
      "VERSION_CONFLICT",
    );
  }
}

function requiresConfirmation(command: z.infer<typeof aiCommandSchema>): boolean {
  if (command.type === "asset.operation.record") return !command.confirmed;
  if (command.type === "asset.create") {
    return new Decimal(command.payload.quantity).gt(0) && !command.confirmed;
  }
  if (command.type === "expected.update") {
    return command.payload.changes.stage !== undefined && !command.confirmed;
  }
  if (command.type === "event.create") {
    return (command.payload.status === "active" || command.payload.emailEnabled) && !command.confirmed;
  }
  if (command.type === "event.update") {
    const changes = command.payload.changes;
    const canTriggerExternalWork =
      changes.status === "active" ||
      changes.schedule !== undefined ||
      changes.timezone !== undefined ||
      changes.topic !== undefined ||
      changes.instructions !== undefined ||
      changes.nextRunAt !== undefined ||
      changes.emailEnabled === true ||
      changes.emailTo !== undefined;
    return canTriggerExternalWork && !command.confirmed;
  }
  return false;
}

export function getAICommandCapabilities(endpoint = "/api/ai/commands/execute") {
  return {
    endpoint,
    atomic: true,
    idempotent: true,
    proposalBatchesAreAtomic: true,
    maxCommandsPerBatch: 50,
    expectedVersionKeys: ["asset:<id>", "expected:<id>", "event:<id>"],
    expectedVersionsRequiredForUpdates: true,
    scopesEnforced: false,
    actorIsCallerSupplied: true,
    requestJsonSchema: z.toJSONSchema(aiCommandBatchSchema),
    commands: [
      {
        type: "asset.create",
        scope: "assets:write",
        confirmation: "Required when quantity is non-zero",
        payload: "Asset create fields from shared Asset, with decimal values encoded as strings",
      },
      {
        type: "asset.price.update",
        scope: "prices:write",
        confirmation: "Not required",
        payload: "{ assetId, price, currency?, source?, asOf? }",
      },
      {
        type: "asset.operation.record",
        scope: "operations:write",
        confirmation: "Always required; otherwise returned as a proposal",
        payload: "{ assetId, type, quantity?|quantityDelta?, unitPrice?, fee?, currency?, note?, occurredAt? }",
      },
      {
        type: "expected.create",
        scope: "expected:write",
        confirmation: "Not required",
        payload: "Expected asset create fields",
      },
      {
        type: "expected.update",
        scope: "expected:write",
        confirmation: "Required when changing lifecycle stage",
        payload: "{ id, changes }",
      },
      {
        type: "event.create",
        scope: "events:write",
        confirmation: "Required when the event is active or email is enabled",
        payload: "Tracked event create fields",
      },
      {
        type: "event.update",
        scope: "events:write",
        confirmation: "Required for changes that can trigger external research or email",
        payload: "{ id, changes }",
      },
    ],
    restrictions: [
      "No arbitrary SQL",
      "No arbitrary network fetch command",
      "No secret-management command",
      "Research providers cannot directly change holdings or expected-asset stages",
      "If any command needs confirmation, the entire batch is returned as a proposal",
      "confirmed is a caller-attested safety interlock, not proof of an independent human approval",
    ],
  };
}

const previewRollback = Symbol("preview-rollback");

export class AICommandService {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly repository: FinanceRepository,
  ) {}

  private replayExisting(input: AICommandBatchInput): AICommandBatchResult | undefined {
    const existing = this.db.prepare(`
      SELECT status, request_json, result_json
      FROM ai_command_batches WHERE owner_id = ? AND idempotency_key = ?
    `).get(this.repository.ownerId, input.idempotencyKey) as {
      status: "running" | "success" | "failed";
      request_json: string;
      result_json: string;
    } | undefined;
    if (!existing) return undefined;

    const originalInput = aiCommandBatchSchema.parse(JSON.parse(existing.request_json));
    if (!isDeepStrictEqual(originalInput, input)) {
      throw new DomainError(
        "Idempotency key was already used with a different request",
        409,
        "IDEMPOTENCY_KEY_REUSED",
      );
    }
    if (existing.status === "running") {
      throw new DomainError(
        "A command batch with this idempotency key is still running",
        409,
        "COMMAND_BATCH_IN_PROGRESS",
      );
    }
    const parsed = JSON.parse(existing.result_json) as AICommandBatchResult;
    return { ...parsed, replayed: true };
  }

  public execute(rawInput: unknown): AICommandBatchResult {
    const input = aiCommandBatchSchema.parse(rawInput);
    const replayed = this.replayExisting(input);
    if (replayed) return replayed;

    const batchId = randomUUID();
    const now = new Date().toISOString();
    const results: AICommandResult[] = [];
    const proposalOnly = !input.dryRun && input.commands.some(requiresConfirmation);
    const previewOnly = input.dryRun || proposalOnly;
    const checkedVersions = new Set<string>();
    const checkVersion = (
      entityType: "asset" | "expected" | "event",
      id: string,
      actual: number,
    ) => {
      const key = `${entityType}:${id}`;
      if (checkedVersions.has(key)) return;
      assertVersion(input.expectedVersions, entityType, id, actual);
      checkedVersions.add(key);
    };

    const executeBatch = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO ai_command_batches (
          id, owner_id, idempotency_key, actor, dry_run, status, request_json,
          result_json, created_at, finished_at
        ) VALUES (?, ?, ?, ?, ?, 'running', ?, '{}', ?, NULL)
      `).run(
        batchId,
        this.repository.ownerId,
        input.idempotencyKey,
        input.actor,
        input.dryRun ? 1 : 0,
        JSON.stringify(input),
        now,
      );

      const runCommands = () => input.commands.forEach((command, index) => {
        const commandId = command.commandId ?? `${batchId}:${index}`;
        const status: AICommandResult["status"] = input.dryRun
          ? "dry_run"
          : proposalOnly
            ? "proposal"
            : "applied";
        let targetId: string | null = null;
        let result: unknown;

        switch (command.type) {
          case "asset.create": {
            const asset = this.repository.createAsset(command.payload);
            targetId = asset.id;
            result = previewOnly ? { valid: true, wouldCreate: asset } : asset;
            break;
          }
          case "asset.price.update": {
            const asset = this.repository.getAsset(command.payload.assetId);
            targetId = asset.id;
            checkVersion("asset", asset.id, asset.version);
            const updated = this.repository.updatePrice(asset.id, {
              price: command.payload.price,
              currency: command.payload.currency ?? asset.currency,
              source: command.payload.source ?? "ai-command",
              asOf: command.payload.asOf ?? new Date().toISOString(),
              raw: { actor: input.actor, commandId },
            });
            result = previewOnly
              ? { valid: true, before: asset.currentPrice, after: updated }
              : updated;
            break;
          }
          case "asset.operation.record": {
            const asset = this.repository.getAsset(command.payload.assetId);
            targetId = asset.id;
            checkVersion("asset", asset.id, asset.version);
            const { assetId: _assetId, ...operation } = command.payload;
            const recorded = this.repository.recordOperation(asset.id, operation);
            result = previewOnly
              ? {
                  valid: true,
                  wouldRecord: recorded,
                  resultingAsset: this.repository.getAsset(asset.id),
                }
              : recorded;
            break;
          }
          case "expected.create": {
            const expected = this.repository.createExpectedAsset(command.payload);
            targetId = expected.id;
            result = previewOnly ? { valid: true, wouldCreate: expected } : expected;
            break;
          }
          case "expected.update": {
            const expected = this.repository.getExpectedAsset(command.payload.id);
            targetId = expected.id;
            checkVersion("expected", expected.id, expected.version);
            const updated = this.repository.updateExpectedAsset(expected.id, command.payload.changes);
            result = previewOnly ? { valid: true, before: expected, after: updated } : updated;
            break;
          }
          case "event.create": {
            const nextRunAt = calculateNextRunAt(
              command.payload.schedule,
              command.payload.timezone,
              new Date(),
            );
            const event = this.repository.createEvent(command.payload, nextRunAt);
            targetId = event.id;
            result = previewOnly ? { valid: true, nextRunAt, wouldCreate: event } : event;
            break;
          }
          case "event.update": {
            const event = this.repository.getEvent(command.payload.id);
            targetId = event.id;
            checkVersion("event", event.id, event.version);
            let nextRunAt: string | null | undefined;
            if (
              command.payload.changes.schedule ||
              command.payload.changes.timezone ||
              (command.payload.changes.status === "active" && event.status !== "active")
            ) {
              nextRunAt = calculateNextRunAt(
                command.payload.changes.schedule ?? event.schedule,
                command.payload.changes.timezone ?? event.timezone,
                new Date(),
              );
            }
            const updated = this.repository.updateEvent(event.id, command.payload.changes, nextRunAt);
            result = previewOnly
              ? { valid: true, before: event, after: updated, nextRunAt }
              : updated;
            break;
          }
        }

        const commandResult: AICommandResult = {
          index,
          commandId,
          type: command.type,
          status,
          targetId,
          result,
        };
        results.push(commandResult);
      });

      if (previewOnly) {
        try {
          this.db.transaction(() => {
            runCommands();
            throw previewRollback;
          })();
        } catch (error) {
          if (error !== previewRollback) throw error;
        }
      } else {
        runCommands();
      }

      results.forEach((commandResult, index) => {
        this.db.prepare(`
          INSERT INTO ai_command_audit (
            id, owner_id, batch_id, command_index, command_type, target_id, status,
            input_json, result_json, error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)
        `).run(
          randomUUID(),
          this.repository.ownerId,
          batchId,
          index,
          commandResult.type,
          commandResult.targetId,
          commandResult.status,
          JSON.stringify(input.commands[index]),
          JSON.stringify(commandResult.result),
          new Date().toISOString(),
        );
      });

      const response: AICommandBatchResult = {
        batchId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        dryRun: input.dryRun,
        status: "success",
        replayed: false,
        results,
      };
      this.db.prepare(`
        UPDATE ai_command_batches
        SET status = 'success', result_json = ?, finished_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(
        JSON.stringify(response),
        new Date().toISOString(),
        this.repository.ownerId,
        batchId,
      );
      return response;
    });

    try {
      return executeBatch();
    } catch (error) {
      if (/UNIQUE constraint failed: ai_command_batches\.(?:owner_id, ai_command_batches\.)?idempotency_key/i.test(
        error instanceof Error ? error.message : "",
      )) {
        const concurrentReplay = this.replayExisting(input);
        if (concurrentReplay) return concurrentReplay;
      }
      const message = error instanceof Error ? error.message : "AI command batch failed";
      const errorCode = error instanceof DomainError ? error.code : "COMMAND_BATCH_FAILED";
      const failedResults: AICommandResult[] = input.commands.map((command, index) => {
        const payload = command.payload as Record<string, unknown>;
        const targetId =
          typeof payload.assetId === "string"
            ? payload.assetId
            : typeof payload.id === "string"
              ? payload.id
              : null;
        return {
          index,
          commandId: command.commandId ?? `${batchId}:${index}`,
          type: command.type,
          status: "failed",
          targetId,
          result: { rolledBack: true, error: { code: errorCode, message } },
        };
      });
      const failed: AICommandBatchResult = {
        batchId,
        idempotencyKey: input.idempotencyKey,
        actor: input.actor,
        dryRun: input.dryRun,
        status: "failed",
        replayed: false,
        results: failedResults,
        error: message,
        errorCode,
      };
      const persistFailure = this.db.transaction(() => {
        this.db.prepare(`
          INSERT OR IGNORE INTO ai_command_batches (
            id, owner_id, idempotency_key, actor, dry_run, status, request_json,
            result_json, created_at, finished_at
          ) VALUES (?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
        `).run(
          batchId,
          this.repository.ownerId,
          input.idempotencyKey,
          input.actor,
          input.dryRun ? 1 : 0,
          JSON.stringify(input),
          JSON.stringify(failed),
          now,
          new Date().toISOString(),
        );
        const insertAudit = this.db.prepare(`
          INSERT OR IGNORE INTO ai_command_audit (
            id, owner_id, batch_id, command_index, command_type, target_id, status,
            input_json, result_json, error, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'failed', ?, ?, ?, ?)
        `);
        failedResults.forEach((result, index) => {
          insertAudit.run(
            randomUUID(),
            this.repository.ownerId,
            batchId,
            index,
            result.type,
            result.targetId,
            JSON.stringify(input.commands[index]),
            JSON.stringify(result.result),
            message.slice(0, 4_000),
            new Date().toISOString(),
          );
        });
      });
      persistFailure();
      return failed;
    }
  }
}
