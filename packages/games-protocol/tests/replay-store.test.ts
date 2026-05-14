import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { getDefaultReplayStore, canonicalSha256, type Replay } from "../src/index";

const MATCH_ID = "Br9c7M2NjQDJ4D9KsELRZ2VK6QqYJZ5xWPzCgVnB3uvF";
const SHA = "0x" + "11".repeat(32);

function makeReplay(overrides: Partial<Replay> = {}): Replay {
  return {
    protocolVersion: "v0",
    matchId: MATCH_ID,
    gameId: "demo-game",
    simulatorSha256: SHA,
    seed: "0x" + "ab".repeat(8),
    initialState: { lives: 3 },
    finalState: { score: 100, status: "won" },
    inputs: [{ tick: 0, playerIndex: 0, data: { dir: "right" } }],
    startedAt: 1700000000,
    endedAt: 1700000010,
    ...overrides,
  };
}

const store = getDefaultReplayStore();
beforeEach(() => store.reset());
afterEach(() => store.reset());

describe("ReplayStore.put / .get", () => {
  test("stores and retrieves a replay; hash matches canonicalSha256", () => {
    const r = makeReplay();
    const stored = store.put(r);
    expect(stored.matchId).toBe(MATCH_ID);
    expect(stored.hash).toBe(canonicalSha256(r));

    const got = store.get(MATCH_ID);
    expect(got).not.toBeNull();
    expect(got!.body).toBe(stored.body);
    expect(got!.hash).toBe(stored.hash);
  });

  test("re-put with identical body returns the existing entry (idempotent)", () => {
    const r = makeReplay();
    const a = store.put(r);
    const b = store.put(r);
    expect(b.hash).toBe(a.hash);
    expect(b.storedAt).toBe(a.storedAt);
  });

  test("re-put with different body for the same matchId is rejected", () => {
    store.put(makeReplay({ finalState: { score: 100 } }));
    expect(() => store.put(makeReplay({ finalState: { score: 200 } }))).toThrow(/Conflict/);
  });

  test("get returns null for an unknown matchId", () => {
    expect(store.get("never-stored")).toBeNull();
  });

  test("schema-invalid replay is rejected at put time", () => {
    expect(() =>
      store.put({ ...makeReplay(), protocolVersion: "v1" } as unknown as Replay),
    ).toThrow();
  });

  test("hash on equivalent replays is identical regardless of key order in inputs", () => {
    const a = makeReplay({
      inputs: [{ tick: 0, playerIndex: 0, data: { dir: "right" } }],
    });
    const b = makeReplay({
      // Same logical input, different key order shouldn't matter post-canonicalization.
      inputs: [{ data: { dir: "right" }, playerIndex: 0, tick: 0 } as unknown as Replay["inputs"][0]],
    });
    expect(canonicalSha256(a)).toBe(canonicalSha256(b));
  });
});
