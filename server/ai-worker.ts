import "dotenv/config";
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { createAIWorkerApp } from "./aiWorkerApp";
import { createLocalAIRuntime } from "./providers/localAI";

const token = process.env.AI_WORKER_TOKEN?.trim() ?? "";
if (!token) throw new Error("AI_WORKER_TOKEN is required");

// Live search is a production invariant, not a user-selectable optimization.
process.env.OPENCODE_ENABLE_EXA = "1";
process.env.OPENCODE_WEBSEARCH_PROVIDER = "exa";
process.env.MCPORTER_CONFIG ??= "/opt/agent-reach/config/mcporter.json";
process.env.NODE_USE_ENV_PROXY ??= "1";

for (const directory of [
  process.env.HOME,
  process.env.CODEX_HOME,
  process.env.XDG_CONFIG_HOME,
  process.env.XDG_CACHE_HOME,
  process.env.XDG_DATA_HOME,
  process.env.XDG_STATE_HOME,
]) {
  if (directory?.trim()) mkdirSync(directory, { recursive: true });
}

const bundledAgentReachSkill = "/opt/northstar-ai-home/.config/opencode/skills/agent-reach";
const configHome = process.env.XDG_CONFIG_HOME?.trim();
if (configHome && existsSync(bundledAgentReachSkill)) {
  const skillTarget = resolve(configHome, "opencode", "skills", "agent-reach");
  if (!existsSync(skillTarget)) {
    mkdirSync(resolve(skillTarget, ".."), { recursive: true });
    cpSync(bundledAgentReachSkill, skillTarget, { recursive: true });
  }
}

const runtime = await createLocalAIRuntime();
const app = createAIWorkerApp(runtime.provider, {
  token,
  timeoutMs: Number(process.env.AI_JOB_TIMEOUT_MS ?? process.env.AI_TIMEOUT_MS ?? 190_000),
  maxConcurrency: Number(process.env.AI_MAX_CONCURRENCY ?? 2),
});
const port = Number(process.env.AI_WORKER_PORT ?? 5_890);
const host = process.env.AI_WORKER_HOST?.trim() || "127.0.0.1";
const server = app.listen(port, host, () => {
  console.log(`Northstar AI worker listening on http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down AI worker.`);
  server.close(() => {
    runtime.close();
    process.exit(0);
  });
  setTimeout(() => {
    runtime.close();
    process.exit(1);
  }, 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
