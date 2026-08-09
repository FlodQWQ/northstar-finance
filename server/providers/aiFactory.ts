import type { AIProvider } from "./ai";
import { DisabledAIProvider, MockAIProvider } from "./ai";
import { RemoteAIProvider } from "./remoteAI";

export type AIProviderMode =
  | "auto"
  | "codex-sdk"
  | "opencode-agent-reach"
  | "disabled"
  | "mock";

export function normalizeAIProviderMode(value: string | undefined): AIProviderMode {
  const normalized = value?.trim().toLowerCase();
  if (!normalized || normalized === "none") return "disabled";
  if (
    normalized === "auto"
    || normalized === "codex-sdk"
    || normalized === "opencode-agent-reach"
    || normalized === "disabled"
    || normalized === "mock"
  ) {
    return normalized;
  }
  throw new Error(`Unsupported AI_PROVIDER: ${value}`);
}

function numberFromEnv(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function createApplicationAIProviderFromEnv(): AIProvider {
  const mode = normalizeAIProviderMode(process.env.AI_PROVIDER);
  if (mode === "disabled") return new DisabledAIProvider();
  if (mode === "mock") {
    if (process.env.NODE_ENV === "production") {
      return new DisabledAIProvider("Mock AI is disabled in production");
    }
    return new MockAIProvider();
  }

  const baseUrl = process.env.AI_WORKER_URL?.trim() ?? "";
  const token = process.env.AI_WORKER_TOKEN?.trim() ?? "";
  if (!baseUrl || !token) {
    return new DisabledAIProvider("AI worker URL and token are not configured");
  }
  return new RemoteAIProvider({
    baseUrl,
    token,
    timeoutMs: numberFromEnv(process.env.AI_REQUEST_TIMEOUT_MS, 200_000),
  });
}

export function deploymentAIStatus(): { provider: AIProviderMode; configured: boolean } {
  const provider = normalizeAIProviderMode(process.env.AI_PROVIDER);
  const configured = provider === "mock"
    ? process.env.NODE_ENV !== "production"
    : provider !== "disabled"
      && Boolean(process.env.AI_WORKER_URL?.trim() && process.env.AI_WORKER_TOKEN?.trim());
  return { provider, configured };
}
