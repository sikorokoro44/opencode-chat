/** Process entry point: configuration, server startup, graceful shutdown. */

import { createApp } from "./api/app.ts";
import { ConfigError, loadConfig, redact } from "./config.ts";

async function main(): Promise<void> {
  let app: Awaited<ReturnType<typeof createApp>>;
  try {
    const config = loadConfig();
    app = await createApp({ config });
  } catch (error) {
    if (error instanceof ConfigError) {
      process.stderr.write(`configuration error: ${error.message}\n`);
      process.exit(78); // EX_CONFIG
    }
    throw error;
  }

  const { port, host } = await app.listen();
  app.logger.info("opencode-chat backend listening", {
    host,
    port,
    env: app.config.env,
    models: app.registry.all().length,
    primaryModel: app.registry.primaryModelId,
    githubWrites: app.github.writesEnabled,
    jwtSecret: redact(app.config.jwtSecret),
  });

  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.logger.info("shutting down", { signal });
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    app
      .close()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        app.logger.error("shutdown failed", { error: String(error) });
        process.exit(1);
      });
  };

  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("unhandledRejection", (reason) => {
    app.logger.error("unhandled rejection", { reason: String(reason) });
  });
}

void main();
