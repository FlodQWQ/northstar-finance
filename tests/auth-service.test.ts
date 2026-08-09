import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import {
  AuthError,
  AuthService,
  cookiePathFromAppBaseUrl,
  hashPassword,
  hashToken,
  parseCookieHeader,
  validateEmail,
  validatePassword,
  validateUsername,
  verifyPassword,
} from "../server/services/auth";

const authSchema = `
  CREATE TABLE users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL,
    username_normalized TEXT NOT NULL UNIQUE,
    email TEXT,
    email_normalized TEXT UNIQUE,
    password_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
    role TEXT NOT NULL CHECK (role IN ('user', 'owner')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    token_hash TEXT NOT NULL UNIQUE,
    csrf_token TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    idle_expires_at TEXT NOT NULL,
    absolute_expires_at TEXT NOT NULL,
    revoked_at TEXT,
    user_agent_hash TEXT,
    ip_hash TEXT
  );

  CREATE TABLE api_tokens (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    token_prefix TEXT NOT NULL,
    scopes_json TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_used_at TEXT,
    expires_at TEXT,
    revoked_at TEXT
  );

  CREATE TABLE settings (
    owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (owner_id, key)
  );
`;

const databases: Database.Database[] = [];

function createDatabase(): Database.Database {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  db.exec(authSchema);
  databases.push(db);
  return db;
}

function createService(
  db: Database.Database,
  options: ConstructorParameters<typeof AuthService>[1] = {},
): AuthService {
  return new AuthService(db, {
    passwordHash: { cost: 1_024, maxmem: 16 * 1024 * 1024 },
    ...options,
  });
}

afterEach(() => {
  for (const db of databases.splice(0)) {
    if (db.open) db.close();
  }
});

describe("password and identity validation", () => {
  it("hashes passwords with a random salt and verifies them", async () => {
    const options = { cost: 1_024, maxmem: 16 * 1024 * 1024 };
    const first = await hashPassword("correct horse battery staple", options);
    const second = await hashPassword("correct horse battery staple", options);

    expect(first).toMatch(/^\$scrypt\$N=1024,r=8,p=1,l=32\$/);
    expect(second).not.toBe(first);
    await expect(verifyPassword("correct horse battery staple", first)).resolves.toBe(true);
    await expect(verifyPassword("wrong password", first)).resolves.toBe(false);
    await expect(verifyPassword("correct horse battery staple", "not-a-hash")).resolves.toBe(false);
  });

  it("normalizes valid identities and rejects weak input", () => {
    expect(validateUsername(" Alice.01 ")).toBe("Alice.01");
    expect(validateEmail(" Alice@Example.COM ")).toBe("Alice@Example.COM");
    expect(validatePassword("a long passphrase")).toBe("a long passphrase");
    expect(() => validateUsername("ab")).toThrow(AuthError);
    expect(() => validateEmail("not-an-email")).toThrow(AuthError);
    expect(() => validatePassword("too short")).toThrow(AuthError);
  });
});

