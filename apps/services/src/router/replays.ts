import { z } from "zod";
import { Replay, getDefaultReplayStore } from "@x1-labs/games-protocol";
import { router, publicProcedure } from "../trpc.ts";

const Pubkey = z.string().min(32).max(44).regex(/^[1-9A-HJ-NP-Za-km-z]+$/);

/** v0 replay storage. Process-local in-memory; shares state with the SDK's
 *  uploadReplay/getReplay so a game integrated via the SDK can also be read
 *  back via the public API. */
export const replaysRouter = router({
  put: publicProcedure
    .input(z.object({ replay: Replay }))
    .mutation(async ({ input }) => {
      const stored = getDefaultReplayStore().put(input.replay);
      return {
        matchId: stored.matchId,
        replayHash: stored.hash,
        bytes: Buffer.byteLength(stored.body, "utf8"),
      };
    }),

  get: publicProcedure
    .input(z.object({ matchId: Pubkey }))
    .query(async ({ input }) => {
      const stored = getDefaultReplayStore().get(input.matchId);
      if (!stored) {
        throw new Error(`NotFound: replay for match "${input.matchId}"`);
      }
      return {
        matchId: stored.matchId,
        replayHash: stored.hash,
        replay: stored.parsed,
        bytes: Buffer.byteLength(stored.body, "utf8"),
      };
    }),
});
