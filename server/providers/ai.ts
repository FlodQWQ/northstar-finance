import type { ConnectionTestResult } from "./price";
import type { ResearchResult as VerifiedResearchResult } from "./aiContract";

export interface ResearchSource {
  title: string;
  url: string;
}

export interface ResearchRequest {
  targetType: "expected" | "event";
  targetId: string;
  title: string;
  topic: string;
  instructions: string;
  previousSummary?: string;
  sourceUrl?: string;
  keywords?: string[];
}

export interface ResearchResult {
  summary: string;
  changeSummary: string;
  changed: boolean;
  sources: ResearchSource[];
  suggestedStatus?: string;
  provider?: string;
  searchEvidence?: VerifiedResearchResult["searchEvidence"];
}

export interface AIProvider {
  readonly id: string;
  research(request: ResearchRequest, signal?: AbortSignal): Promise<ResearchResult>;
  testConnection(signal?: AbortSignal): Promise<ConnectionTestResult>;
}

export class AIProviderError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "AIProviderError";
  }
}

export class DisabledAIProvider implements AIProvider {
  public readonly id = "disabled";

  public constructor(private readonly reason = "AI provider is not configured") {}

  public async research(): Promise<ResearchResult> {
    throw new AIProviderError(this.reason, "AI_NOT_CONFIGURED");
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return { ok: false, status: "skipped", message: `${this.reason}.` };
  }
}

export class MockAIProvider implements AIProvider {
  public readonly id = "mock";

  public async research(request: ResearchRequest): Promise<ResearchResult> {
    const summary = `Mock research completed for ${request.title}. No authoritative state was changed.`;
    const sources = request.sourceUrl
      ? [{ title: `${request.title} source`, url: request.sourceUrl }]
      : [];
    return {
      summary,
      changeSummary: request.previousSummary === summary ? "No material change." : "New mock research result.",
      changed: request.previousSummary !== summary,
      sources,
      provider: this.id,
    };
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, status: "connected", message: "Mock AI provider is ready." };
  }
}

export class FallbackAIProvider implements AIProvider {
  public readonly id = "auto";

  public constructor(
    private readonly primary: AIProvider,
    private readonly fallback: AIProvider,
  ) {}

  public async research(
    request: ResearchRequest,
    signal?: AbortSignal,
  ): Promise<ResearchResult> {
    try {
      return await this.primary.research(request, signal);
    } catch (primaryError) {
      if (signal?.aborted) throw primaryError;
      try {
        return await this.fallback.research(request, signal);
      } catch (fallbackError) {
        throw new AIProviderError(
          `Both AI research providers failed (${this.primary.id}, ${this.fallback.id})`,
          "AI_ALL_PROVIDERS_FAILED",
          { cause: fallbackError },
        );
      }
    }
  }

  public async testConnection(signal?: AbortSignal): Promise<ConnectionTestResult> {
    const primary = await this.primary.testConnection(signal);
    if (primary.ok) {
      return {
        ...primary,
        message: `${this.primary.id} live-search canary passed.`,
      };
    }
    if (signal?.aborted) {
      return {
        ok: false,
        status: "failed",
        message: "AI live-search canary was cancelled.",
      };
    }
    const fallback = await this.fallback.testConnection(signal);
    if (fallback.ok) {
      return {
        ...fallback,
        message: `${this.primary.id} unavailable; ${this.fallback.id} live-search canary passed.`,
      };
    }
    return {
      ok: false,
      status: "failed",
      message: `Neither ${this.primary.id} nor ${this.fallback.id} passed the live-search canary.`,
    };
  }
}
