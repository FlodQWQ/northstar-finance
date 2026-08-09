import type { ConnectionTestResult } from "./price";

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
}

export interface AIProvider {
  readonly id: string;
  research(request: ResearchRequest): Promise<ResearchResult>;
  testConnection(): Promise<ConnectionTestResult>;
}

export class DisabledAIProvider implements AIProvider {
  public readonly id = "disabled";

  public async research(): Promise<ResearchResult> {
    throw new Error("AI provider is not configured");
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return { ok: false, status: "skipped", message: "AI provider is not configured." };
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
    };
  }

  public async testConnection(): Promise<ConnectionTestResult> {
    return { ok: true, status: "connected", message: "Mock AI provider is ready." };
  }
}
