import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError, type ZodType } from "zod";
import {
  DEFAULT_OWNER_ID,
  getBootstrapUserId,
  openDatabase,
  type SqliteDatabase,
} from "./db/database";
import type { AIProvider } from "./providers/ai";
import { createApplicationAIProviderFromEnv } from "./providers/aiFactory";
import {
  createPriceProviderFromEnv,
  PriceProviderError,
  type PriceProvider,
} from "./providers/price";
import {
  aiCommandBatchSchema,
  AICommandService,
  getAICommandCapabilities,
  getAICommandRequiredScopes,
} from "./services/aiCommands";
import {
  AuthError,
  AuthService,
  type AuthenticatedSession,
  type ApiTokenPrincipal,
} from "./services/auth";
import { SmtpEmailOutbox, type EmailOutbox } from "./services/email";
import { MonitorService } from "./services/monitor";
import { DomainError, FinanceRepository } from "./services/repository";
import { calculateNextRunAt, PersistentScheduler } from "./services/scheduler";
import {
  assetCreateSchema,
  assetPatchSchema,
  entityId,
  eventCreateSchema,
  eventPatchSchema,
  expectedConvertSchema,
  expectedCreateSchema,
  expectedPatchSchema,
  nonNegativeDecimalString,
  operationCreateSchema,
  priceUpdateSchema,
  settingsPatchSchema,
} from "./validation";

export interface CreateAppOptions {
  db?: SqliteDatabase;
  databasePath?: string;
  seed?: boolean;
  aiProvider?: AIProvider;
  priceProvider?: PriceProvider;
  emailOutbox?: EmailOutbox;
  serveStatic?: boolean;
  staticPath?: string;
  schedulerPollMs?: number;
  appBaseUrl?: string | null;
  registrationMode?: "open" | "closed";
  authService?: AuthService;
  disableAuthenticationForTests?: boolean;
}

export interface FinanceRuntime {
  db: SqliteDatabase;
  authService: AuthService;
  repository: FinanceRepository;
  aiProvider: AIProvider;
  priceProvider: PriceProvider;
  emailOutbox: EmailOutbox;
  monitorService: MonitorService;
  commandService: AICommandService;
  scheduler: PersistentScheduler;
  close(): void;
}

export type FinanceApp = Express & { finance: FinanceRuntime };

function data<T>(value: T, message?: string) {
  return message === undefined ? { data: value } : { data: value, message };
}

function parse<T>(schema: ZodType<T>, value: unknown): T {
  return schema.parse(value);
}

function asyncRoute(
  handler: (request: Request, response: Response, next: NextFunction) => Promise<void>,
) {
  return (request: Request, response: Response, next: NextFunction) => {
    void handler(request, response, next).catch(next);
  };
}

async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  const workerCount = Math.min(concurrency, items.length);

  await Promise.all(Array.from({ length: workerCount }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index]);
    }
  }));

  return results;
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

