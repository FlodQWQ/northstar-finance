import { createOpencodeServer } from "@opencode-ai/sdk/v2";
import type { ModelReasoningEffort } from "@openai/codex-sdk";
import { mkdirSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import {
  DisabledAIProvider,
  FallbackAIProvider,
  MockAIProvider,
  type AIProvider,
} from "./ai";
import { normalizeAIProviderMode } from "./aiFactory";
import { CodexAIProvider } from "./codexAI";
import { OpenCodeAgentReachProvider } from "./opencodeAgentReachAI";

export interface LocalAIRuntime {
  provider: AIProvider;
  close(): void;
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function reasoningEffort(value: string | undefined): ModelReasoningEffort | undefined {
  if (!value?.trim()) return undefined;
  const normalized = value.trim().toLowerCase();
  if (["minimal", "low", "medium", "high", "xhigh"].includes(normalized)) {
    return normalized as ModelReasoningEffort;
  }
  throw new Error("CODEX_MODEL_REASONING_EFFORT is invalid");
}

function openCodeModel(env: NodeJS.ProcessEnv): { providerID: string; modelID: string } | undefined {
  const explicitProvider = env.OPENCODE_PROVIDER_ID?.trim();
  const explicitModel = env.OPENCODE_MODEL_ID?.trim();
  if (explicitProvider || explicitModel) {
    if (!explicitProvider || !explicitModel) {
      throw new Error("OPENCODE_PROVIDER_ID and OPENCODE_MODEL_ID must be set together");
    }
    return { providerID: explicitProvider, modelID: explicitModel };
  }

  const combined = env.OPENCODE_MODEL?.trim();
  if (!combined) return { providerID: "opencode", modelID: "big-pickle" };
  const separator = combined.indexOf("/");
  if (separator < 1 || separator === combined.length - 1) {
    return { providerID: "openai", modelID: combined };
  }
  return {
    providerID: combined.slice(0, separator),
    modelID: combined.slice(separator + 1),
  };
}

function createCodexProvider(env: NodeJS.ProcessEnv): AIProvider {
  const codexHome = env.CODEX_HOME?.trim();
  if (codexHome) mkdirSync(codexHome, { recursive: true });
  return new CodexAIProvider({
    apiKey: env.OPENAI_API_KEY?.trim() || undefined,
    baseUrl: env.OPENAI_BASE_URL?.trim() || undefined,
    model: env.CODEX_MODEL?.trim() || env.OPENAI_MODEL?.trim() || undefined,
    modelReasoningEffort: reasoningEffort(env.CODEX_MODEL_REASONING_EFFORT),
    workingDirectory: env.AI_WORKING_DIRECTORY?.trim() || "/work",
    codexPathOverride: env.CODEX_PATH?.trim() || undefined,
    timeoutMs: positiveNumber(env.AI_PROVIDER_TIMEOUT_MS ?? env.AI_TIMEOUT_MS, 90_000),
    canaryTimeoutMs: positiveNumber(env.AI_CANARY_TIMEOUT_MS, 45_000),
    environment: env,
  });
}

async function createOpenCodeProvider(
  env: NodeJS.ProcessEnv,
): Promise<{ provider: AIProvider; close(): void }> {
  const localBin = resolve(process.cwd(), "node_modules", ".bin");
  const pathEntries = (process.env.PATH ?? "").split(delimiter);
  if (!pathEntries.some((entry) => entry.toLowerCase() === localBin.toLowerCase())) {
    process.env.PATH = [localBin, ...pathEntries].filter(Boolean).join(delimiter);
  }
  const server = await createOpencodeServer({
    hostname: "127.0.0.1",
    port: positiveNumber(env.OPENCODE_SERVER_PORT, 4_096),
    timeout: positiveNumber(env.OPENCODE_SERVER_START_TIMEOUT_MS, 20_000),
  });
  return {
    provider: new OpenCodeAgentReachProvider({
      baseUrl: server.url,
      directory: env.AI_WORKING_DIRECTORY?.trim() || "/work",
      model: openCodeModel(env),
      agent: env.OPENCODE_AGENT?.trim() || undefined,
      mcporterPath: env.MCPORTER_PATH?.trim() || undefined,
      mcporterConfig: env.MCPORTER_CONFIG?.trim() || undefined,
      environment: env,
      timeoutMs: positiveNumber(env.AI_PROVIDER_TIMEOUT_MS ?? env.AI_TIMEOUT_MS, 90_000),
      canaryTimeoutMs: positiveNumber(env.AI_CANARY_TIMEOUT_MS, 45_000),
    }),
    close: () => server.close(),
  };
}

export async function createLocalAIRuntime(
  env: NodeJS.ProcessEnv = process.env,
): Promise<LocalAIRuntime> {
  const mode = normalizeAIProviderMode(env.AI_PROVIDER);
  if (mode === "disabled") {
    return { provider: new DisabledAIProvider(), close() {} };
  }
  if (mode === "mock") {
    if (env.NODE_ENV === "production") throw new Error("Mock AI is disabled in production");
    return { provider: new MockAIProvider(), close() {} };
  }
  if (mode === "codex-sdk") {
    return { provider: createCodexProvider(env), close() {} };
  }
  if (mode === "opencode-agent-reach") {
    const runtime = await createOpenCodeProvider(env);
    return { provider: runtime.provider, close: runtime.close };
  }

  const codex = createCodexProvider(env);
  try {
    const openCode = await createOpenCodeProvider(env);
    return {
      provider: new FallbackAIProvider(codex, openCode.provider),
      close: openCode.close,
    };
  } catch {
    return {
      provider: new FallbackAIProvider(
        codex,
        new DisabledAIProvider("OpenCode + Agent-Reach runtime is unavailable"),
      ),
      close() {},
    };
  }
}
