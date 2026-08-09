import express, {
  type ErrorRequestHandler,
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from "express";
import helmet from "helmet";
import { timingSafeEqual } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { ZodError, type ZodType } from "zod";
import { openDatabase, type SqliteDatabase } from "./db/database";
import {
  DisabledAIProvider,
  MockAIProvider,
  type AIProvider,
} from "./providers/ai";
import {
  ManualPriceProvider,
  type PriceProvider,
} from "./providers/price";
import { AICommandService, getAICommandCapabilities } from "./services/aiCommands";
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
  aiApiToken?: string | null;
  appAuthUsername?: string | null;
  appAuthPassword?: string | null;
}

export interface FinanceRuntime {
  db: SqliteDatabase;
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

const loopbackAddresses = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function timingSafeStringEqual(expected: string, supplied: string): boolean {
  const expectedBytes = Buffer.from(expected);
  const suppliedBytes = Buffer.from(supplied);
  return expectedBytes.length === suppliedBytes.length && timingSafeEqual(expectedBytes, suppliedBytes);
}

function isLoopbackRequest(request: Request): boolean {
  return loopbackAddresses.has(request.ip ?? "");
}

function isAIPath(request: Request): boolean {
  return request.path === "/api/ai" || request.path.startsWith("/api/ai/");
}

function chooseAIProvider(providerId?: string): AIProvider {
  const configured = providerId?.toLowerCase();
  if (configured === undefined || configured === "mock") return new MockAIProvider();
  return new DisabledAIProvider();
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
  const publicAICommandEndpoint = resolvePublicAICommandEndpoint(appBaseUrl);
  const ownsDatabase = options.db === undefined;
  const db = options.db ?? openDatabase({ path: options.databasePath, seed: options.seed });
  const repository = new FinanceRepository(db);
  const aiProvider = options.aiProvider ?? chooseAIProvider(repository.getSettings().aiProvider);
  const priceProvider = options.priceProvider ?? new ManualPriceProvider();
  const emailOutbox = options.emailOutbox ?? new SmtpEmailOutbox(db, repository);
  const monitorService = new MonitorService(db, repository, aiProvider, emailOutbox);
  const commandService = new AICommandService(db, repository);
  const aiApiToken = options.aiApiToken ?? process.env.AI_API_TOKEN?.trim() ?? "";
  const appAuthUsername = options.appAuthUsername ?? process.env.APP_AUTH_USERNAME ?? "";
  const appAuthPassword = options.appAuthPassword ?? process.env.APP_AUTH_PASSWORD ?? "";
  const scheduler = new PersistentScheduler(
    db,
    monitorService,
    emailOutbox,
    options.schedulerPollMs,
  );

  const app = express() as FinanceApp;
  app.finance = {
    db,
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
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use((request, response, next) => {
    if (request.path.startsWith("/api/")) response.setHeader("Cache-Control", "no-store");
    next();
  });
  app.use((request, response, next) => {
    if (
      request.path === "/api/health" ||
      isAIPath(request) ||
      (!production && isLoopbackRequest(request))
    ) {
      next();
      return;
    }

    if (!appAuthUsername || !appAuthPassword) {
      response.status(503).json({
        error: {
          code: "APP_AUTH_DISABLED",
          message: "APP_AUTH_USERNAME and APP_AUTH_PASSWORD are required outside local development",
        },
      });
      return;
    }

    const authorization = request.header("authorization") ?? "";
    const match = /^Basic\s+(.+)$/i.exec(authorization);
    const expected = Buffer.from(`${appAuthUsername}:${appAuthPassword}`, "utf8").toString("base64");
    const supplied = match?.[1] ?? "";
    if (!timingSafeStringEqual(expected, supplied)) {
      response.setHeader("WWW-Authenticate", 'Basic realm="Northstar Finance", charset="UTF-8"');
      response.status(401).json({
        error: { code: "UNAUTHORIZED", message: "Valid application credentials are required" },
      });
      return;
    }
    next();
  });
  app.use("/api/ai", (request, response, next) => {
    if (!aiApiToken) {
      if (production || !isLoopbackRequest(request)) {
        response.status(503).json({
          error: { code: "AI_API_DISABLED", message: "AI_API_TOKEN is required outside local development" },
        });
        return;
      }
      next();
      return;
    }

    const authorization = request.header("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!timingSafeStringEqual(aiApiToken, supplied)) {
      response.status(401).json({
        error: { code: "UNAUTHORIZED", message: "A valid AI API bearer token is required" },
      });
      return;
    }
    next();
  });
  app.use(express.json({ limit: "1mb", strict: true }));

  app.get("/api/health", (_request, response, next) => {
    try {
      const result = db.prepare("SELECT 1 AS ok").get() as { ok: number };
      const applicationAuthReady = !production || Boolean(appAuthUsername && appAuthPassword);
      const ready = result.ok === 1 && applicationAuthReady;
      const health = {
        status: ready ? "ok" : "degraded",
        database: { status: result.ok === 1 ? "ok" : "error" },
        authentication: {
          status: applicationAuthReady ? "ok" : "misconfigured",
        },
        timestamp: new Date().toISOString(),
      };
      response.status(ready ? 200 : 503).json(data(health));
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/dashboard", (_request, response) => {
    response.json(data(repository.getDashboard()));
  });

  app.get("/api/assets", (request, response) => {
    const kind = typeof request.query.kind === "string" ? request.query.kind : undefined;
    const assets = repository.listAssets().filter((asset) => kind === undefined || asset.kind === kind);
    response.json(data(assets));
  });

  app.post("/api/assets", (request, response) => {
    const input = parse(assetCreateSchema, request.body);
    response.status(201).json(data(repository.createAsset(input), "Asset created"));
  });

  app.get("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.getAsset(id)));
  });

  app.patch("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(assetPatchSchema, request.body);
    response.json(data(repository.updateAsset(id, input), "Asset updated"));
  });

  app.delete("/api/assets/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    repository.deleteAsset(id);
    response.json(data({ id, deleted: true }, "Asset deleted"));
  });

