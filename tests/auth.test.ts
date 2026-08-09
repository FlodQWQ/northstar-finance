import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp, type CreateAppOptions, type FinanceApp } from "../server/app";

const apps: FinanceApp[] = [];

function createProtectedApp(options: Partial<CreateAppOptions> = {}): FinanceApp {
  const app = createApp({
    databasePath: ":memory:",
    seed: false,
    serveStatic: false,
    appAuthUsername: "owner",
    appAuthPassword: "correct horse battery staple",
    aiApiToken: "ai-secret",
    ...options,
  });
  apps.push(app);
  return app;
}

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "production");
});

afterEach(() => {
  for (const app of apps.splice(0)) app.finance.close();
  vi.unstubAllEnvs();
});

describe("application authentication", () => {
  it("exempts health but requires valid Basic credentials for ordinary routes", async () => {
    const app = createProtectedApp();

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.data.authentication.status).toBe("ok");

    const missing = await request(app).get("/api/dashboard").expect(401);
    expect(missing.headers["www-authenticate"]).toBe(
      'Basic realm="Northstar Finance", charset="UTF-8"',
    );

    await request(app)
      .get("/api/dashboard")
      .auth("owner", "wrong password", { type: "basic" })
      .expect(401);

    await request(app)
      .get("/api/dashboard")
      .auth("owner", "correct horse battery staple", { type: "basic" })
      .expect(200);
  });

  it("does not let the AI bearer token access ordinary application routes", async () => {
    const app = createProtectedApp();

    await request(app)
      .get("/api/dashboard")
      .set("Authorization", "Bearer ai-secret")
      .expect(401);
    await request(app)
      .post("/api/settings/test-email")
      .set("Authorization", "Bearer ai-secret")
      .expect(401);
  });

  it("fails closed when production Basic credentials are missing", async () => {
    const app = createProtectedApp({ appAuthUsername: "", appAuthPassword: "" });

    const response = await request(app).get("/api/dashboard").expect(503);
    expect(response.body.error.code).toBe("APP_AUTH_DISABLED");
    const health = await request(app).get("/api/health").expect(503);
    expect(health.body.data.authentication.status).toBe("misconfigured");

    await request(app)
      .get("/api/ai/capabilities")
      .set("Authorization", "Bearer ai-secret")
      .expect(200);
  });

  it("protects both AI discovery and execution with the Bearer token", async () => {
    const app = createProtectedApp();

    await request(app).get("/api/ai/capabilities").expect(401);
    await request(app)
      .get("/api/ai/capabilities")
      .auth("owner", "correct horse battery staple", { type: "basic" })
      .expect(401);
    await request(app)
      .get("/api/ai/capabilities")
      .set("Authorization", "Bearer ai-secret")
      .expect(200);

    const payload = {
      idempotencyKey: "auth-test-command",
      actor: "auth-test-agent",
      commands: [{
        type: "expected.create",
        payload: { id: "auth-test-expected", name: "Auth test", currency: "USD" },
      }],
    };
    await request(app).post("/api/ai/commands/execute").send(payload).expect(401);
    await request(app)
      .post("/api/ai/commands/execute")
      .set("Authorization", "Bearer ai-secret")
      .send(payload)
      .expect(201);
  });

  it("fails closed without an AI token in production", async () => {
    const app = createProtectedApp({ aiApiToken: "" });

    const response = await request(app).get("/api/ai/capabilities").expect(503);
    expect(response.body.error.code).toBe("AI_API_DISABLED");
  });

  it("keeps loopback development requests login-free", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const app = createProtectedApp({
      appAuthUsername: "",
      appAuthPassword: "",
      aiApiToken: "",
    });

    await request(app).get("/api/dashboard").expect(200);
    await request(app).get("/api/ai/capabilities").expect(200);
  });
});
