import { createHash, timingSafeEqual } from "node:crypto";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import helmet from "helmet";
import { z, ZodError } from "zod";
import { AIProviderError, type AIProvider, type ResearchRequest } from "./providers/ai";
import { researchResultSchema } from "./providers/aiContract";

const httpUrl = z
  .string()
  .trim()
  .max(2_048)
  .refine((value) => {
    if (!value) return true;
    try {
      const protocol = new URL(value).protocol;
      return protocol === "http:" || protocol === "https:";
    } catch {
      return false;
    }
  }, "Only absolute HTTP(S) URLs are accepted");

export const workerResearchRequestSchema = z
  .object({
    targetType: z.enum(["expected", "event"]),
    targetId: z.string().trim().min(1).max(128),
    title: z.string().trim().min(1).max(200),
    topic: z.string().trim().min(1).max(2_000),
    instructions: z.string().trim().min(1).max(20_000),
    previousSummary: z.string().max(20_000).optional(),
    sourceUrl: httpUrl.optional(),
    keywords: z.array(z.string().trim().min(1).max(100)).max(50).optional(),
  })
  .strict();

export interface AIWorkerOptions {
  token: string;
  timeoutMs?: number;
  maxConcurrency?: number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const selected = value ?? fallback;
  if (!Number.isInteger(selected) || selected < minimum || selected > maximum) {
    throw new Error(`${label} must be an integer between ${minimum} and ${maximum}`);
  }
  return selected;
}

function tokenDigest(token: string): Buffer {
  return createHash("sha256").update(token).digest();
}

async function withTimeout<T>(
  timeoutMs: number,
  operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timeout: NodeJS.Timeout | undefined;
  const expired = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new AIProviderError("AI research timed out", "AI_TIMEOUT");
      controller.abort(error);
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export function createAIWorkerApp(provider: AIProvider, options: AIWorkerOptions): Express {
  const token = options.token.trim();
  if (!token) throw new Error("AI_WORKER_TOKEN is required");
  const expectedTokenDigest = tokenDigest(token);
  const timeoutMs = boundedInteger(options.timeoutMs, 190_000, 5_000, 600_000, "AI timeout");
  const maxConcurrency = boundedInteger(options.maxConcurrency, 2, 1, 8, "AI concurrency");
  let active = 0;

  const app = express();
  app.disable("x-powered-by");
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(express.json({ limit: "64kb", strict: true }));

  app.get("/health", (_request, response) => {
    response.json({
      data: {
        status: "ok",
        provider: provider.id,
        timestamp: new Date().toISOString(),
      },
    });
  });

  app.use((request, response, next) => {
    const authorization = request.header("authorization") ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(authorization);
    const supplied = tokenDigest(match?.[1]?.trim() ?? "");
    if (!timingSafeEqual(expectedTokenDigest, supplied)) {
      response.status(401).json({
        error: { code: "AI_WORKER_UNAUTHORIZED", message: "A valid worker token is required" },
      });
      return;
    }
    next();
  });

  const runExclusive = async <T>(operation: () => Promise<T>): Promise<T> => {
    if (active >= maxConcurrency) {
      throw new AIProviderError("AI worker is at capacity", "AI_WORKER_BUSY");
    }
    active += 1;
    try {
      return await operation();
    } finally {
      active -= 1;
    }
  };

  app.post("/v1/research", async (request, response, next) => {
    try {
      const input = workerResearchRequestSchema.parse(request.body) as ResearchRequest;
      const result = await runExclusive(() =>
        withTimeout(timeoutMs, (signal) => provider.research(input, signal)),
      );
      const verified = researchResultSchema.safeParse(result);
      if (!verified.success) {
        throw new AIProviderError(
          "AI provider returned an invalid research result",
          "AI_INVALID_RESPONSE",
        );
      }
      response.json({ data: verified.data });
    } catch (error) {
      next(error);
    }
  });

  app.post("/v1/test", async (_request, response, next) => {
    try {
      const result = await runExclusive(() =>
        withTimeout(timeoutMs, (signal) => provider.testConnection(signal)),
      );
      response.status(result.ok ? 200 : result.status === "failed" ? 502 : 409).json({ data: result });
    } catch (error) {
      next(error);
    }
  });

  app.use((error: unknown, _request: Request, response: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      response.status(400).json({
        error: { code: "AI_INVALID_REQUEST", message: "AI worker request validation failed" },
      });
      return;
    }
    if (error instanceof AIProviderError) {
      const status = error.code === "AI_WORKER_BUSY" ? 429 : error.code === "AI_TIMEOUT" ? 504 : 502;
      response.status(status).json({ error: { code: error.code, message: error.message } });
      return;
    }
    response.status(502).json({
      error: { code: "AI_RESEARCH_FAILED", message: "AI research could not be completed" },
    });
  });

  return app;
}
