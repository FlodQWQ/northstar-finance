import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type FinanceApp } from "../server/app";
import { MockAIProvider, type AIProvider } from "../server/providers/ai";

let app: FinanceApp;

beforeEach(() => {
  app = createApp({
    databasePath: ":memory:",
    seed: false,
    aiProvider: new MockAIProvider(),
    serveStatic: false,
    disableAuthenticationForTests: true,
  });
});

afterEach(() => {
  app.finance.close();
});

describe("finance API", () => {
  it("reports API and database health", async () => {
    const response = await request(app).get("/api/health").expect(200);

    expect(response.headers["x-powered-by"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("no-store");
    expect(response.body.data).toMatchObject({
      status: "ok",
      database: { status: "ok" },
    });
    expect(Date.parse(response.body.data.timestamp)).not.toBeNaN();
  });

  it("creates a direct asset and records an exact manual price update", async () => {
    const createResponse = await request(app)
      .post("/api/assets")
      .send({
        id: "asset-btc",
        name: "Bitcoin",
        symbol: "BTC",
        kind: "crypto",
        account: "Cold wallet",
        currency: "USD",
        quantity: "0.125",
        unitCost: "42000.5",
        currentPrice: "68000.25",
        priceMode: "manual",
        priceSource: "manual",
      })
      .expect(201);

    expect(createResponse.body.data).toMatchObject({
      id: "asset-btc",
      quantity: "0.125",
      currentPrice: "68000.25",
      marketValue: "8500.03125",
      costBasis: "5250.0625",
    });

    const asOf = new Date(Date.parse(createResponse.body.data.priceUpdatedAt) + 1_000).toISOString();
    const priceResponse = await request(app)
      .post("/api/assets/asset-btc/price")
      .send({
        price: "70000.125",
        currency: "USD",
        source: "manual-test",
        asOf,
      })
      .expect(200);

    expect(priceResponse.body.data).toMatchObject({
      id: "asset-btc",
      currentPrice: "70000.125",
      marketValue: "8750.015625",
      priceSource: "manual-test",
      priceUpdatedAt: asOf,
    });

    const historyResponse = await request(app)
      .get("/api/assets/asset-btc/price")
      .expect(200);
    expect(historyResponse.body.data).toHaveLength(2);
    expect(historyResponse.body.data[0]).toMatchObject({
      price: "70000.125",
      source: "manual-test",
      asOf,
    });
  });

  it("calibrates absolute balances with version checks and an adjustment audit trail", async () => {
    await request(app)
      .post("/api/assets")
      .send({
        id: "balance-asset",
        name: "Balance asset",
        symbol: "BAL",
        kind: "crypto",
        account: "Test wallet",
        currency: "USD",
        quantity: "2",
        unitCost: "10",
        currentPrice: "15",
        priceMode: "manual",
        priceSource: "test",
      })
      .expect(201);

    const asOf = "2026-08-10T12:00:00.000Z";
    const increased = await request(app)
      .put("/api/assets/balance-asset/balance")
      .send({
        quantity: "5",
        expectedVersion: 1,
        unitCost: "11",
        note: "Wallet reconciliation",
        asOf,
      })
      .expect(200);

    expect(increased.body.data).toMatchObject({
      quantity: "5",
      unitCost: "11",
      currentPrice: "15",
      marketValue: "75",
      costBasis: "55",
      version: 2,
    });

    const decreased = await request(app)
      .put("/api/assets/balance-asset/balance")
      .send({ quantity: "1", expectedVersion: 2 })
      .expect(200);

    expect(decreased.body.data).toMatchObject({
      quantity: "1",
      unitCost: "11",
      currentPrice: "15",
      marketValue: "15",
      costBasis: "11",
      version: 3,
    });

    const operations = await request(app)
      .get("/api/assets/balance-asset/operations")
      .expect(200);
    const adjustments = operations.body.data.filter(
      (operation: { type: string }) => operation.type === "adjustment",
    );
    expect(adjustments).toHaveLength(2);
    expect(adjustments).toEqual(expect.arrayContaining([
      expect.objectContaining({
        quantityDelta: "3",
        unitPrice: "11",
        note: "Wallet reconciliation",
        occurredAt: asOf,
      }),
      expect.objectContaining({
        quantityDelta: "-4",
        unitPrice: "11",
        note: "Balance calibrated",
      }),
    ]));

    const conflict = await request(app)
      .put("/api/assets/balance-asset/balance")
      .send({ quantity: "9", expectedVersion: 2 })
      .expect(409);
    expect(conflict.body.error.code).toBe("ASSET_VERSION_CONFLICT");

    const unchanged = await request(app).get("/api/assets/balance-asset").expect(200);
    expect(unchanged.body.data).toMatchObject({ quantity: "1", marketValue: "15", version: 3 });
    expect((await request(app).get("/api/assets/balance-asset/operations").expect(200)).body.data)
      .toHaveLength(3);

    await request(app)
      .put("/api/assets/balance-asset/balance")
      .send({ quantity: "2" })
      .expect(400);

    const bypass = await request(app)
      .patch("/api/assets/balance-asset")
      .send({ quantity: "99" })
      .expect(400);
    expect(bypass.body.error.code).toBe("VALIDATION_ERROR");
    expect((await request(app).get("/api/assets/balance-asset").expect(200)).body.data)
      .toMatchObject({ quantity: "1", marketValue: "15", version: 3 });
  });

  it("preserves a negative quantity for a liability holding", async () => {
    const response = await request(app)
      .post("/api/assets")
      .send({
        id: "usdt-debt",
        name: "USDT debt",
        symbol: "USDT",
        kind: "other",
        account: "Exchange liability",
        currency: "USDT",
        quantity: "-4000",
        unitCost: "1",
        currentPrice: "1",
        priceMode: "manual",
        priceSource: "stablecoin",
      })
      .expect(201);

    expect(response.body.data).toMatchObject({
      quantity: "-4000",
      marketValue: "-4000",
      costBasis: "-4000",
    });

    const calibrated = await request(app)
      .put("/api/assets/usdt-debt/balance")
      .send({ quantity: "-3500", expectedVersion: 1, note: "Debt reconciliation" })
      .expect(200);
    expect(calibrated.body.data).toMatchObject({
      quantity: "-3500",
      marketValue: "-3500",
      version: 2,
    });

    const operation = await request(app)
      .post("/api/assets/usdt-debt/operations")
      .send({ type: "adjustment", quantityDelta: "-250", note: "Additional borrowing" })
      .expect(201);
    expect(operation.body.data).toMatchObject({
      operation: {
        type: "adjustment",
        quantityDelta: "-250",
        note: "Additional borrowing",
      },
      asset: {
        quantity: "-3750",
        currentPrice: "1",
        marketValue: "-3750",
        version: 3,
      },
    });

    await request(app)
      .post("/api/assets/usdt-debt/operations")
      .send({ type: "adjustment", quantity: "250" })
      .expect(400);
    await request(app)
      .post("/api/assets/usdt-debt/operations")
      .send({ type: "buy", quantityDelta: "250" })
      .expect(400);

    await request(app)
      .put("/api/assets/usdt-debt/balance")
      .send({ quantity: "0", expectedVersion: 3 })
      .expect(200);
    const oversold = await request(app)
      .post("/api/assets/usdt-debt/operations")
      .send({ type: "sell", quantity: "1" })
      .expect(409);
    expect(oversold.body.error.code).toBe("NEGATIVE_QUANTITY");
  });

  it("updates an expected asset status and keeps AI research as an audited update", async () => {
    await request(app)
      .post("/api/expected")
      .send({
        id: "expected-airdrop",
        name: "Protocol Airdrop",
        category: "airdrop",
        ecosystem: "Ethereum",
        stage: "watching",
        health: "due",
        nextAction: "Check the official claim page",
        estimatedLow: "100",
        estimatedHigh: "600",
        currency: "USD",
        investedCost: "12.5",
        confidence: "medium",
        sourceUrl: "https://example.com/airdrop",
        keywords: ["claim", "eligibility"],
      })
      .expect(201);

    const updateResponse = await request(app)
      .patch("/api/expected/expected-airdrop")
      .send({
        stage: "claimable",
        health: "healthy",
        latestUpdate: "The claim window is open.",
      })
      .expect(200);

    expect(updateResponse.body.data).toMatchObject({
      id: "expected-airdrop",
      stage: "claimable",
      health: "healthy",
      latestUpdate: "The claim window is open.",
    });

    const checkResponse = await request(app)
      .post("/api/expected/expected-airdrop/check")
      .send({})
      .expect(200);
    expect(checkResponse.body.data.run).toMatchObject({
      status: "success",
      provider: "mock",
      emailStatus: "skipped",
    });
    expect(checkResponse.body.data.expected).toMatchObject({
      stage: "claimable",
      health: "healthy",
    });

    const updatesResponse = await request(app)
      .get("/api/expected/expected-airdrop/updates")
      .expect(200);
    expect(updatesResponse.body.data).toHaveLength(1);
    expect(updatesResponse.body.data[0]).toMatchObject({
      expectedAssetId: "expected-airdrop",
      type: "research",
      provider: "mock",
    });

    const runsResponse = await request(app)
      .get("/api/expected/expected-airdrop/runs")
      .expect(200);
    expect(runsResponse.body.data).toHaveLength(1);
    expect(runsResponse.body.data[0]).toMatchObject({
      id: checkResponse.body.data.run.id,
      eventId: "expected-airdrop",
      status: "success",
      provider: "mock",
    });
  });

  it("creates an event and runs it immediately through the injected AI provider", async () => {
    const createResponse = await request(app)
      .post("/api/events")
      .send({
        id: "event-policy",
        name: "Policy watch",
        topic: "Digital asset regulation",
        instructions: "Report material changes and cite primary sources.",
        schedule: "0 9 * * 1",
        scheduleLabel: "Every Monday at 09:00",
        timezone: "Asia/Shanghai",
        status: "active",
        notifyOnChangeOnly: true,
        emailEnabled: false,
        emailTo: "",
      })
      .expect(201);

    expect(createResponse.body.data).toMatchObject({
      id: "event-policy",
      status: "active",
      timezone: "Asia/Shanghai",
    });
    expect(Date.parse(createResponse.body.data.nextRunAt)).not.toBeNaN();

    const runResponse = await request(app)
      .post("/api/events/event-policy/run")
      .send({})
      .expect(201);
    expect(runResponse.body.data).toMatchObject({
      eventId: "event-policy",
      status: "success",
      provider: "mock",
      emailStatus: "skipped",
    });
    expect(runResponse.body.data.summary).toContain("Policy watch");

    const runsResponse = await request(app)
      .get("/api/events/event-policy/runs")
      .expect(200);
    expect(runsResponse.body.data).toHaveLength(1);
    expect(runsResponse.body.data[0].id).toBe(runResponse.body.data.id);

    const invalidEmail = await request(app)
      .patch("/api/events/event-policy")
      .send({ emailEnabled: true })
      .expect(400);
    expect(invalidEmail.body.error.code).toBe("EMAIL_RECIPIENT_REQUIRED");

    const emailEnabled = await request(app)
      .patch("/api/events/event-policy")
      .send({ emailEnabled: true, emailTo: "owner@example.com" })
      .expect(200);
    expect(emailEnabled.body.data).toMatchObject({
      emailEnabled: true,
      emailTo: "owner@example.com",
    });
  });

  it("persists live-search evidence and reads legacy source arrays", async () => {
    const sources = [{ title: "Protocol announcement", url: "https://example.com/announcement" }];
    const searchEvidence = {
      mode: "live" as const,
      query: "Protocol announcement eligibility",
      searchedAt: "2026-08-10T03:00:00.000Z",
      observedUrls: ["https://example.com/announcement", "https://example.com/status"],
    };
    const evidenceProvider: AIProvider = {
      id: "codex-sdk",
      async research() {
        return {
          summary: "The eligibility announcement is live.",
          changeSummary: "An official announcement was published.",
          changed: true,
          sources,
          provider: "codex-sdk",
          searchEvidence,
        };
      },
      async testConnection() {
        return { ok: true, status: "connected", message: "Evidence provider is ready." };
      },
    };
    const evidenceApp = createApp({
      databasePath: ":memory:",
      seed: false,
      aiProvider: evidenceProvider,
      serveStatic: false,
      disableAuthenticationForTests: true,
    });

    try {
      await request(evidenceApp)
        .post("/api/expected")
        .send({
          id: "evidence-expected",
          name: "Evidence airdrop",
          currency: "USD",
          sourceUrl: "https://example.com/announcement",
        })
        .expect(201);

      const checked = await request(evidenceApp)
        .post("/api/expected/evidence-expected/check")
        .send({})
        .expect(200);
      const runId = checked.body.data.run.id as string;
      expect(checked.body.data.run).toMatchObject({ sources, searchEvidence });

      const stored = evidenceApp.finance.db.prepare(
        "SELECT sources_json FROM monitor_runs WHERE id = ?",
      ).get(runId) as { sources_json: string };
      expect(JSON.parse(stored.sources_json)).toEqual({ sources, searchEvidence });

      const listed = await request(evidenceApp)
        .get("/api/expected/evidence-expected/runs")
        .expect(200);
      expect(listed.body.data[0]).toMatchObject({ id: runId, sources, searchEvidence });

      const legacySources = [{ title: "Legacy source", url: "https://example.com/legacy" }];
      evidenceApp.finance.db.prepare("UPDATE monitor_runs SET sources_json = ? WHERE id = ?")
        .run(JSON.stringify(legacySources), runId);

      const legacy = await request(evidenceApp).get(`/api/runs/${runId}`).expect(200);
      expect(legacy.body.data.sources).toEqual(legacySources);
      expect(legacy.body.data).not.toHaveProperty("searchEvidence");
    } finally {
      evidenceApp.finance.close();
    }
  });
});
