import { z } from "zod";
import { router, publicProcedure } from "../trpc.ts";

const GameIdSchema = z.string().regex(/^[a-z0-9-]{3,32}$/);

export const gamesRouter = router({
  list: publicProcedure.query(async ({ ctx }) => {
    return ctx.platform.listGames();
  }),
  get: publicProcedure
    .input(z.object({ id: GameIdSchema }))
    .query(async ({ ctx, input }) => {
      return ctx.platform.getGame(input.id);
    }),
});
