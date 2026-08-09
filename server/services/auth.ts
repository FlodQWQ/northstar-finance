import {
  createHash,
  randomBytes,
  randomUUID,
  scrypt as nodeScrypt,
  timingSafeEqual,
} from "node:crypto";
import { initializeUserSettings, type SqliteDatabase } from "../db/database";

const DEFAULT_SCRYPT_OPTIONS = {
  cost: 32_768,
  blockSize: 8,
  parallelization: 1,
  keyLength: 32,
  saltLength: 16,
  maxmem: 64 * 1024 * 1024,
} as const;

const DEFAULT_SESSION_IDLE_MS = 7 * 24 * 60 * 60 * 1_000;
const DEFAULT_SESSION_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1_000;
const DEFAULT_TOUCH_INTERVAL_MS = 5 * 60 * 1_000;
const USERNAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{2,31}$/;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const SCOPE_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/;
const DUMMY_PASSWORD_SALT = Buffer.from("northstar-auth-dummy-salt", "utf8");

export interface PasswordHashOptions {
  cost: number;
  blockSize: number;
  parallelization: number;
  keyLength: number;
  saltLength: number;
  maxmem: number;
}

export interface AuthUser {
  id: string;
  username: string;
  email: string | null;
  status: "active" | "disabled";
  role: "user" | "owner";
  createdAt: string;
  updatedAt: string;
}

export interface AuthSession {
  id: string;
  userId: string;
  csrfToken: string;
  createdAt: string;
  lastSeenAt: string;
  idleExpiresAt: string;
  absoluteExpiresAt: string;
}

export interface AuthenticatedSession {
  session: AuthSession;
  user: AuthUser;
}

export interface CreatedSession extends AuthenticatedSession {
  token: string;
}

export interface ApiToken {
  id: string;
  userId: string;
  name: string;
  tokenPrefix: string;
  scopes: string[];
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

export interface ApiTokenPrincipal {
  token: ApiToken;
  user: AuthUser;
}

export interface CreatedApiToken {
  token: string;
  apiToken: ApiToken;
}

export interface SessionMetadata {
  userAgent?: string | null;
  ip?: string | null;
}

export interface AuthServiceOptions {
  appBaseUrl?: string | null;
  production?: boolean;
  cookieName?: string;
  sessionIdleMs?: number;
  sessionAbsoluteMs?: number;
  touchIntervalMs?: number;
  passwordHash?: Partial<PasswordHashOptions>;
  firstUserIsOwner?: boolean;
  now?: () => Date;
}

export interface CookieSerializeOptions {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "Lax" | "Strict" | "None";
  maxAge?: number;
  expires?: Date;
}

type UserRow = {
  id: string;
  username: string;
  username_normalized: string;
  email: string | null;
  email_normalized: string | null;
  password_hash: string;
  status: "active" | "disabled";
  role: "user" | "owner";
  created_at: string;
  updated_at: string;
};

type SessionUserRow = UserRow & {
  session_id: string;
  user_id: string;
  csrf_token: string;
  session_created_at: string;
  last_seen_at: string;
  idle_expires_at: string;
  absolute_expires_at: string;
  revoked_at: string | null;
};

type ApiTokenRow = {
  id: string;
  user_id: string;
  name: string;
  token_prefix: string;
  scopes_json: string;
  created_at: string;
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
};

export class AuthError extends Error {
  public constructor(
    message: string,
    public readonly status = 400,
    public readonly code = "AUTH_ERROR",
  ) {
    super(message);
    this.name = "AuthError";
  }
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function resolvedPasswordOptions(
  input: Partial<PasswordHashOptions> = {},
): PasswordHashOptions {
  const options = { ...DEFAULT_SCRYPT_OPTIONS, ...input };
  positiveInteger(options.cost, "scrypt cost");
  positiveInteger(options.blockSize, "scrypt blockSize");
  positiveInteger(options.parallelization, "scrypt parallelization");
  positiveInteger(options.keyLength, "scrypt keyLength");
  positiveInteger(options.saltLength, "scrypt saltLength");
  positiveInteger(options.maxmem, "scrypt maxmem");
  if ((options.cost & (options.cost - 1)) !== 0) {
    throw new Error("scrypt cost must be a power of two");
  }
  return options;
}

function deriveScrypt(
  password: string,
  salt: Buffer,
  options: Pick<PasswordHashOptions, "cost" | "blockSize" | "parallelization" | "keyLength" | "maxmem">,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    nodeScrypt(
      password,
      salt,
      options.keyLength,
      {
        N: options.cost,
        r: options.blockSize,
        p: options.parallelization,
        maxmem: options.maxmem,
      },
      (error, derivedKey) => {
        if (error) reject(error);
        else resolve(derivedKey);
      },
    );
  });
}

function safeStringEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected, "utf8");
  const suppliedBytes = Buffer.from(supplied, "utf8");
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function parsePasswordHash(encoded: string): {
  options: PasswordHashOptions;
  salt: Buffer;
  hash: Buffer;
} | null {
  const parts = encoded.split("$");
  if (parts.length !== 5 || parts[0] !== "" || parts[1] !== "scrypt") return null;
  const parameters = /^N=(\d+),r=(\d+),p=(\d+),l=(\d+)$/.exec(parts[2]);
  if (!parameters) return null;

  const cost = Number(parameters[1]);
  const blockSize = Number(parameters[2]);
  const parallelization = Number(parameters[3]);
  const keyLength = Number(parameters[4]);
  if (
    !Number.isSafeInteger(cost) || cost < 1_024 || cost > 131_072 || (cost & (cost - 1)) !== 0 ||
    !Number.isSafeInteger(blockSize) || blockSize < 1 || blockSize > 16 ||
    !Number.isSafeInteger(parallelization) || parallelization < 1 || parallelization > 8 ||
    !Number.isSafeInteger(keyLength) || keyLength < 16 || keyLength > 64
  ) {
    return null;
  }

  try {
    const salt = Buffer.from(parts[3], "base64url");
    const hash = Buffer.from(parts[4], "base64url");
    if (salt.length < 8 || salt.length > 64 || hash.length !== keyLength) return null;
    const requiredMemory = 128 * cost * blockSize + 2 * 1024 * 1024;
    return {
      options: {
        cost,
        blockSize,
        parallelization,
        keyLength,
        saltLength: salt.length,
        maxmem: Math.max(DEFAULT_SCRYPT_OPTIONS.maxmem, requiredMemory),
      },
      salt,
      hash,
    };
  } catch {
    return null;
  }
}

export function validateUsername(value: unknown): string {
  if (typeof value !== "string") {
    throw new AuthError("Username is required", 400, "INVALID_USERNAME");
  }
  const username = value.trim().normalize("NFKC");
  if (!USERNAME_PATTERN.test(username)) {
    throw new AuthError(
      "Username must be 3-32 characters and contain only letters, numbers, dot, underscore, or hyphen",
      400,
      "INVALID_USERNAME",
    );
  }
  return username;
}

export function normalizeUsername(value: unknown): string {
  return validateUsername(value).toLowerCase();
}

export function validateEmail(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    throw new AuthError("Email address is invalid", 400, "INVALID_EMAIL");
  }
  const email = value.trim().normalize("NFKC");
  if (
    email.length > 254 ||
    !EMAIL_PATTERN.test(email) ||
    email.startsWith(".") ||
    email.endsWith(".") ||
    /\.\./.test(email)
  ) {
    throw new AuthError("Email address is invalid", 400, "INVALID_EMAIL");
  }
  return email;
}

export function normalizeEmail(value: unknown): string | null {
  return validateEmail(value)?.toLowerCase() ?? null;
}

export function validatePassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new AuthError("Password is required", 400, "INVALID_PASSWORD");
  }
  const characters = Array.from(value).length;
  const bytes = Buffer.byteLength(value, "utf8");
  if (characters < 12 || characters > 128 || bytes > 512 || !/\S/u.test(value)) {
    throw new AuthError(
      "Password must contain 12-128 characters and at least one non-space character",
      400,
      "INVALID_PASSWORD",
    );
  }
  return value;
}