  app.get("/api/assets/:id/operations", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.listOperations(id)));
  });

  app.post("/api/assets/:id/operations", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(operationCreateSchema, request.body);
    response.status(201).json(data(repository.recordOperation(id, input), "Operation recorded"));
  });

  app.get("/api/assets/:id/price", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.listPrices(id)));
  });

  const updatePriceHandler = asyncRoute(async (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(priceUpdateSchema, request.body ?? {});
    const asset = repository.getAsset(id);
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
    response.json(data(repository.updatePrice(id, quote), "Price updated"));
  });
  app.post("/api/assets/:id/price", updatePriceHandler);
  app.patch("/api/assets/:id/price", updatePriceHandler);

  app.get("/api/expected", (request, response) => {
    const stage = typeof request.query.stage === "string" ? request.query.stage : undefined;
    const assets = repository
      .listExpectedAssets()
      .filter((asset) => stage === undefined || asset.stage === stage);
    response.json(data(assets));
  });

  app.post("/api/expected", (request, response) => {
    const input = parse(expectedCreateSchema, request.body);
    response.status(201).json(data(repository.createExpectedAsset(input), "Expected asset created"));
  });

  app.get("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.getExpectedAsset(id)));
  });

  app.patch("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(expectedPatchSchema, request.body);
    response.json(data(repository.updateExpectedAsset(id, input), "Expected asset updated"));
  });

  app.delete("/api/expected/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    repository.deleteExpectedAsset(id);
    response.json(data({ id, deleted: true }, "Expected asset deleted"));
  });

  app.get("/api/expected/:id/updates", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.listExpectedUpdates(id)));
  });

  app.get("/api/expected/:id/runs", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.listExpectedRuns(id)));
  });

  app.post(
    "/api/expected/:id/check",
    asyncRoute(async (request, response) => {
      const id = parse(entityId, request.params.id);
      const run = await monitorService.runExpectedCheck(id);
      response.json(data({ expected: repository.getExpectedAsset(id), run }, "Expected asset checked"));
    }),
  );

  app.post("/api/expected/:id/convert", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(expectedConvertSchema, request.body);
    const expected = repository.getExpectedAsset(id);
    if (expected.linkedAssetId) {
      throw new DomainError("Expected asset has already been converted", 409, "ALREADY_CONVERTED");
    }
    const convert = db.transaction(() => {
      const asset = repository.createAsset({
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
      repository.recordOperation(asset.id, {
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
        WHERE id = ?
      `).run(asset.id, `Converted to holding ${asset.symbol}`, now, expected.id);
      return repository.getAsset(asset.id);
    });
    response.status(201).json(
      data({ asset: convert(), expected: repository.getExpectedAsset(id) }, "Converted to direct asset"),
    );
  });

  app.get("/api/events", (request, response) => {
    const status = typeof request.query.status === "string" ? request.query.status : undefined;
    const events = repository.listEvents().filter((event) => status === undefined || event.status === status);
    response.json(data(events));
  });

  app.post("/api/events", (request, response) => {
    const input = parse(eventCreateSchema, request.body);
    const nextRunAt = calculateNextRunAt(input.schedule, input.timezone);
    response.status(201).json(data(repository.createEvent(input, nextRunAt), "Tracked event created"));
  });

  app.get("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.getEvent(id)));
  });

  app.patch("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    const input = parse(eventPatchSchema, request.body);
    const current = repository.getEvent(id);
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
    response.json(data(repository.updateEvent(id, input, nextRunAt), "Tracked event updated"));
  });

  app.delete("/api/events/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    repository.deleteEvent(id);
    response.json(data({ id, deleted: true }, "Tracked event deleted"));
  });

  app.post(
    "/api/events/:id/run",
    asyncRoute(async (request, response) => {
      const id = parse(entityId, request.params.id);
      const run = await monitorService.runEvent(id);
      response.status(201).json(data(run, "Event run completed"));
    }),
  );

  app.get("/api/events/:id/runs", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.listEventRuns(id)));
  });

  app.get("/api/runs/:id", (request, response) => {
    const id = parse(entityId, request.params.id);
    response.json(data(repository.getRun(id)));
  });

  app.get("/api/settings", (_request, response) => {
    response.json(data(repository.getSettings()));
  });

  app.patch("/api/settings", (request, response) => {
    const input = parse(settingsPatchSchema, request.body);
    response.json(data(repository.updateSettings(input), "Settings saved"));
  });

  const testConnection = async (kind: string) => {
    if (kind === "ai") return aiProvider.testConnection();
    if (kind === "price") return priceProvider.testConnection();
    if (kind === "email" || kind === "smtp") return emailOutbox.testConnection();
    throw new DomainError("Unknown connection type", 404, "CONNECTION_TYPE_NOT_FOUND");
  };
  app.post(
    "/api/settings/connections/:kind/test",
    asyncRoute(async (request, response) => {
      const rawKind = request.params.kind;
      const result = await testConnection(Array.isArray(rawKind) ? rawKind[0] ?? "" : rawKind);
      response.status(result.ok ? 200 : result.status === "failed" ? 502 : 409).json(data(result));
    }),
  );
  for (const kind of ["ai", "price", "email"] as const) {
    app.post(
      `/api/settings/test-${kind}`,
      asyncRoute(async (_request, response) => {
        const result = await testConnection(kind);
        response.status(result.ok ? 200 : result.status === "failed" ? 502 : 409).json(data(result));
      }),
    );
  }

  app.get("/api/ai/capabilities", (_request, response) => {
    response.json(data({
      ...getAICommandCapabilities(publicAICommandEndpoint),
      authentication: aiApiToken ? "bearer" : "local-development-only",
    }));
  });

  app.post("/api/ai/commands/execute", (request, response) => {
    const result = commandService.execute(request.body);
    const status = result.status === "failed" ? 409 : result.replayed ? 200 : 201;
    response.status(status).json(data(result));
  });

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
    if (error instanceof DomainError) {
      response.status(error.status).json({ error: { code: error.code, message: error.message } });
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
