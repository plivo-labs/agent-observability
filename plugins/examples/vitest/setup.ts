// Vitest setup file — runs once per worker before any test file is loaded.
// `@livekit/agents` uses a lazy logger singleton (pino under the hood) that
// must be initialized before any AgentSession is constructed, otherwise
// the `log()` getter throws "logger not initialized". The framework normally
// calls `initializeLogger` during `cli.runApp(...)`, but tests bypass the
// CLI entrypoint, so we do it explicitly here.
import { initializeLogger } from "@livekit/agents";

initializeLogger({
  pretty: false,
  level: process.env.LIVEKIT_LOG_LEVEL ?? "warn",
});
