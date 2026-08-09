import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type FinanceApp } from "../server/app";

let app: FinanceApp;

beforeEach(() => {
  app = createApp({ databasePath: ":memory:", seed: false, serveStatic: false });
});

afterEach(() => {
  app.finance.close();
});

async function createAsset(id = "asset-ai") {
  await request(app)
    .post("/api/assets")
    .send({
      id,
      name: "AI test asset",
      symbol: "AIT",
      kind: "crypto",
      account: "Test wallet",
      currency: "USD",
      quantity: "1",
      unitCost: "10",
      currentPrice: "10",
      priceMode: "manual",
      priceSource: "test",
    })
    .expect(201);
}

describe("AI atomic command API", () => {
  it("turns the entire batch into a proposal when one command needs confirmation", async () => {
    await createAsset();

    const response = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        idempotencyKey: "proposal-batch-1",
        actor: "test-agent",
        expectedVersions: { "asset:asset-ai": 1 },
        commands: [
          {
            type: "asset.price.update",
            payload: { assetId: "asset-ai", price: "15", source: "ai-test" },
          },
          {
            type: "asset.operation.record",
            payload: { assetId: "asset-ai", type: "buy", quantity: "1", unitPrice: "12" },
          },
        ],
      })
      .expect(201);

    expect(response.body.data.results).toHaveLength(2);
    expect(response.body.data.results.every((result: { status: string }) => result.status === "proposal")).toBe(true);
    expect(app.finance.repository.getAsset("asset-ai")).toMatchObject({
      quantity: "1",
      currentPrice: "10",
      version: 1,
    });
  });

  it("commits a confirmed batch once and replays it without duplicate mutations", async () => {
    await createAsset();
    const batch = {
      idempotencyKey: "committed-batch-1",
      actor: "test-agent",
      expectedVersions: { "asset:asset-ai": 1 },
      commands: [
        {
          type: "asset.price.update",
          payload: { assetId: "asset-ai", price: "15", source: "ai-test" },
        },
        {
          type: "asset.operation.record",
          confirmed: true,
          payload: {
            assetId: "asset-ai",
            type: "buy",
            quantity: "1",
            unitPrice: "12",
            idempotencyKey: "ai-fill-1",
          },
        },
      ],
    };

    const first = await request(app).post("/api/ai/commands/execute").send(batch).expect(201);
    expect(first.body.data.results.every((result: { status: string }) => result.status === "applied")).toBe(true);
    expect(app.finance.repository.getAsset("asset-ai")).toMatchObject({
      quantity: "2",
      currentPrice: "15",
      unitCost: "11",
    });

    const replay = await request(app).post("/api/ai/commands/execute").send(batch).expect(200);
    expect(replay.body.data.replayed).toBe(true);
    expect(replay.body.data.batchId).toBe(first.body.data.batchId);
    expect(app.finance.repository.getAsset("asset-ai").quantity).toBe("2");
  });

  it("rejects an idempotency key reused with a different request", async () => {
    await createAsset();
    const original = {
      idempotencyKey: "immutable-idempotency-key",
      actor: "test-agent",
      expectedVersions: { "asset:asset-ai": 1 },
      commands: [{
        type: "asset.price.update",
        payload: { assetId: "asset-ai", price: "15", source: "ai-test" },
      }],
    };

    await request(app).post("/api/ai/commands/execute").send(original).expect(201);
    const mismatch = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        ...original,
        commands: [{
          type: "asset.price.update",
          payload: { assetId: "asset-ai", price: "999", source: "ai-test" },
        }],
      })
      .expect(409);

    expect(mismatch.body.error.code).toBe("IDEMPOTENCY_KEY_REUSED");
    expect(app.finance.repository.getAsset("asset-ai").currentPrice).toBe("15");
  });

  it("requires a qualified expected version for every update", async () => {
    await createAsset();
    const response = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        idempotencyKey: "missing-version-1",
        actor: "test-agent",
        commands: [{
          type: "asset.price.update",
          payload: { assetId: "asset-ai", price: "15", source: "ai-test" },
        }],
      })
      .expect(409);

    expect(response.body.data.errorCode).toBe("EXPECTED_VERSION_REQUIRED");
    expect(app.finance.repository.getAsset("asset-ai")).toMatchObject({
      currentPrice: "10",
      version: 1,
    });
  });

  it("fully validates cumulative proposal effects before calling them valid", async () => {
    await createAsset();
    const response = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        idempotencyKey: "invalid-cumulative-proposal-1",
        actor: "test-agent",
        expectedVersions: { "asset:asset-ai": 1 },
        commands: [
          {
            type: "asset.operation.record",
            payload: { assetId: "asset-ai", type: "sell", quantity: "0.6" },
          },
          {
            type: "asset.operation.record",
            payload: { assetId: "asset-ai", type: "sell", quantity: "0.6" },
          },
        ],
      })
      .expect(409);

    expect(response.body.data.errorCode).toBe("NEGATIVE_QUANTITY");
    expect(app.finance.repository.getAsset("asset-ai")).toMatchObject({ quantity: "1", version: 1 });
  });

  it("keeps active event creation as a proposal until explicitly confirmed", async () => {
    const response = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        idempotencyKey: "event-proposal-1",
        actor: "test-agent",
        commands: [{
          type: "event.create",
          payload: {
            id: "proposed-event",
            name: "Daily research",
            topic: "Policy changes",
            instructions: "Check authoritative sources.",
            schedule: "0 9 * * *",
          },
        }],
      })
      .expect(201);

    expect(response.body.data.results[0].status).toBe("proposal");
    expect(app.finance.db.prepare("SELECT COUNT(*) FROM tracked_events WHERE id = ?").pluck().get("proposed-event")).toBe(0);
  });

  it("rolls back every domain mutation and audits every command when one command fails", async () => {
    const response = await request(app)
      .post("/api/ai/commands/execute")
      .send({
        idempotencyKey: "failed-batch-1",
        actor: "test-agent",
        commands: [
          {
            type: "asset.create",
            payload: {
              id: "rolled-back-asset",
              name: "Rolled back",
              symbol: "RBK",
              kind: "other",
              currency: "USD",
              quantity: "0",
            },
          },
          {
            type: "event.create",
            payload: {
              id: "invalid-event",
              name: "Invalid schedule",
              topic: "Test",
              instructions: "Test atomic rollback",
              schedule: "not-a-cron",
            },
          },
        ],
      })
      .expect(409);

    expect(response.body.data.status).toBe("failed");
    expect(app.finance.db.prepare("SELECT COUNT(*) FROM assets WHERE id = ?").pluck().get("rolled-back-asset")).toBe(0);
    expect(app.finance.db.prepare("SELECT status FROM ai_command_batches WHERE idempotency_key = ?").pluck().get("failed-batch-1")).toBe("failed");
    expect(app.finance.db.prepare("SELECT COUNT(*) FROM ai_command_audit WHERE batch_id = ?").pluck().get(response.body.data.batchId)).toBe(2);
  });

  it("supports expected-asset creation and bearer protection", async () => {
    const guarded = createApp({
      databasePath: ":memory:",
      seed: false,
      serveStatic: false,
      aiApiToken: "test-secret",
    });
    const payload = {
      idempotencyKey: "expected-create-1",
      actor: "test-agent",
      commands: [{
        type: "expected.create",
        payload: {
          id: "expected-from-ai",
          name: "AI-discovered campaign",
          currency: "USD",
        },
      }],
    };

    try {
      await request(guarded).post("/api/ai/commands/execute").send(payload).expect(401);
      const response = await request(guarded)
        .post("/api/ai/commands/execute")
        .set("Authorization", "Bearer test-secret")
        .send(payload)
        .expect(201);
      expect(response.body.data.results[0]).toMatchObject({
        type: "expected.create",
        status: "applied",
        targetId: "expected-from-ai",
      });
      expect(guarded.finance.repository.getExpectedAsset("expected-from-ai").stage).toBe("discovered");
    } finally {
      guarded.finance.close();
    }
  });

  it("publishes a machine-readable command schema", async () => {
    const response = await request(app).get("/api/ai/capabilities").expect(200);

    expect(response.body.data).toMatchObject({
      atomic: true,
      expectedVersionsRequiredForUpdates: true,
      expectedVersionKeys: ["asset:<id>", "expected:<id>", "event:<id>"],
      requestJsonSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
      },
    });
  });
});

describe("dashboard currency boundary", () => {
  it("only aggregates the configured base currency and reports unconverted items", async () => {
    await createAsset("usd-asset");
    await request(app)
      .post("/api/assets")
      .send({
        id: "cny-asset",
        name: "CNY asset",
        symbol: "CNYA",
        kind: "cash",
        account: "Cash",
        currency: "CNY",
        quantity: "1000",
        unitCost: "1",
        currentPrice: "1",
        priceMode: "manual",
        priceSource: "test",
      })
      .expect(201);

    const response = await request(app).get("/api/dashboard").expect(200);
    expect(response.body.data).toMatchObject({
      baseCurrency: "USD",
      netWorth: "10",
      unconvertedAssetCount: 1,
    });
  });
});
