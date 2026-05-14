import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";

const GameIdSchema = z.string().regex(/^[a-z0-9-]{3,32}$/);
const PubkeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export const lobbiesRouter = router({
  list: publicProcedure
    .input(z.object({ gameId: GameIdSchema.optional(), limit: z.number().int().min(1).max(500).optional() }).optional())
    .query(async ({ ctx, input }) => {
      return ctx.platform.listMatches(input ?? {});
    }),
  get: publicProcedure
    .input(z.object({ matchId: PubkeySchema }))
    .query(async ({ ctx, input }) => {
      return ctx.platform.getMatch(input.matchId);
    }),
});
