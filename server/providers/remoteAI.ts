import { z } from "zod";
import type { ConnectionTestResult } from "./price";
import {
  AIProviderError,
  type AIProvider,
  type ResearchRequest,
  type ResearchResult,
} from "./ai";
import { researchResultSchema } from "./aiContract";

const connectionResultSchema = z
  .object({
    ok: z.boolean(),
    status: z.enum(["connected", "failed", "skipped"]),
    message: z.string().max(2_000),
  })
  .strict();

interface RemoteAIProviderOptions {
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class RemoteAIProvider implements AIProvider {
  public readonly id = "remote-ai-worker";
  private readonly baseUrl: URL;
  private readonly timeoutMs: number;

  public constructor(private readonly options: RemoteAIProviderOptions) {
    this.baseUrl = new URL(options.baseUrl.endsWith("/") ? options.baseUrl : `${options.baseUrl}/`);
    if (this.baseUrl.protocol !== "http:" && this.baseUrl.protocol !== "https:") {
      throw new Error("AI_WORKER_URL must use http or https");
    }
    if (!options.token.trim()) throw new Error("AI_WORKER_TOKEN is required");
    this.timeoutMs = options.timeoutMs ?? 125_000;
  }

  private async post(
    path: string,
    body: unknown,
    signal?: AbortSignal,
    acceptErrorData = false,
  ): Promise<unknown> {
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error("AI worker request timed out")),
      this.timeoutMs,
    );
    try {
      const response = await fetch(new URL(path, this.baseUrl), {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.options.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const raw = await response.text();
      if (raw.length > 512_000) {
        throw new AIProviderError("AI worker response exceeded the size limit", "AI_RESPONSE_TOO_LARGE");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(raw) as unknown;
      } catch {
        throw new AIProviderError("AI worker returned invalid JSON", "AI_INVALID_RESPONSE");
      }
      if (!response.ok && acceptErrorData) {
        const envelope = z.object({ data: z.unknown() }).safeParse(payload);
        if (envelope.success) return envelope.data.data;
      }
      if (!response.ok) {
        const code = z.object({ error: z.object({ code: z.string() }) }).safeParse(payload);
        throw new AIProviderError(
          "AI worker could not complete the request",
          code.success ? code.data.error.code : "AI_WORKER_FAILED",
        );
      }
      return z.object({ data: z.unknown() }).parse(payload).data;
    } catch (error) {
      if (error instanceof AIProviderError) throw error;
      throw new AIProviderError("AI worker is unavailable", "AI_WORKER_UNAVAILABLE", { cause: error });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }

  public async research(
    request: ResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchResult> {
    return researchResultSchema.parse(await this.post("v1/research", request, signal));
  }

  public async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    try {
      return connectionResultSchema.parse(await this.post("v1/test", {}, signal, true));
    } catch (error) {
      return {
        ok: false,
        status: "failed",
        message: error instanceof AIProviderError ? error.message : "AI worker canary failed",
      };
    }
  }
}
