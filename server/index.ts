import "dotenv/config";
import { createApp } from "./app";

const production = process.env.NODE_ENV === "production";
const port = Number(production ? process.env.PORT ?? 5888 : process.env.API_PORT ?? 5889);
const host = process.env.HOST ?? (production ? "0.0.0.0" : "127.0.0.1");
const app = createApp({ serveStatic: production });

if (process.env.SCHEDULER_ENABLED !== "false") {
  app.finance.scheduler.start();
}
if (process.env.PRICE_SCHEDULER_ENABLED !== "false") {
  app.finance.priceScheduler.start();
}

const server = app.listen(port, host, () => {
  console.log(`Northstar Finance API listening on http://${host}:${port}`);
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Received ${signal}; shutting down.`);
  app.finance.priceScheduler.stop();
  app.finance.scheduler.stop();
  server.close(() => {
    app.finance.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
