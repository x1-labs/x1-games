import type { Platform } from "@x1-labs/games-sdk";

/** Per-request context. The Platform is shared across requests; per-request
 *  fields (auth, request id) will land alongside it in future cycles. */
export interface Context {
  platform: Platform;
}

export function createContextFactory(deps: { platform: Platform }): () => Context {
  return () => ({ platform: deps.platform });
}
