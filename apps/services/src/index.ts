// Public exports of @x1-labs/games-services. No side effects.
// The Hono/bun startup lives in main.ts.

export { appRouter } from "./router/index.ts";
export type { AppRouter } from "./router/index.ts";
export { createCallerFactory } from "./trpc.ts";
export { createContextFactory } from "./context.ts";
export type { Context } from "./context.ts";
