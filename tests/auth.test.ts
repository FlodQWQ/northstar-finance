import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp, type FinanceApp } from "../server/app";
import { MockAIProvider } from "../server/providers/ai";

const origin = "http://northstar.test";
const password = "correct horse battery staple";
const apps: FinanceApp[] = [];

interface SignedInAccount {
  cookie: string;
  csrfToken: string;
  user: { id: string; username: string };
}

function createProtectedApp(options: Parameters<typeof createApp>[0] = {}): FinanceApp {
  const app = createApp({
    databasePath: ":memory:",
    seed: false,
    serveStatic: false,
    appBaseUrl: `${origin}/northstar`,
    aiProvider: new MockAIProvider(),
    ...options,
  });
  apps.push(app);
  return app;
}

function cookieFrom(response: request.Response): string {
  const setCookie = response.headers["set-cookie"] as unknown as string[] | undefined;
  if (!setCookie?.[0]) throw new Error("Session cookie was not set");
  return setCookie[0].split(";", 1)[0] ?? "";
}

async function register(app: FinanceApp, username: string): Promise<SignedInAccount> {
  const response = await request(app)
    .post("/api/auth/register")
    .set("Origin", origin)
    .send({ username, password })
    .expect(201);
  return {
    cookie: cookieFrom(response),
    csrfToken: response.body.data.csrfToken,
    user: response.body.data.user,
  };
}

function authenticated(
  app: FinanceApp,
  account: SignedInAccount,
  method: "get" | "post" | "patch" | "delete",
  path: string,
) {
  const call = request(app)[method](path).set("Cookie", account.cookie);
  if (method !== "get") {
    call.set("Origin", origin).set("X-CSRF-Token", account.csrfToken);
  }
  return call;
}

beforeEach(() => {
  process.env.NODE_ENV = "test";
});

afterEach(() => {
  for (const app of apps.splice(0)) app.finance.close();
});