function validateLoginPassword(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Array.from(value).length > 128 ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new AuthError("Invalid username or password", 401, "INVALID_CREDENTIALS");
  }
  return value;
}

export async function hashPassword(
  rawPassword: unknown,
  inputOptions: Partial<PasswordHashOptions> = {},
): Promise<string> {
  const password = validatePassword(rawPassword);
  const options = resolvedPasswordOptions(inputOptions);
  const salt = randomBytes(options.saltLength);
  const hash = await deriveScrypt(password, salt, options);
  return [
    "",
    "scrypt",
    `N=${options.cost},r=${options.blockSize},p=${options.parallelization},l=${options.keyLength}`,
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyPassword(rawPassword: unknown, encoded: string): Promise<boolean> {
  let password: string;
  try {
    password = validateLoginPassword(rawPassword);
  } catch {
    return false;
  }
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return false;
  try {
    const actual = await deriveScrypt(password, parsed.salt, parsed.options);
    return actual.length === parsed.hash.length && timingSafeEqual(actual, parsed.hash);
  } catch {
    return false;
  }
}

export function needsPasswordRehash(
  encoded: string,
  inputOptions: Partial<PasswordHashOptions> = {},
): boolean {
  const parsed = parsePasswordHash(encoded);
  if (!parsed) return true;
  const desired = resolvedPasswordOptions(inputOptions);
  return (
    parsed.options.cost !== desired.cost ||
    parsed.options.blockSize !== desired.blockSize ||
    parsed.options.parallelization !== desired.parallelization ||
    parsed.options.keyLength !== desired.keyLength ||
    parsed.salt.length < desired.saltLength
  );
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function randomToken(prefix: string): string {
  return `${prefix}${randomBytes(32).toString("base64url")}`;
}

function hashMetadata(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? hashToken(normalized) : null;
}

export function parseCookieHeader(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) continue;
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    if (!name || Object.hasOwn(result, name)) continue;
    try {
      result[name] = decodeURIComponent(rawValue);
    } catch {
      result[name] = rawValue;
    }
  }
  return result;
}

export function serializeCookie(
  name: string,
  value: string,
  options: CookieSerializeOptions = {},
): string {
  if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) {
    throw new Error("Invalid cookie name");
  }
  const pieces = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) {
    pieces.push(`Max-Age=${Math.max(0, Math.floor(options.maxAge))}`);
  }
  if (options.expires) pieces.push(`Expires=${options.expires.toUTCString()}`);
  if (options.path) {
    if (!options.path.startsWith("/") || /[;\r\n]/.test(options.path)) {
      throw new Error("Invalid cookie path");
    }
    pieces.push(`Path=${options.path}`);
  }
  if (options.httpOnly) pieces.push("HttpOnly");
  if (options.secure) pieces.push("Secure");
  if (options.sameSite) pieces.push(`SameSite=${options.sameSite}`);
  return pieces.join("; ");
}

export function cookiePathFromAppBaseUrl(appBaseUrl: string | null | undefined): string {
  if (!appBaseUrl?.trim()) return "/";
  let url: URL;
  try {
    url = new URL(appBaseUrl);
  } catch {
    throw new Error("APP_BASE_URL must be an absolute HTTP(S) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use HTTP or HTTPS");
  }
  const trimmedPath = url.pathname.replace(/\/+$/, "");
  return trimmedPath || "/";
}

function mapUser(row: UserRow): AuthUser {
  return {
    id: row.id,
    username: row.username,
    email: row.email,
    status: row.status,
    role: row.role,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseScopes(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) && parsed.every((scope) => typeof scope === "string") ? parsed : [];
  } catch {
    return [];
  }
}

function mapApiToken(row: ApiTokenRow): ApiToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenPrefix: row.token_prefix,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
  };
}

function validDate(value: string): Date | null {
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function normalizeScopes(input: unknown): string[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > 32) {
    throw new AuthError("At least one valid API token scope is required", 400, "INVALID_TOKEN_SCOPES");
  }
  const scopes = [...new Set(input)];
  if (!scopes.every((scope): scope is string => typeof scope === "string" && SCOPE_PATTERN.test(scope))) {
    throw new AuthError("API token scopes are invalid", 400, "INVALID_TOKEN_SCOPES");
  }
  return scopes.sort();
}

