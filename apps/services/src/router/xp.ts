import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";

const GameIdSchema = z.string().regex(/^[a-z0-9-]{3,32}$/);
const PubkeySchema = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

export const xpRouter = router({
  get: publicProcedure
    .input(z.object({ gameId: GameIdSchema, player: PubkeySchema }))
    .query(async ({ ctx, input }) => {
      return ctx.platform.getXp({ gameId: input.gameId, player: input.player });
    }),
});