describe("AuthService sessions", () => {
  it("registers isolated identities, assigns the first owner, and rejects duplicates", async () => {
    const db = createDatabase();
    db.prepare(`
      INSERT INTO users (
        id, username, username_normalized, email, email_normalized,
        password_hash, status, role, created_at, updated_at
      ) VALUES ('internal', '__internal__', '__internal__', NULL, NULL,
                'disabled', 'disabled', 'user', ?, ?)
    `).run("2026-08-10T00:00:00.000Z", "2026-08-10T00:00:00.000Z");
    const service = createService(db);
    const owner = await service.register({
      username: "Owner",
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    const member = await service.register({
      username: "Member",
      password: "another sufficiently long password",
    });

    expect(owner).toMatchObject({ username: "Owner", email: "owner@example.com", role: "owner" });
    expect(member).toMatchObject({ username: "Member", email: null, role: "user" });
    await expect(service.register({
      username: "owner",
      password: "yet another valid password",
    })).rejects.toMatchObject({ code: "USERNAME_TAKEN", status: 409 });
    await expect(service.register({
      username: "Someone",
      email: "OWNER@EXAMPLE.COM",
      password: "yet another valid password",
    })).rejects.toMatchObject({ code: "EMAIL_TAKEN", status: 409 });
  });

  it("logs in by username or email, stores only the token hash, and enforces CSRF", async () => {
    const db = createDatabase();
    const service = createService(db, {
      appBaseUrl: "https://la.134271.xyz/northstar/",
      production: true,
    });
    const user = await service.register({
      username: "northstar",
      email: "owner@example.com",
      password: "correct horse battery staple",
    });
    const created = await service.login(
      { identifier: "OWNER@EXAMPLE.COM", password: "correct horse battery staple" },
      { userAgent: "vitest", ip: "127.0.0.1" },
    );

    expect(created.user.id).toBe(user.id);
    expect(created.token).toMatch(/^nss_/);
    expect(created.session.csrfToken).toMatch(/^nsc_/);
    const stored = db.prepare("SELECT token_hash, user_agent_hash, ip_hash FROM sessions").get() as {
      token_hash: string;
      user_agent_hash: string;
      ip_hash: string;
    };
    expect(stored.token_hash).toBe(hashToken(created.token));
    expect(stored.token_hash).not.toContain(created.token);
    expect(stored.user_agent_hash).toHaveLength(64);
    expect(stored.ip_hash).toHaveLength(64);

    expect(service.getSession(created.token)?.user.id).toBe(user.id);
    expect(() => service.requireCsrf(created.session, "wrong")).toThrowError(
      expect.objectContaining({ code: "INVALID_CSRF_TOKEN" }),
    );
    expect(() => service.requireCsrf(created.session, created.session.csrfToken)).not.toThrow();

    const cookie = service.serializeSessionCookie(created);
    expect(cookie).toContain("Path=/northstar");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("SameSite=Lax");
    expect(service.sessionTokenFromCookie(cookie.split(";", 1)[0])).toBe(created.token);

    expect(service.revokeSession(created.token)).toBe(true);
    expect(service.getSession(created.token)).toBeNull();
  });

  it("expires idle sessions and does not reveal disabled accounts", async () => {
    const db = createDatabase();
    let now = Date.parse("2026-08-10T00:00:00.000Z");
    const service = createService(db, {
      now: () => new Date(now),
      sessionIdleMs: 60_000,
      sessionAbsoluteMs: 120_000,
      touchIntervalMs: 10_000,
    });
    const user = await service.register({
      username: "alice",
      password: "correct horse battery staple",
    });
    const created = await service.login({
      identifier: "alice",
      password: "correct horse battery staple",
    });

    now += 61_000;
    expect(service.getSession(created.token)).toBeNull();
    expect(db.prepare("SELECT revoked_at FROM sessions WHERE id = ?").pluck().get(created.session.id))
      .toBe(new Date(now).toISOString());

    db.prepare("UPDATE users SET status = 'disabled' WHERE id = ?").run(user.id);
    await expect(service.login({
      identifier: "alice",
      password: "correct horse battery staple",
    })).rejects.toMatchObject({ code: "INVALID_CREDENTIALS", status: 401 });
  });
});

describe("AuthService API tokens", () => {
  it("creates, scopes, lists, authenticates, and revokes owner-bound tokens", async () => {
    const service = createService(createDatabase());
    const user = await service.register({
      username: "agentowner",
      password: "correct horse battery staple",
    });
    const created = service.createApiToken(user.id, {
      name: "Codex agent",
      scopes: ["finance:write", "ai:read", "finance:write"],
    });

    expect(created.token).toMatch(/^nsat_/);
    expect(created.apiToken.scopes).toEqual(["ai:read", "finance:write"]);
    expect(service.listApiTokens(user.id)).toHaveLength(1);
    const principal = service.authenticateApiToken(created.token, ["finance:write"]);
    expect(principal?.user.id).toBe(user.id);
    expect(principal?.token.id).toBe(created.apiToken.id);
    expect(service.authenticateApiToken(created.token, ["admin"])).toBeNull();
    expect(service.authenticateApiToken("nsat_invalid")).toBeNull();

    expect(service.revokeApiToken(user.id, created.apiToken.id)).toBe(true);
    expect(service.authenticateApiToken(created.token)).toBeNull();
  });
});

describe("cookie helpers", () => {
  it("derives a deployment-safe cookie path and parses cookie headers", () => {
    expect(cookiePathFromAppBaseUrl("https://example.com/northstar/")).toBe("/northstar");
    expect(cookiePathFromAppBaseUrl("https://example.com/")).toBe("/");
    expect(parseCookieHeader("a=one; encoded=hello%20world; broken")).toEqual({
      a: "one",
      encoded: "hello world",
    });
  });
});