export class AuthService {
  public readonly cookieName: string;
  public readonly cookiePath: string;
  public readonly secureCookie: boolean;

  private readonly passwordOptions: PasswordHashOptions;
  private readonly sessionIdleMs: number;
  private readonly sessionAbsoluteMs: number;
  private readonly touchIntervalMs: number;
  private readonly firstUserIsOwner: boolean;
  private readonly now: () => Date;

  public constructor(
    private readonly db: SqliteDatabase,
    options: AuthServiceOptions = {},
  ) {
    this.passwordOptions = resolvedPasswordOptions(options.passwordHash);
    this.sessionIdleMs = positiveInteger(
      options.sessionIdleMs ?? DEFAULT_SESSION_IDLE_MS,
      "sessionIdleMs",
    );
    this.sessionAbsoluteMs = positiveInteger(
      options.sessionAbsoluteMs ?? DEFAULT_SESSION_ABSOLUTE_MS,
      "sessionAbsoluteMs",
    );
    this.touchIntervalMs = positiveInteger(
      options.touchIntervalMs ?? DEFAULT_TOUCH_INTERVAL_MS,
      "touchIntervalMs",
    );
    if (this.sessionIdleMs > this.sessionAbsoluteMs) {
      throw new Error("sessionIdleMs must not exceed sessionAbsoluteMs");
    }
    this.firstUserIsOwner = options.firstUserIsOwner ?? true;
    this.now = options.now ?? (() => new Date());
    this.cookiePath = cookiePathFromAppBaseUrl(options.appBaseUrl ?? process.env.APP_BASE_URL);
    this.secureCookie = options.production ?? process.env.NODE_ENV === "production";
    this.cookieName = options.cookieName ?? (
      this.secureCookie ? "__Secure-northstar_session" : "northstar_session"
    );
    if (this.cookieName.startsWith("__Secure-") && !this.secureCookie) {
      throw new Error("Cookies with a __Secure- prefix require Secure mode");
    }
  }

  public async register(input: {
    username: unknown;
    email?: unknown;
    password: unknown;
  }): Promise<AuthUser> {
    const username = validateUsername(input.username);
    const usernameNormalized = username.toLowerCase();
    const email = validateEmail(input.email);
    const emailNormalized = email?.toLowerCase() ?? null;
    const passwordHash = await hashPassword(input.password, this.passwordOptions);
    const now = this.now().toISOString();
    const id = randomUUID();

    try {
      const insert = this.db.transaction(() => {
        const userCount = this.db.prepare(`
          SELECT COUNT(*) FROM users
          WHERE NOT (status = 'disabled' AND password_hash = 'disabled')
        `).pluck().get() as number;
        const role = this.firstUserIsOwner && userCount === 0 ? "owner" : "user";
        this.db.prepare(`
          INSERT INTO users (
            id, username, username_normalized, email, email_normalized,
            password_hash, status, role, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
        `).run(
          id,
          username,
          usernameNormalized,
          email,
          emailNormalized,
          passwordHash,
          role,
          now,
          now,
        );
        initializeUserSettings(this.db, id);
      });
      insert();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (/users\.username_normalized/i.test(message)) {
        throw new AuthError("Username is already registered", 409, "USERNAME_TAKEN");
      }
      if (/users\.email_normalized/i.test(message)) {
        throw new AuthError("Email is already registered", 409, "EMAIL_TAKEN");
      }
      throw error;
    }
    return this.getUser(id);
  }

