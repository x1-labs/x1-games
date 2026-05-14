import { router, publicProcedure } from "../trpc.ts";
import pkg from "../../package.json" with { type: "json" };

export const healthRouter = router({
  get: publicProcedure.query(() => ({
    status: "ok" as const,
    version: pkg.version,
  })),
});