describe("application authentication", () => {
  it("serves health without authentication and never requests browser Basic Auth", async () => {
    const app = createProtectedApp();

    const health = await request(app).get("/api/health").expect(200);
    expect(health.body.data.authentication).toMatchObject({
      status: "ok",
      registration: "open",
    });

    const session = await request(app).get("/api/auth/session").expect(200);
    expect(session.headers["www-authenticate"]).toBeUndefined();
    expect(session.body.data).toEqual({ authenticated: false });
    const dashboard = await request(app).get("/api/dashboard").expect(401);
    expect(dashboard.headers["www-authenticate"]).toBeUndefined();
    expect(dashboard.body.error.code).toBe("UNAUTHENTICATED");
  });

  it("registers, logs in, restores the session, and logs out with an HttpOnly cookie", async () => {
    const app = createProtectedApp();
    const account = await register(app, "northstar");

    const registeredCookie = (await request(app)
      .post("/api/auth/login")
      .set("Origin", origin)
      .send({ identifier: "northstar", password })
      .expect(200)).headers["set-cookie"] as unknown as string[];
    expect(registeredCookie[0]).toContain("HttpOnly");
    expect(registeredCookie[0]).toContain("SameSite=Lax");
    expect(registeredCookie[0]).toContain("Path=/northstar");
    expect(registeredCookie[0]).not.toContain("Secure");

    const session = await request(app)
      .get("/api/auth/session")
      .set("Cookie", account.cookie)
      .expect(200);
    expect(session.body.data.user).toMatchObject({ username: "northstar", role: "owner" });
    expect(session.body.data.csrfToken).toBe(account.csrfToken);

    const logout = await authenticated(app, account, "post", "/api/auth/logout").expect(200);
    const clearedCookie = logout.headers["set-cookie"] as unknown as string[];
    expect(clearedCookie[0]).toContain("Max-Age=0");
    const signedOut = await request(app)
      .get("/api/auth/session")
      .set("Cookie", account.cookie)
      .expect(200);
    expect(signedOut.body.data.authenticated).toBe(false);
  });

  it("rejects duplicate identities, weak passwords, closed registration, and bad credentials", async () => {
    const app = createProtectedApp();
    await register(app, "alice");

    const duplicate = await request(app)
      .post("/api/auth/register")
      .set("Origin", origin)
      .send({ username: "ALICE", password })
      .expect(409);
    expect(duplicate.body.error.code).toBe("USERNAME_TAKEN");

    const weak = await request(app)
      .post("/api/auth/register")
      .set("Origin", origin)
      .send({ username: "shortpass", password: "short" })
      .expect(400);
    expect(weak.body.error.code).toBe("INVALID_PASSWORD");

    const invalid = await request(app)
      .post("/api/auth/login")
      .set("Origin", origin)
      .send({ identifier: "alice", password: "wrong password value" })
      .expect(401);
    expect(invalid.body.error.code).toBe("INVALID_CREDENTIALS");

    const closed = createProtectedApp({ registrationMode: "closed" });
    const response = await request(closed)
      .post("/api/auth/register")
      .set("Origin", origin)
      .send({ username: "blocked", password })
      .expect(403);
    expect(response.body.error.code).toBe("REGISTRATION_CLOSED");
  });

  it("requires an exact Origin and CSRF token for session-authenticated mutations", async () => {
    const app = createProtectedApp();
    const account = await register(app, "csrf-owner");
    const asset = {
      id: "csrf-asset",
      name: "CSRF asset",
      symbol: "CSRF",
      kind: "cash",
      account: "Wallet",
      currency: "USD",
      quantity: "1",
      unitCost: "1",
      currentPrice: "1",
      priceMode: "manual",
      priceSource: "test",
    };

    await request(app).post("/api/assets").set("Cookie", account.cookie).send(asset).expect(403);
    await request(app)
      .post("/api/assets")
      .set("Cookie", account.cookie)
      .set("Origin", "https://attacker.example")
      .set("X-CSRF-Token", account.csrfToken)
      .send(asset)
      .expect(403);
    const wrongCsrf = await request(app)
      .post("/api/assets")
      .set("Cookie", account.cookie)
      .set("Origin", origin)
      .set("X-CSRF-Token", "wrong")
      .send(asset)
      .expect(403);
    expect(wrongCsrf.body.error.code).toBe("INVALID_CSRF_TOKEN");
    await authenticated(app, account, "post", "/api/assets").send(asset).expect(201);
  });

  it("rate-limits repeated login attempts for one account", async () => {
    const app = createProtectedApp();
    await register(app, "limited-owner");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await request(app)
        .post("/api/auth/login")
        .set("Origin", origin)
        .send({ identifier: "limited-owner", password: "incorrect password value" })
        .expect(401);
    }
    const limited = await request(app)
      .post("/api/auth/login")
      .set("Origin", origin)
      .send({ identifier: "limited-owner", password })
      .expect(429);
    expect(limited.body.error.code).toBe("RATE_LIMITED");
  });
});

