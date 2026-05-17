// In-memory replay store. v0 implementation backing the storage contract
// from INTEGRATION.md §3.4. A process-wide singleton so the SDK and the
// services tRPC tier share state when both run in the same process.
//
// Production storage will be content-addressed object storage (S3-style)
// behind a pre-signed URL flow. The contract this file establishes —
// canonical-JSON-encoded blob keyed by matchId, hash-verifiable — is the
// same in both worlds.

import { Replay } from "./index.js";
import { canonicalJson, canonicalSha256 } from "./canonical.js";

export interface StoredReplay {
  matchId: string;
  /** Canonical JSON bytes as a UTF-8 string. */
  body: string;
  /** SHA-256 of `body`, "0x"-prefixed lowercase hex. */
  hash: string;
  /** Decoded parse of `body`. Cached for quick reads. */
  parsed: Replay;
  storedAt: number;
}

export interface ReplayStoreLimits {
  /** Max body size in bytes. */
  maxBytes: number;
}

const DEFAULT_LIMITS: ReplayStoreLimits = { maxBytes: 5 * 1024 * 1024 };

class InMemoryReplayStore {
  private items = new Map<string, StoredReplay>();
  private limits: ReplayStoreLimits = { ...DEFAULT_LIMITS };

  /** Replace the limits — call before any traffic. */
  configure(limits: Partial<ReplayStoreLimits>): void {
    this.limits = { ...this.limits, ...limits };
  }

  /** Store a replay. Validates schema, canonicalizes, hashes, single-writer
   *  per matchId (rejects re-upload with a different body). */
  put(replay: Replay): StoredReplay {
    Replay.parse(replay);

    const body = canonicalJson(replay);
    const byteLength = Buffer.byteLength(body, "utf8");
    if (byteLength > this.limits.maxBytes) {
      throw new Error(
        `BadRequest: replay body ${byteLength} bytes exceeds limit ${this.limits.maxBytes}`,
      );
    }
    const hash = canonicalSha256(replay);
    const matchId = replay.matchId;

    const existing = this.items.get(matchId);
    if (existing) {
      if (existing.body !== body) {
        throw new Error(
          `Conflict: replay for match "${matchId}" already stored with a different body`,
        );
      }
      return existing;
    }

    const entry: StoredReplay = {
      matchId,
      body,
      hash,
      parsed: replay,
      storedAt: Math.floor(Date.now() / 1000),
    };
    this.items.set(matchId, entry);
    return entry;
  }

  get(matchId: string): StoredReplay | null {
    return this.items.get(matchId) ?? null;
  }

  /** Drop everything. Tests use this between cases. */
  reset(): void {
    this.items.clear();
  }
}

/** Process-wide singleton. */
const STORE = new InMemoryReplayStore();

/** Public handle — both SDK and services consume this. */
export function getDefaultReplayStore(): InMemoryReplayStore {
  return STORE;
}

export type { InMemoryReplayStore };