  public getUser(userId: string): AuthUser {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!row) throw new AuthError("User not found", 404, "USER_NOT_FOUND");
    return mapUser(row);
  }

  public resolveLoginUserId(identifierInput: unknown): string | null {
    const identifier = typeof identifierInput === "string"
      ? identifierInput.trim().normalize("NFKC").toLowerCase()
      : "";
    if (identifier.length === 0 || identifier.length > 254) return null;
    const row = this.db.prepare(`
      SELECT id FROM users
      WHERE username_normalized = ? OR email_normalized = ?
      LIMIT 1
    `).get(identifier, identifier) as { id: string } | undefined;
    return row?.id ?? null;
  }

  public async authenticateCredentials(identifierInput: unknown, passwordInput: unknown): Promise<AuthUser | null> {
    const password = validateLoginPassword(passwordInput);
    const identifier = typeof identifierInput === "string"
      ? identifierInput.trim().normalize("NFKC").toLowerCase()
      : "";
    const validIdentifier = identifier.length > 0 && identifier.length <= 254;
    const row = validIdentifier
      ? this.db.prepare(`
          SELECT * FROM users
          WHERE username_normalized = ? OR email_normalized = ?
          LIMIT 1
        `).get(identifier, identifier) as UserRow | undefined
      : undefined;

    if (!row) {
      await deriveScrypt(password, DUMMY_PASSWORD_SALT, this.passwordOptions);
      return null;
    }
    const valid = await verifyPassword(password, row.password_hash);
    if (!valid || row.status !== "active") return null;

    if (needsPasswordRehash(row.password_hash, this.passwordOptions)) {
      const replacement = await hashPassword(password, this.passwordOptions);
      const updatedAt = this.now().toISOString();
      this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(replacement, updatedAt, row.id);
      row.password_hash = replacement;
      row.updated_at = updatedAt;
    }
    return mapUser(row);
  }

  public async login(
    input: { identifier: unknown; password: unknown },
    metadata: SessionMetadata = {},
  ): Promise<CreatedSession> {
    const user = await this.authenticateCredentials(input.identifier, input.password);
    if (!user) throw new AuthError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    return this.createSession(user.id, metadata);
  }

  public createSession(userId: string, metadata: SessionMetadata = {}): CreatedSession {
    const user = this.getUser(userId);
    if (user.status !== "active") {
      throw new AuthError("Invalid username or password", 401, "INVALID_CREDENTIALS");
    }
    const now = this.now();
    const absoluteExpiresAt = new Date(now.getTime() + this.sessionAbsoluteMs);
    const idleExpiresAt = new Date(
      Math.min(now.getTime() + this.sessionIdleMs, absoluteExpiresAt.getTime()),
    );
    const id = randomUUID();
    const token = randomToken("nss_");
    const csrfToken = randomToken("nsc_");
    const nowIso = now.toISOString();
    this.db.prepare(`
      INSERT INTO sessions (
        id, user_id, token_hash, csrf_token, created_at, last_seen_at,
        idle_expires_at, absolute_expires_at, revoked_at, user_agent_hash, ip_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
    `).run(
      id,
      user.id,
      hashToken(token),
      csrfToken,
      nowIso,
      nowIso,
      idleExpiresAt.toISOString(),
      absoluteExpiresAt.toISOString(),
      hashMetadata(metadata.userAgent),
      hashMetadata(metadata.ip),
    );
    return {
      token,
      user,
      session: {
        id,
        userId: user.id,
        csrfToken,
        createdAt: nowIso,
        lastSeenAt: nowIso,
        idleExpiresAt: idleExpiresAt.toISOString(),
        absoluteExpiresAt: absoluteExpiresAt.toISOString(),
      },
    };
  }

  public getSession(rawToken: string | null | undefined, touch = true): AuthenticatedSession | null {
    if (!rawToken || rawToken.length > 256) return null;
    const row = this.db.prepare(`
      SELECT
        u.*,
        s.id AS session_id,
        s.user_id,
        s.csrf_token,
        s.created_at AS session_created_at,
        s.last_seen_at,
        s.idle_expires_at,
        s.absolute_expires_at,
        s.revoked_at
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ?
      LIMIT 1
    `).get(hashToken(rawToken)) as SessionUserRow | undefined;
    if (!row || row.revoked_at || row.status !== "active") return null;

    const now = this.now();
    const idleExpiresAt = validDate(row.idle_expires_at);
    const absoluteExpiresAt = validDate(row.absolute_expires_at);
    if (
      !idleExpiresAt ||
      !absoluteExpiresAt ||
      idleExpiresAt.getTime() <= now.getTime() ||
      absoluteExpiresAt.getTime() <= now.getTime()
    ) {
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(now.toISOString(), row.session_id);
      return null;
    }

    let lastSeenAt = row.last_seen_at;
    let nextIdleExpiresAt = row.idle_expires_at;
    const previousSeen = validDate(row.last_seen_at);
    if (touch && (!previousSeen || now.getTime() - previousSeen.getTime() >= this.touchIntervalMs)) {
      lastSeenAt = now.toISOString();
      nextIdleExpiresAt = new Date(
        Math.min(now.getTime() + this.sessionIdleMs, absoluteExpiresAt.getTime()),
      ).toISOString();
      this.db.prepare(`
        UPDATE sessions
        SET last_seen_at = ?, idle_expires_at = ?
        WHERE id = ? AND revoked_at IS NULL
      `).run(lastSeenAt, nextIdleExpiresAt, row.session_id);
    }

    return {
      user: mapUser(row),
      session: {
        id: row.session_id,
        userId: row.user_id,
        csrfToken: row.csrf_token,
        createdAt: row.session_created_at,
        lastSeenAt,
        idleExpiresAt: nextIdleExpiresAt,
        absoluteExpiresAt: row.absolute_expires_at,
      },
    };
  }

  public requireCsrf(session: AuthSession, suppliedToken: string | null | undefined): void {
    if (!suppliedToken || !safeStringEqual(session.csrfToken, suppliedToken)) {
      throw new AuthError("CSRF token is invalid", 403, "INVALID_CSRF_TOKEN");
    }
  }

  public revokeSession(rawToken: string | null | undefined): boolean {
    if (!rawToken || rawToken.length > 256) return false;
    const result = this.db.prepare(`
      UPDATE sessions SET revoked_at = ?
      WHERE token_hash = ? AND revoked_at IS NULL
    `).run(this.now().toISOString(), hashToken(rawToken));
    return result.changes > 0;
  }

  public revokeAllSessions(userId: string, exceptSessionId?: string): number {
    const now = this.now().toISOString();
    const result = exceptSessionId
      ? this.db.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND id <> ? AND revoked_at IS NULL
        `).run(now, userId, exceptSessionId)
      : this.db.prepare(`
          UPDATE sessions SET revoked_at = ?
          WHERE user_id = ? AND revoked_at IS NULL
        `).run(now, userId);
    return result.changes;
  }

  public async changePassword(userId: string, currentPassword: unknown, newPassword: unknown): Promise<void> {
    const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId) as UserRow | undefined;
    if (!row || !await verifyPassword(currentPassword, row.password_hash)) {
      throw new AuthError("Current password is incorrect", 401, "INVALID_CREDENTIALS");
    }
    const passwordHash = await hashPassword(newPassword, this.passwordOptions);
    const update = this.db.transaction(() => {
      const now = this.now().toISOString();
      this.db.prepare("UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?")
        .run(passwordHash, now, userId);
      this.db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL")
        .run(now, userId);
    });
    update();
  }

  public sessionTokenFromCookie(cookieHeader: string | null | undefined): string | null {
    return parseCookieHeader(cookieHeader)[this.cookieName] ?? null;
  }

  public serializeSessionCookie(created: CreatedSession): string {
    const expires = new Date(created.session.absoluteExpiresAt);
    return serializeCookie(this.cookieName, created.token, {
      path: this.cookiePath,
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: "Lax",
      maxAge: Math.max(0, Math.floor((expires.getTime() - this.now().getTime()) / 1_000)),
      expires,
    });
  }

  public serializeClearedSessionCookie(): string {
    return serializeCookie(this.cookieName, "", {
      path: this.cookiePath,
      httpOnly: true,
      secure: this.secureCookie,
      sameSite: "Lax",
      maxAge: 0,
      expires: new Date(0),
    });
  }

  public createApiToken(userId: string, input: {
    name: unknown;
    scopes: unknown;
    expiresAt?: unknown;
  }): CreatedApiToken {
    const user = this.getUser(userId);
    if (user.status !== "active") throw new AuthError("User is disabled", 403, "USER_DISABLED");
    if (typeof input.name !== "string" || input.name.trim().length < 1 || input.name.trim().length > 80) {
      throw new AuthError("API token name is invalid", 400, "INVALID_TOKEN_NAME");
    }
    const name = input.name.trim();
    const scopes = normalizeScopes(input.scopes);
    const now = this.now();
    let expiresAt: string | null = null;
    if (input.expiresAt !== undefined && input.expiresAt !== null && input.expiresAt !== "") {
      if (typeof input.expiresAt !== "string") {
        throw new AuthError("API token expiry is invalid", 400, "INVALID_TOKEN_EXPIRY");
      }
      const parsed = validDate(input.expiresAt);
      if (!parsed || parsed.getTime() <= now.getTime()) {
        throw new AuthError("API token expiry must be in the future", 400, "INVALID_TOKEN_EXPIRY");
      }
      expiresAt = parsed.toISOString();
    }

    const id = randomUUID();
    const token = randomToken("nsat_");
    const tokenPrefix = token.slice(0, 17);
    this.db.prepare(`
      INSERT INTO api_tokens (
        id, user_id, name, token_hash, token_prefix, scopes_json,
        created_at, last_used_at, expires_at, revoked_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)
    `).run(
      id,
      userId,
      name,
      hashToken(token),
      tokenPrefix,
      JSON.stringify(scopes),
      now.toISOString(),
      expiresAt,
    );
    return {
      token,
      apiToken: {
        id,
        userId,
        name,
        tokenPrefix,
        scopes,
        createdAt: now.toISOString(),
        lastUsedAt: null,
        expiresAt,
        revokedAt: null,
      },
    };
  }

  public authenticateApiToken(
    rawToken: string | null | undefined,
    requiredScopes: string[] = [],
  ): ApiTokenPrincipal | null {
    if (!rawToken || rawToken.length > 256) return null;
    const row = this.db.prepare(`
      SELECT t.*
      FROM api_tokens t
      JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ? AND u.status = 'active'
      LIMIT 1
    `).get(hashToken(rawToken)) as ApiTokenRow | undefined;
    if (!row || row.revoked_at) return null;
    const expiresAt = row.expires_at ? validDate(row.expires_at) : null;
    const now = this.now();
    if (row.expires_at && (!expiresAt || expiresAt.getTime() <= now.getTime())) return null;

    const apiToken = mapApiToken(row);
    if (!requiredScopes.every((scope) => apiToken.scopes.includes(scope))) return null;
    const lastUsed = row.last_used_at ? validDate(row.last_used_at) : null;
    if (!lastUsed || now.getTime() - lastUsed.getTime() >= this.touchIntervalMs) {
      const lastUsedAt = now.toISOString();
      this.db.prepare("UPDATE api_tokens SET last_used_at = ? WHERE id = ? AND revoked_at IS NULL")
        .run(lastUsedAt, row.id);
      apiToken.lastUsedAt = lastUsedAt;
    }
    return { token: apiToken, user: this.getUser(row.user_id) };
  }

  public requireApiTokenScopes(
    principal: ApiTokenPrincipal,
    requiredScopes: readonly string[],
  ): void {
    if (!requiredScopes.every((scope) => principal.token.scopes.includes(scope))) {
      throw new AuthError(
        "API token does not have the required scope",
        403,
        "INSUFFICIENT_TOKEN_SCOPE",
      );
    }
  }

  public listApiTokens(userId: string): ApiToken[] {
    this.getUser(userId);
    return (this.db.prepare(`
      SELECT * FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC
    `).all(userId) as ApiTokenRow[]).map(mapApiToken);
  }

  public revokeApiToken(userId: string, tokenId: string): boolean {
    const result = this.db.prepare(`
      UPDATE api_tokens SET revoked_at = ?
      WHERE id = ? AND user_id = ? AND revoked_at IS NULL
    `).run(this.now().toISOString(), tokenId, userId);
    return result.changes > 0;
  }
}
