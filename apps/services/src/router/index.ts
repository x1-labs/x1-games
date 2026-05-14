import { router } from "../trpc.ts";
import { healthRouter } from "./health.ts";
import { gamesRouter } from "./games.ts";
import { lobbiesRouter } from "./lobbies.ts";
import { xpRouter } from "./xp.ts";
import { replaysRouter } from "./replays.ts";

export const appRouter = router({
  health: healthRouter,
  games: gamesRouter,
  lobbies: lobbiesRouter,
  xp: xpRouter,
  replays: replaysRouter,
});

export type AppRouter = typeof appRouter;