describe("tenant isolation", () => {
  it("isolates lists, settings, reads, mutations, runs, and expected-asset conversion", async () => {
    const app = createProtectedApp();
    const alice = await register(app, "alice-assets");
    const bob = await register(app, "bob-assets");

    await authenticated(app, alice, "post", "/api/assets").send({
      id: "alice-asset",
      name: "Alice Bitcoin",
      symbol: "BTC",
      kind: "crypto",
      account: "Alice wallet",
      currency: "USD",
      quantity: "1",
      unitCost: "10",
      currentPrice: "12",
      priceMode: "manual",
      priceSource: "test",
    }).expect(201);
    await authenticated(app, alice, "post", "/api/expected").send({
      id: "alice-expected",
      name: "Alice airdrop",
      currency: "USD",
    }).expect(201);
    await authenticated(app, alice, "post", "/api/events").send({
      id: "alice-event",
      name: "Alice event",
      topic: "Private topic",
      instructions: "Check private event sources.",
      schedule: "0 9 * * *",
      timezone: "Asia/Shanghai",
    }).expect(201);
    const run = await authenticated(app, alice, "post", "/api/events/alice-event/run")
      .send({})
      .expect(201);

    expect((await authenticated(app, bob, "get", "/api/assets").expect(200)).body.data).toEqual([]);
    expect((await authenticated(app, bob, "get", "/api/expected").expect(200)).body.data).toEqual([]);
    expect((await authenticated(app, bob, "get", "/api/events").expect(200)).body.data).toEqual([]);
    expect((await authenticated(app, bob, "get", "/api/dashboard").expect(200)).body.data.netWorth)
      .toBe("0");

    await authenticated(app, alice, "patch", "/api/settings").send({ baseCurrency: "CNY" }).expect(200);
    expect((await authenticated(app, bob, "get", "/api/settings").expect(200)).body.data.baseCurrency)
      .toBe("USD");

    const hiddenGets = [
      "/api/assets/alice-asset",
      "/api/assets/alice-asset/operations",
      "/api/assets/alice-asset/price",
      "/api/expected/alice-expected",
      "/api/expected/alice-expected/updates",
      "/api/expected/alice-expected/runs",
      "/api/events/alice-event",
      "/api/events/alice-event/runs",
      `/api/runs/${run.body.data.id}`,
    ];
    for (const path of hiddenGets) {
      await authenticated(app, bob, "get", path).expect(404);
    }

    await authenticated(app, bob, "patch", "/api/assets/alice-asset")
      .send({ notes: "cross-account write" }).expect(404);
    await authenticated(app, bob, "delete", "/api/assets/alice-asset").expect(404);
    await authenticated(app, bob, "post", "/api/assets/alice-asset/operations")
      .send({ type: "buy", quantity: "1" }).expect(404);
    await authenticated(app, bob, "post", "/api/assets/alice-asset/price")
      .send({ price: "999" }).expect(404);
    await authenticated(app, bob, "patch", "/api/expected/alice-expected")
      .send({ notes: "cross-account write" }).expect(404);
    await authenticated(app, bob, "delete", "/api/expected/alice-expected").expect(404);
    await authenticated(app, bob, "post", "/api/expected/alice-expected/check").send({}).expect(404);
    await authenticated(app, bob, "post", "/api/expected/alice-expected/convert").send({
      symbol: "CLAIM",
      quantity: "1",
    }).expect(404);
    await authenticated(app, bob, "patch", "/api/events/alice-event")
      .send({ status: "paused" }).expect(404);
    await authenticated(app, bob, "delete", "/api/events/alice-event").expect(404);
    await authenticated(app, bob, "post", "/api/events/alice-event/run").send({}).expect(404);

    expect((await authenticated(app, alice, "get", "/api/assets/alice-asset").expect(200))
      .body.data.notes).toBe("");
  });

  it("binds AI tokens and idempotency to one owner and rejects revoked tokens", async () => {
    const app = createProtectedApp();
    const alice = await register(app, "alice-ai");
    const bob = await register(app, "bob-ai");

    const aliceToken = await authenticated(app, alice, "post", "/api/account/api-tokens").send({
      name: "Alice agent",
      scopes: ["ai:read", "finance:write"],
    }).expect(201);
    const bobToken = await authenticated(app, bob, "post", "/api/account/api-tokens").send({
      name: "Bob agent",
      scopes: ["ai:read", "finance:write"],
    }).expect(201);
    const batch = (id: string) => ({
      idempotencyKey: "shared-key",
      actor: "tenant-test",
      commands: [{
        type: "expected.create",
        payload: { id, name: id, currency: "USD" },
      }],
    });

    await request(app).post("/api/ai/commands/execute")
      .set("Authorization", `Bearer ${aliceToken.body.data.token}`)
      .send(batch("alice-ai-expected")).expect(201);
    await request(app).post("/api/ai/commands/execute")
      .set("Authorization", `Bearer ${bobToken.body.data.token}`)
      .send(batch("bob-ai-expected")).expect(201);

    expect((await authenticated(app, alice, "get", "/api/expected").expect(200)).body.data)
      .toHaveLength(1);
    expect((await authenticated(app, bob, "get", "/api/expected").expect(200)).body.data)
      .toHaveLength(1);

    await authenticated(
      app,
      alice,
      "delete",
      `/api/account/api-tokens/${aliceToken.body.data.apiToken.id}`,
    ).expect(200);
    await request(app).get("/api/ai/capabilities")
      .set("Authorization", `Bearer ${aliceToken.body.data.token}`)
      .expect(401);
  });
});
