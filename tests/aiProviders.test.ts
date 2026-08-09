import request from "supertest";
import type { CodexOptions } from "@openai/codex-sdk";
import { describe, expect, it, vi } from "vitest";
import { createAIWorkerApp } from "../server/aiWorkerApp";
import {
  DisabledAIProvider,
  FallbackAIProvider,
  type AIProvider,
  type ResearchRequest,
  type ResearchResult,
} from "../server/providers/ai";
import { parseResearchModelOutput } from "../server/providers/aiContract";
import { CodexAIProvider } from "../server/providers/codexAI";
import { OpenCodeAgentReachProvider } from "../server/providers/opencodeAgentReachAI";
import { RemoteAIProvider } from "../server/providers/remoteAI";

const researchRequest: ResearchRequest = {
  targetType: "event",
  targetId: "release-watch",
  title: "Release watch",
  topic: "Northstar release",
  instructions: "Find the latest public release information.",
};

const verifiedResult: ResearchResult = {
  summary: "A current release was found.",
  changeSummary: "The release date changed.",
  changed: true,
  sources: [{ title: "Release", url: "https://example.com/release" }],
  provider: "codex-sdk",
  searchEvidence: {
    mode: "live",
    query: "Northstar current release",
    searchedAt: "2026-08-10T00:00:00.000Z",
    observedUrls: ["https://example.com/release"],
  },
};

function provider(
  id: string,
  research: AIProvider["research"],
): AIProvider {
  return {
    id,
    research,
    async testConnection() {
      return { ok: true, status: "connected", message: "ready" };
    },
  };
}

describe("AI research contract", () => {
  it("rejects non-HTTP source URLs and deduplicates valid sources", () => {
    expect(() => parseResearchModelOutput({
      summary: "Current result",
      changeSummary: "Changed",
      changed: true,
      sources: [{ title: "Bad", url: "javascript:alert(1)" }],
    })).toThrow();

    const parsed = parseResearchModelOutput({
      summary: "Current result",
      changeSummary: "Changed",
      changed: true,
      sources: [
        { title: "One", url: "https://example.com/news" },
        { title: "Duplicate", url: "https://example.com/news" },
      ],
    });
    expect(parsed.sources).toHaveLength(1);
  });

  it("falls back once and retains the provider that completed the run", async () => {
    const primary = vi.fn(async () => {
      throw new Error("missing live search");
    });
    const fallback = vi.fn(async () => ({
      ...verifiedResult,
      provider: "opencode-agent-reach",
    }));
    const composite = new FallbackAIProvider(
      provider("codex-sdk", primary),
      provider("opencode-agent-reach", fallback),
    );

    await expect(composite.research(researchRequest)).resolves.toMatchObject({
      provider: "opencode-agent-reach",
    });
    expect(primary).toHaveBeenCalledTimes(1);
    expect(fallback).toHaveBeenCalledTimes(1);
  });
});

describe("Codex SDK provider", () => {
  it("forces live search and rejects turns without a web_search item", async () => {
    const run = vi.fn(async () => ({
      items: [],
      finalResponse: JSON.stringify({
        summary: "Claimed current result",
        changeSummary: "Changed",
        changed: true,
        sources: [{ title: "Source", url: "https://example.com/news" }],
      }),
      usage: null,
    }));
    const startThread = vi.fn(() => ({ run }));
    let sdkOptions: CodexOptions | undefined;
    const codex = new CodexAIProvider({
      clientFactory: (options) => {
        sdkOptions = options;
        return { startThread } as never;
      },
      timeoutMs: 5_000,
      environment: {
        PATH: "/usr/bin",
        OPENAI_API_KEY: "must-not-be-inherited",
      },
    });

    await expect(codex.research(researchRequest)).rejects.toThrow(/live web search/i);
    expect(sdkOptions).toMatchObject({
      env: { PATH: "/usr/bin" },
      config: {
        features: {
          apps: false,
          hooks: false,
          multi_agent: false,
          shell_snapshot: false,
          shell_tool: false,
          skill_mcp_dependency_install: false,
          unified_exec: false,
        },
        shell_environment_policy: {
          inherit: "none",
          ignore_default_excludes: false,
        },
      },
    });
    expect(startThread).toHaveBeenCalledWith(expect.objectContaining({
      sandboxMode: "read-only",
      approvalPolicy: "never",
      webSearchMode: "live",
      networkAccessEnabled: false,
    }));
  });
});

describe("OpenCode + Agent-Reach provider", () => {
  it("uses forced Agent-Reach search and verifies model citations against its output", async () => {
    const create = vi.fn(async () => ({ data: { id: "session-1" } }));
    const prompt = vi.fn(async () => ({
      data: {
        info: {},
        parts: [{
          type: "text",
          text: JSON.stringify({
            summary: "A current release was found.",
            changeSummary: "The release date changed.",
            changed: true,
            sources: [{ title: "Release", url: "https://example.com/release" }],
          }),
        }],
      },
    }));
    const remove = vi.fn(async () => ({ data: true }));
    const opencode = new OpenCodeAgentReachProvider({
      baseUrl: "http://127.0.0.1:4096",
      directory: "/work",
      client: {
        global: {},
        session: { create, prompt, abort: vi.fn(), delete: remove },
      } as never,
      searchRunner: async () => ({
        text: "Current result: https://example.com/release",
        observedUrls: ["https://example.com/release"],
      }),
    });

    await expect(opencode.research(researchRequest)).resolves.toMatchObject({
      provider: "opencode-agent-reach",
      sources: [{ url: "https://example.com/release" }],
      searchEvidence: { mode: "live", query: expect.stringContaining("Release watch") },
    });
    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        permission: [
          { permission: "*", pattern: "*", action: "deny" },
        ],
      }),
      expect.anything(),
    );
    expect(prompt).toHaveBeenCalledWith(
      expect.objectContaining({
        tools: expect.objectContaining({ websearch: false, bash: false, webfetch: false }),
      }),
      expect.anything(),
    );
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("AI worker boundary", () => {
  it("requires its bearer token and returns only validated research results", async () => {
    const worker = createAIWorkerApp(
      provider("codex-sdk", async () => verifiedResult),
      { token: "worker-secret" },
    );

    await request(worker).post("/v1/research").send(researchRequest).expect(401);
    const response = await request(worker)
      .post("/v1/research")
      .set("Authorization", "Bearer worker-secret")
      .send(researchRequest)
      .expect(200);
    expect(response.body.data).toMatchObject({
      provider: "codex-sdk",
      searchEvidence: { mode: "live" },
    });
  });

  it("rejects provider output that lacks tool-level search evidence", async () => {
    const worker = createAIWorkerApp(
      provider("codex-sdk", async () => ({
        summary: "Unverified result",
        changeSummary: "Changed",
        changed: true,
        sources: [{ title: "Source", url: "https://example.com/news" }],
      })),
      { token: "worker-secret" },
    );

    const response = await request(worker)
      .post("/v1/research")
      .set("Authorization", "Bearer worker-secret")
      .send(researchRequest)
      .expect(502);
    expect(response.body.error.code).toBe("AI_INVALID_RESPONSE");
  });

  it("preserves a disabled canary result across the remote worker boundary", async () => {
    const worker = createAIWorkerApp(new DisabledAIProvider(), { token: "worker-secret" });
    const server = worker.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing test server address");
      const remote = new RemoteAIProvider({
        baseUrl: `http://127.0.0.1:${address.port}`,
        token: "worker-secret",
        timeoutMs: 5_000,
      });
      await expect(remote.testConnection()).resolves.toMatchObject({
        ok: false,
        status: "skipped",
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