function batchPriceError(error: unknown): { code: string; message: string } {
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

interface RequestServices {
  session?: AuthenticatedSession;
  apiPrincipal?: ApiTokenPrincipal;
  repository: FinanceRepository;
  emailOutbox: EmailOutbox;
  monitorService: MonitorService;
  commandService: AICommandService;
}

function services(response: Response): RequestServices {
  const value = response.locals.finance as RequestServices | undefined;
  if (!value) throw new Error("Authenticated request services are unavailable");
  return value;
}

function bearerToken(request: Request): string {
  const authorization = request.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  return match?.[1]?.trim() ?? "";
}

function requestOrigin(request: Request): string {
  return `${request.protocol}://${request.get("host") ?? ""}`;
}

function assertSameOrigin(request: Request, configuredOrigin: string): void {
  const suppliedOrigin = request.header("origin") ?? "";
  const expectedOrigin = configuredOrigin || requestOrigin(request);
  if (!suppliedOrigin || suppliedOrigin !== expectedOrigin) {
    throw new AuthError("Request origin is invalid", 403, "INVALID_ORIGIN");
  }
}

class FixedWindowRateLimiter {
  private readonly entries = new Map<string, { count: number; resetAt: number }>();

  public constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  public consume(key: string): void {
    const now = Date.now();
    const existing = this.entries.get(key);
    if (!existing || existing.resetAt <= now) {
      this.entries.set(key, { count: 1, resetAt: now + this.windowMs });
    } else if (existing.count >= this.limit) {
      throw new AuthError("Too many authentication attempts; try again later", 429, "RATE_LIMITED");
    } else {
      existing.count += 1;
    }

    if (this.entries.size > 10_000) {
      for (const [entryKey, entry] of this.entries) {
        if (entry.resetAt <= now) this.entries.delete(entryKey);
      }
    }
  }
}

class PersistentLoginFailureLimiter {
  public constructor(
    private readonly db: SqliteDatabase,
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  private purgeExpired(now: number): void {
    this.db.prepare("DELETE FROM auth_account_limits WHERE reset_at <= ?").run(now);
  }

  public delayMs(userId: string): number {
    const now = Date.now();
    this.purgeExpired(now);
    const existing = this.db.prepare(`
      SELECT attempts FROM auth_account_limits WHERE user_id = ?
    `).get(userId) as { attempts: number } | undefined;
    if (!existing || existing.attempts < this.limit) return 0;
    return Math.min(2_000, (existing.attempts - this.limit + 1) * 250);
  }

  public recordFailure(userId: string): number {
    const now = Date.now();
    this.db.transaction(() => {
      this.purgeExpired(now);
      const existing = this.db.prepare(`
        SELECT attempts FROM auth_account_limits WHERE user_id = ?
      `).get(userId) as { attempts: number } | undefined;
      if (existing) {
        this.db.prepare(`
          UPDATE auth_account_limits
          SET attempts = MIN(attempts + 1, 1000)
          WHERE user_id = ?
        `).run(userId);
        return;
      }
      this.db.prepare(`
        INSERT INTO auth_account_limits (user_id, attempts, reset_at)
        VALUES (?, 1, ?)
      `).run(userId, now + this.windowMs);
    })();
    return (this.db.prepare("SELECT attempts FROM auth_account_limits WHERE user_id = ?")
      .pluck().get(userId) as number | undefined) ?? 0;
  }

  public reset(userId: string): void {
    this.db.prepare("DELETE FROM auth_account_limits WHERE user_id = ?").run(userId);
  }
}

function normalizeLoginIdentifier(value: unknown): string {
  return typeof value === "string"
    ? value.trim().normalize("NFKC").toLowerCase()
    : "invalid";
}

function unknownLoginKey(identifier: string): string {
  return createHash("sha256").update(identifier).digest("hex");
}

function waitFor(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function resolvePublicAICommandEndpoint(appBaseUrl: string): string {
  if (!appBaseUrl) return "/api/ai/commands/execute";

  const baseUrl = new URL(appBaseUrl);
  if (baseUrl.protocol !== "http:" && baseUrl.protocol !== "https:") {
    throw new Error("APP_BASE_URL must use http or https");
  }
  baseUrl.search = "";
  baseUrl.hash = "";
  if (!baseUrl.pathname.endsWith("/")) baseUrl.pathname += "/";
  return new URL("api/ai/commands/execute", baseUrl).toString();
}

export function createApp(options: CreateAppOptions = {}): FinanceApp {
  const production = process.env.NODE_ENV === "production";
  const appBaseUrl = options.appBaseUrl ?? process.env.APP_BASE_URL?.trim() ?? "";
  const configuredOrigin = appBaseUrl ? new URL(appBaseUrl).origin : "";
  const publicAICommandEndpoint = resolvePublicAICommandEndpoint(appBaseUrl);
  const registrationMode = options.registrationMode
    ?? process.env.REGISTRATION_MODE?.trim()
    ?? (production ? "closed" : "open");
  if (registrationMode !== "open" && registrationMode !== "closed") {
    throw new Error("REGISTRATION_MODE must be open or closed");
  }
  const authenticationDisabled = options.disableAuthenticationForTests === true;
  if (authenticationDisabled && process.env.NODE_ENV !== "test") {
    throw new Error("disableAuthenticationForTests is only available while NODE_ENV=test");
  }
  const ownsDatabase = options.db === undefined;
  const registrationLimiter = new FixedWindowRateLimiter(5, 60 * 60 * 1_000);
  const loginIpLimiter = new FixedWindowRateLimiter(20, 15 * 60 * 1_000);
  const db = options.db ?? openDatabase({ path: options.databasePath, seed: options.seed });
  const loginAccountLimiter = new PersistentLoginFailureLimiter(db, 5, 15 * 60 * 1_000);
  const unknownLoginLimiter = new FixedWindowRateLimiter(5, 15 * 60 * 1_000);
  const defaultOwnerId = getBootstrapUserId(db) ?? DEFAULT_OWNER_ID;
  const repository = new FinanceRepository(db, defaultOwnerId);
  const authService = options.authService ?? new AuthService(db, {
    appBaseUrl,
    production,
    firstUserIsOwner: !production,
  });
  // AI credentials and runtime selection are deployment-global. Every tenant uses
  // the same isolated worker, while research results remain scoped by repository.
  const aiProvider = options.aiProvider ?? createApplicationAIProviderFromEnv();
  const priceProvider = options.priceProvider ?? createPriceProviderFromEnv();
  const runPriceQuote = createAsyncLimiter(4);
  const emailOutboxFor = (ownerRepository: FinanceRepository) =>
    options.emailOutbox ?? new SmtpEmailOutbox(db, ownerRepository);
  const emailOutbox = emailOutboxFor(repository);
  const monitorServiceFor = (ownerRepository: FinanceRepository) =>
    new MonitorService(
      db,
      ownerRepository,
      aiProvider,
      emailOutboxFor(ownerRepository),
    );
  const monitorService = monitorServiceFor(repository);
  const commandService = new AICommandService(db, repository);
  const scheduler = new PersistentScheduler(
    db,
    (ownerId) => monitorServiceFor(new FinanceRepository(db, ownerId)),
    (ownerId) => emailOutboxFor(new FinanceRepository(db, ownerId)),
    options.schedulerPollMs,
  );

  const createRequestServices = (
    ownerId: string,
    identity: Pick<RequestServices, "session" | "apiPrincipal"> = {},
  ): RequestServices => {
    const ownerRepository = new FinanceRepository(db, ownerId);
    const ownerEmailOutbox = emailOutboxFor(ownerRepository);
    return {
      ...identity,
      repository: ownerRepository,
      emailOutbox: ownerEmailOutbox,
      monitorService: new MonitorService(
        db,
        ownerRepository,
        aiProvider,
        ownerEmailOutbox,
      ),
      commandService: new AICommandService(db, ownerRepository),
    };
  };

  const app = express() as FinanceApp;
  app.finance = {
    db,
    authService,
    repository,
    aiProvider,
    priceProvider,
    emailOutbox,
    monitorService,
    commandService,
    scheduler,
    close: () => {
      scheduler.stop();
      if (ownsDatabase && db.open) db.close();
    },
  };

  app.disable("x-powered-by");
  // The production container only listens behind the host's loopback reverse proxy.
  app.set("trust proxy", 1);
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/api/health", (_request, response, next) => {
    try {
      const result = db.prepare("SELECT 1 AS ok").get() as { ok: number };
      const ready = result.ok === 1;
      const health = {
        status: ready ? "ok" : "degraded",
        database: { status: result.ok === 1 ? "ok" : "error" },
        authentication: {
          status: "ok",
          registration: registrationMode,
        },
        timestamp: new Date().toISOString(),
      };
      response.status(ready ? 200 : 503).json(data(health));
    } catch (error) {
      next(error);
    }
  });

  const sessionPayload = (authenticated: AuthenticatedSession) => ({
    authenticated: true as const,
    user: authenticated.user,
    csrfToken: authenticated.session.csrfToken,
  });
  const setSessionCookie = (response: Response, created: ReturnType<AuthService["createSession"]>) => {
    response.setHeader("Set-Cookie", authService.serializeSessionCookie(created));
  };
  const sessionMetadata = (request: Request) => ({
    userAgent: request.header("user-agent"),
    ip: request.ip,
  });

  app.get("/api/auth/session", (request, response) => {
    const token = authService.sessionTokenFromCookie(request.header("cookie"));
    const authenticated = authService.getSession(token);
    if (!authenticated) {
      response.json(data({ authenticated: false as const }));
      return;
    }
    response.json(data(sessionPayload(authenticated)));
  });

  app.post("/api/auth/register", asyncRoute(async (request, response) => {
    assertSameOrigin(request, configuredOrigin);
    registrationLimiter.consume(request.ip || "unknown");
    if (registrationMode !== "open") {
      throw new AuthError("Registration is currently closed", 403, "REGISTRATION_CLOSED");
    }
    const user = await authService.register({
      username: request.body?.username,
      email: request.body?.email,
      password: request.body?.password,
    }, { requireApproval: true });
    response.status(202).json(data({
      approvalRequired: true as const,
      user,
    }, "Registration submitted for approval"));
  }));

  app.post("/api/auth/login", asyncRoute(async (request, response) => {
    assertSameOrigin(request, configuredOrigin);
    const clientIp = request.ip || "unknown";
    const identifier = normalizeLoginIdentifier(request.body?.identifier);
    loginIpLimiter.consume(clientIp);
    const accountId = authService.resolveLoginUserId(request.body?.identifier);
    if (accountId) {
      const delay = loginAccountLimiter.delayMs(accountId);
      if (delay > 0) await waitFor(delay);
    }
    let created: ReturnType<AuthService["createSession"]>;
    try {
      const user = await authService.authenticateCredentials(
        request.body?.identifier,
        request.body?.password,
      );
      if (!user) throw new AuthError("Invalid username or password", 401, "INVALID_CREDENTIALS");
      if (accountId) loginAccountLimiter.reset(accountId);
      created = authService.createSession(user.id, sessionMetadata(request));
    } catch (error) {
      if (!(error instanceof AuthError) || error.code !== "INVALID_CREDENTIALS") throw error;
      if (accountId) {
        const attempts = loginAccountLimiter.recordFailure(accountId);
        if (attempts > 5) {
          throw new AuthError("Too many authentication attempts; try again later", 429, "RATE_LIMITED");
        }
      } else {
        unknownLoginLimiter.consume(unknownLoginKey(identifier));
      }
      throw error;
    }
    setSessionCookie(response, created);
    response.json(data(sessionPayload(created), "Signed in"));
  }));

  app.post("/api/auth/logout", (request, response) => {
    assertSameOrigin(request, configuredOrigin);
    const token = authService.sessionTokenFromCookie(request.header("cookie"));
    const authenticated = authService.getSession(token, false);
    if (!authenticated) throw new AuthError("Sign in is required", 401, "UNAUTHENTICATED");
    authService.requireCsrf(authenticated.session, request.header("x-csrf-token"));
    authService.revokeSession(token);
    response.setHeader("Set-Cookie", authService.serializeClearedSessionCookie());
    response.json(data({ loggedOut: true as const }, "Signed out"));
  });

  app.use("/api/ai", (request, response, next) => {
    if (authenticationDisabled) {
      response.locals.finance = createRequestServices(DEFAULT_OWNER_ID);
      next();
      return;
    }
    const principal = authService.authenticateApiToken(bearerToken(request));
    if (!principal) {
      response.status(401).json({
        error: { code: "UNAUTHORIZED", message: "A valid user API bearer token is required" },
      });
      return;
    }
    response.locals.finance = createRequestServices(principal.user.id, { apiPrincipal: principal });
    next();
  });

  app.get("/api/ai/capabilities", (_request, response) => {
    const principal = services(response).apiPrincipal;
    if (principal) authService.requireApiTokenScopes(principal, ["ai:read"]);
    response.json(data({
      ...getAICommandCapabilities(publicAICommandEndpoint),
      authentication: "bearer-user-token",
    }));
  });

  app.post("/api/ai/commands/execute", (request, response) => {
    const requestServices = services(response);
    const input = parse(aiCommandBatchSchema, request.body);
    if (requestServices.apiPrincipal) {
      authService.requireApiTokenScopes(requestServices.apiPrincipal, [
        "finance:write",
        ...getAICommandRequiredScopes(input),
      ]);
    }
    const result = requestServices.commandService.execute(input);
    const status = result.status === "failed" ? 409 : result.replayed ? 200 : 201;
    response.status(status).json(data(result));
  });

  app.use("/api", (request, response, next) => {
    if (authenticationDisabled) {
      response.locals.finance = createRequestServices(DEFAULT_OWNER_ID);
      next();
      return;
    }
    const token = authService.sessionTokenFromCookie(request.header("cookie"));
    const authenticated = authService.getSession(token);
    if (!authenticated) {
      response.status(401).json({
        error: { code: "UNAUTHENTICATED", message: "Sign in is required" },
      });
      return;
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
      assertSameOrigin(request, configuredOrigin);
      authService.requireCsrf(authenticated.session, request.header("x-csrf-token"));
    }
    response.locals.finance = createRequestServices(authenticated.user.id, {
      session: authenticated,
    });
    next();
  });

  const ownerId = (response: Response): string => {
    const authenticated = services(response).session;
    if (!authenticated) throw new AuthError("Sign in is required", 401, "UNAUTHENTICATED");
    return authenticated.user.id;
  };

  app.get("/api/admin/registrations", (_request, response) => {
    response.json(data(authService.listPendingRegistrations(ownerId(response))));
  });

  app.post("/api/admin/registrations/:id/approve", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(
      authService.approveRegistration(ownerId(response), id),
      "Registration approved",
    ));
  });

  app.post("/api/admin/registrations/:id/reject", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(
      authService.rejectRegistration(ownerId(response), id),
      "Registration rejected",
    ));
  });

  app.get("/api/account/api-tokens", (_request, response) => {
    const authenticated = services(response).session;
    if (!authenticated) throw new AuthError("Sign in is required", 401, "UNAUTHENTICATED");
    response.json(data(authService.listApiTokens(authenticated.user.id)));
  });

  app.post("/api/account/api-tokens", (request, response) => {
    const authenticated = services(response).session;
    if (!authenticated) throw new AuthError("Sign in is required", 401, "UNAUTHENTICATED");
    const created = authService.createApiToken(authenticated.user.id, {
      name: request.body?.name,
      scopes: request.body?.scopes,
      expiresAt: request.body?.expiresAt,
    });
    response.status(201).json(data(created, "API token created"));
  });

  app.delete("/api/account/api-tokens/:id", (request, response) => {
    const authenticated = services(response).session;
    if (!authenticated) throw new AuthError("Sign in is required", 401, "UNAUTHENTICATED");
    const id = parse(entityId, request.params.id);
    if (!authService.revokeApiToken(authenticated.user.id, id)) {
      throw new AuthError("API token not found", 404, "API_TOKEN_NOT_FOUND");
    }
    response.json(data({ id, revoked: true }, "API token revoked"));
  });

  app.get("/api/dashboard", (_request, response) => {
    response.json(data(services(response).repository.getDashboard()));
  });

  app.get("/api/assets", (request, response) => {
    const kind = typeof request.query.kind === "string" ? request.query.kind : undefined;
    const assets = services(response).repository
      .listAssets()
      .filter((asset) => kind === undefined || asset.kind === kind);
    response.json(data(assets));
  });

  app.post("/api/assets/prices/refresh", asyncRoute(async (_request, response) => {
    const ownerRepository = services(response).repository;
    const assets = ownerRepository.listAssets();
    const providerAssets = assets.filter((asset) => asset.priceMode === "provider");
    const skipped = assets
      .filter((asset) => asset.priceMode !== "provider")
      .map((asset) => ({
        id: asset.id,
        name: asset.name,
        reason: "PRICE_MODE_MANUAL" as const,
      }));

    const outcomes = priceProvider.id === "manual"
      ? providerAssets.map((asset) => ({
          status: "failed" as const,
          value: {
            id: asset.id,
            name: asset.name,
            error: {
              code: "PRICE_PROVIDER_DISABLED",
              message: "Price provider is disabled",
            },
          },
        }))
      : await mapWithConcurrency(providerAssets, 4, async (asset) => {
          try {
            // No database transaction spans this network request. The guarded
            // repository write records the quote only if the asset is unchanged.
            const quote = await runPriceQuote(() => priceProvider.getQuote(asset));
            quote.price = nonNegativeDecimalString.parse(quote.price);
            const updated = ownerRepository.updateProviderPrice(asset.id, asset.version, quote);
            return {
              status: "updated" as const,
              value: {
                id: updated.id,
                name: updated.name,
                currentPrice: updated.currentPrice,
                currency: updated.currency,
                source: updated.priceSource,
                priceUpdatedAt: updated.priceUpdatedAt,
              },
            };
          } catch (error) {
            return {
              status: "failed" as const,
              value: {
                id: asset.id,
                name: asset.name,
                error: batchPriceError(error),
              },
            };
          }
        });
    const updated = outcomes
      .filter((outcome): outcome is Extract<typeof outcome, { status: "updated" }> =>
        outcome.status === "updated")
      .map((outcome) => outcome.value);
    const failed = outcomes
      .filter((outcome): outcome is Extract<typeof outcome, { status: "failed" }> =>
        outcome.status === "failed")
      .map((outcome) => outcome.value);

    response.json(data({ updated, skipped, failed }, "Asset prices refreshed"));
  }));

  app.post("/api/assets", (request, response) => {
    const input = parse(assetCreateSchema, request.body);
    response.status(201).json(data(services(response).repository.createAsset(input), "Asset created"));
  });

  app.get("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.getAsset(id)));
  });

  app.patch("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(assetPatchSchema, request.body);
    response.json(data(services(response).repository.updateAsset(id, input), "Asset updated"));
  });

  app.delete("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    services(response).repository.deleteAsset(id);
    response.json(data({ id, deleted: true }, "Asset deleted"));
  });

  app.get("/api/assets/:id/operations", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.listOperations(id)));
  });

  app.post("/api/assets/:id/operations", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(operationCreateSchema, request.body);
    response.status(201).json(
      data(services(response).repository.recordOperation(id, input), "Operation recorded"),
    );
  });

  app.get("/api/assets/:id/price", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.listPrices(id)));
  });

  const updatePriceHandler = asyncRoute(async (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(priceUpdateSchema, request.body ?? {});
    const ownerRepository = services(response).repository;
    const asset = ownerRepository.getAsset(id);
    const quote = input.price
      ? {
          price: input.price,
          currency: input.currency ?? asset.currency,
          source: input.source ?? "manual",
          asOf: input.asOf ?? new Date().toISOString(),
          raw: { enteredManually: true },
        }
      : await priceProvider.getQuote(asset);
    quote.price = nonNegativeDecimalString.parse(quote.price);
    response.json(data(ownerRepository.updatePrice(id, quote), "Price updated"));
  });
  app.post("/api/assets/:id/price", updatePriceHandler);
  app.patch("/api/assets/:id/price", updatePriceHandler);

  app.get("/api/expected", (request, response) => {
    const stage = typeof request.query.stage === "string" ? request.query.stage : undefined;
    const assets = services(response).repository
      .listExpectedAssets()
      .filter((asset) => stage === undefined || asset.stage === stage);
    response.json(data(assets));
  });

  app.post("/api/expected", (request, response) => {
    const input = parse(expectedCreateSchema, request.body);
    response.status(201).json(
      data(services(response).repository.createExpectedAsset(input), "Expected asset created"),
    );
  });

  app.get("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.getExpectedAsset(id)));
  });

  app.patch("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(expectedPatchSchema, request.body);
    response.json(
      data(services(response).repository.updateExpectedAsset(id, input), "Expected asset updated"),
    );
  });

  app.delete("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    services(response).repository.deleteExpectedAsset(id);
    response.json(data({ id, deleted: true }, "Expected asset deleted"));
  });

  app.get("/api/expected/:id/updates", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.listExpectedUpdates(id)));
  });

  app.get("/api/expected/:id/runs", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.listExpectedRuns(id)));
  });

  app.post(
    "/api/expected/:id/check",
    asyncRoute(async (request, response) => {
      const id = parse(entityId, request.params.id);
      const requestServices = services(response);
      const run = await requestServices.monitorService.runExpectedCheck(id);
      response.json(data({
        expected: requestServices.repository.getExpectedAsset(id),
        run,
      }, "Expected asset checked"));
    }),
  );

  app.post("/api/expected/:id/convert", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(expectedConvertSchema, request.body);
    const ownerRepository = services(response).repository;
    const expected = ownerRepository.getExpectedAsset(id);
    if (expected.linkedAssetId) {
      throw new DomainError("Expected asset has already been converted", 409, "ALREADY_CONVERTED");
    }
    const convert = db.transaction(() => {
      const asset = ownerRepository.createAsset({
        name: input.name ?? expected.name,
        symbol: input.symbol,
        kind: input.kind,
        account: input.account,
        currency: input.currency ?? expected.currency,
        quantity: "0",
        unitCost: input.unitCost,
        currentPrice: input.currentPrice,
        priceMode: input.priceMode,
        priceSource: input.priceSource,
        staleAfterHours: 24,
        notes: [input.notes, `Converted from expected asset ${expected.id}`].filter(Boolean).join("\n"),
      });
      ownerRepository.recordOperation(asset.id, {
        type: "claim",
        quantity: input.quantity,
        unitPrice: input.unitCost,
        fee: "0",
        currency: input.currency ?? expected.currency,
        note: `Claimed from ${expected.name}`,
        idempotencyKey: `expected-convert:${expected.id}`,
      });
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE expected_assets
        SET stage = 'claimed', health = 'healthy', linked_asset_id = ?,
            latest_update = ?, version = version + 1, updated_at = ?
        WHERE owner_id = ? AND id = ?
      `).run(
        asset.id,
        `Converted to holding ${asset.symbol}`,
        now,
        ownerRepository.ownerId,
        expected.id,
      );
      return ownerRepository.getAsset(asset.id);
    });
    response.status(201).json(
      data({ asset: convert(), expected: ownerRepository.getExpectedAsset(id) }, "Converted to direct asset"),
    );
  });

  app.get("/api/events", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const events = services(response).repository
      .listEvents()
      .filter((event) => status === undefined || event.status === status);
    response.json(data(events));
  });

  app.post("/api/events", (request, response) => {
    const input = parse(eventCreateSchema, request.body);
    const nextRunAt = calculateNextRunAt(input.schedule, input.timezone);
    response.status(201).json(
      data(services(response).repository.createEvent(input, nextRunAt), "Tracked event created"),
    );
  });

  app.get("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.getEvent(id)));
  });

  app.patch("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(eventPatchSchema, request.body);
    const ownerRepository = services(response).repository;
    const current = ownerRepository.getEvent(id);
    let nextRunAt: string | null | undefined;
    if (
      input.schedule !== undefined ||
      input.timezone !== undefined ||
      (input.status === "active" && current.status !== "active")
    ) {
      nextRunAt = calculateNextRunAt(
        input.schedule ?? current.schedule,
        input.timezone ?? current.timezone,
      );
    }
    response.json(data(ownerRepository.updateEvent(id, input, nextRunAt), "Tracked event updated"));
  });

  app.delete("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    services(response).repository.deleteEvent(id);
    response.json(data({ id, deleted: true }, "Tracked event deleted"));
  });

  app.post(
    "/api/events/:id/run",
    asyncRoute(async (request, response) => {
      const id = parse(entityId, request.params.id);
      const run = await services(response).monitorService.runEvent(id);
      response.status(201).json(data(run, "Event run completed"));
    }),
  );

  app.get("/api/events/:id/runs", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.listEventRuns(id)));
  });

  app.get("/api/runs/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(services(response).repository.getRun(id)));
  });

  app.get("/api/settings", (_request, response) => {
    response.json(data(services(response).repository.getSettings()));
  });

  app.patch("/api/settings", (request, response) => {
    const input = parse(settingsPatchSchema, request.body);
    const authenticated = services(response).session;
    const deploymentOnlyKeys = ["aiProvider", "aiBaseUrl", "aiModel"] as const;
    const ownerOnlyKeys = ["proxyUrl", ...deploymentOnlyKeys] as const;
    if (
      authenticated &&
      authenticated.user.role !== "owner" &&
      ownerOnlyKeys.some((key) => input[key] !== undefined)
    ) {
      throw new AuthError(
        "Only the application owner can change connection settings",
        403,
        "OWNER_REQUIRED",
      );
    }
    if (deploymentOnlyKeys.some((key) => input[key] !== undefined)) {
      throw new DomainError(
        "AI runtime settings are managed by the deployment environment",
        409,
        "DEPLOYMENT_SETTING",
      );
    }
    response.json(data(services(response).repository.updateSettings(input), "Settings saved"));
  });

  const testConnection = async (kind: string, response: Response) => {
    const requestServices = services(response);
    if (requestServices.session && requestServices.session.user.role !== "owner") {
      throw new AuthError(
        "Only the application owner can test server connections",
        403,
        "OWNER_REQUIRED",
      );
    }
    if (kind === "ai") return aiProvider.testConnection();
    if (kind === "price") return priceProvider.testConnection();
    if (kind === "email" || kind === "smtp") return requestServices.emailOutbox.testConnection();
    throw new DomainError("Unknown connection type", 404, "CONNECTION_TYPE_NOT_FOUND");
  };
  app.post(
    "/api/settings/connections/:kind/test",
    asyncRoute(async (request, response) => {
      const rawKind = request.params.kind;
      const result = await testConnection(
        Array.isArray(rawKind) ? rawKind[0] ?? "" : rawKind,
        response,
      );
      response.status(result.ok ? 200 : result.status === "failed" ? 502 : 409).json(data(result));
    }),
  );
  for (const kind of ["ai", "price", "email"] as const) {
    app.post(
      `/api/settings/test-${kind}`,
      asyncRoute(async (_request, response) => {
        const result = await testConnection(kind, response);
        response.status(result.ok ? 200 : result.status === "failed" ? 502 : 409).json(data(result));
      }),
    );
  }

  const shouldServeStatic = options.serveStatic ?? production;
  const staticPath = resolve(options.staticPath ?? "dist");
  if (shouldServeStatic && existsSync(staticPath)) {
    app.use(express.static(staticPath, { index: false }));
    app.use((request, response, next) => {
      if (
        request.method === "GET" &&
        !request.path.startsWith("/api/") &&
        request.accepts("html")
      ) {
        response.sendFile(resolve(staticPath, "index.html"));
        return;
      }
      next();
    });
  }

  app.use("/api", (_request, response) => {
    response.status(404).json({ error: { code: "NOT_FOUND", message: "API route not found" } });
  });

  const errorHandler: ErrorRequestHandler = (error, _request, response, _next) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: {
          code: "VALIDATION_ERROR",
          message: "Request validation failed",
          issues: error.issues,
        },
      });
      return;
    }
    if (error instanceof AuthError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    if (error instanceof PriceProviderError) {
      response.status(error.status).json({
        error: { code: error.code, message: error.message },
      });
      return;
    }
    if (error instanceof SyntaxError && "body" in error) {
      response.status(400).json({ error: { code: "INVALID_JSON", message: "Request body is not valid JSON" } });
      return;
    }
    const message = error instanceof Error ? error.message : "Internal server error";
    if (/UNIQUE constraint failed/i.test(message)) {
      response.status(409).json({ error: { code: "CONFLICT", message } });
      return;
    }
    if (/FOREIGN KEY constraint failed/i.test(message)) {
      response.status(409).json({ error: { code: "REFERENCE_CONFLICT", message } });
      return;
    }
    console.error(error);
    response.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  };
  app.use(errorHandler);

  return app;
}
