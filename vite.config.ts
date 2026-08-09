import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

function normalizeBasePath(value: string | undefined): string {
  const trimmed = value?.trim() || "/";
  if (trimmed === "/") return "/";
  if (!trimmed.startsWith("/") || trimmed.includes("?") || trimmed.includes("#")) {
    throw new Error("VITE_BASE_PATH must be an absolute URL path such as /northstar/");
  }
  return `/${trimmed.replace(/^\/+|\/+$/g, "")}/`;
}

export default defineConfig(({ mode }) => {
  const fileEnvironment = loadEnv(mode, process.cwd(), "");
  const basePath = normalizeBasePath(
    process.env.VITE_BASE_PATH ?? fileEnvironment.VITE_BASE_PATH,
  );
  const basePrefix = basePath === "/" ? "" : basePath.replace(/\/$/, "");

  return {
    base: basePath,
    plugins: [react()],
    server: {
      host: "127.0.0.1",
      port: 5888,
      strictPort: true,
      proxy: {
        [`${basePrefix}/api`]: {
          target: "http://127.0.0.1:5889",
          rewrite: (path) => path.slice(basePrefix.length),
        },
      },
    },
  };
});
