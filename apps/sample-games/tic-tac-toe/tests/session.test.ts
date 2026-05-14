import { describe, expect, test } from "bun:test";
import { TttSession } from "../src/session";

const PLAYER_X = "9xQeWvG816bUx9EPa2Lh9KqWa1KcvqtfgUnTeMSPMuLP";
const PLAYER_O = "Br9c7M2NjQDJ4D9KsELRZ2VK6QqYJZ5xWPzCgVnB3uvF";
const STRANGER = "AttkX3uvJ9KsELRZ2VK6QqYJZ5xWPzCgVnB3uvFnK8Mz";
const MATCH_ID = "MatchPdaXYZeWvG816bUx9EPa2Lh9KqWa1KcvqtfgUn";
const SEED = "0x7a3f2c91d4e08b15";

function newSession() {
  return new TttSession({
    matchId: MATCH_ID,
    players: [PLAYER_X, PLAYER_O],
    seed: SEED,
  });
}

describe("TttSession", () => {
  test("constructor binds player[0] = X, player[1] = O", () => {
    const s = newSession();
    expect(s.symbolFor(PLAYER_X)).toBe("X");
    expect(s.symbolFor(PLAYER_O)).toBe("O");
  });

  test("submitMove accepts a move from the player whose turn it is", () => {
    const s = newSession();
    const after = s.submitMove({ player: PLAYER_X, cell: 4 });
    expect(after.board[4]).toBe("X");
    expect(after.turn).toBe("O");
  });

  test("submitMove rejects out-of-turn moves", () => {
    const s = newSession();
    expect(() => s.submitMove({ player: PLAYER_O, cell: 0 })).toThrow(/not your turn/i);
  });

  test("submitMove rejects an unknown player", () => {
    const s = newSession();
    expect(() => s.submitMove({ player: STRANGER, cell: 0 })).toThrow(/not a participant/i);
  });

  test("plays out a full game to a winner", () => {
    const s = newSession();
    // X wins top row: 0,1,2. O plays 3,4.
    s.submitMove({ player: PLAYER_X, cell: 0 });
    s.submitMove({ player: PLAYER_O, cell: 3 });
    s.submitMove({ player: PLAYER_X, cell: 1 });
    s.submitMove({ player: PLAYER_O, cell: 4 });
    const final = s.submitMove({ player: PLAYER_X, cell: 2 });
    expect(final.status).toBe("won");
    expect(final.winner).toBe("X");
    expect(s.winnerPubkey()).toBe(PLAYER_X);
  });

  test("plays to a draw", () => {
    const s = newSession();
    [0, 1, 2, 5, 4, 8, 3, 6, 7].forEach((cell) => {
      const p = s.state.turn === "X" ? PLAYER_X : PLAYER_O;
      s.submitMove({ player: p, cell });
    });
    expect(s.state.status).toBe("draw");
    expect(s.winnerPubkey()).toBeNull();
  });

  test("isTerminal reflects current status", () => {
    const s = newSession();
    expect(s.isTerminal()).toBe(false);
    s.submitMove({ player: PLAYER_X, cell: 0 });
    s.submitMove({ player: PLAYER_O, cell: 3 });
    s.submitMove({ player: PLAYER_X, cell: 1 });
    s.submitMove({ player: PLAYER_O, cell: 4 });
    s.submitMove({ player: PLAYER_X, cell: 2 });
    expect(s.isTerminal()).toBe(true);
  });

  test("replay() returns the inputs and seed needed to reproduce the match", () => {
    const s = newSession();
    s.submitMove({ player: PLAYER_X, cell: 4 });
    s.submitMove({ player: PLAYER_O, cell: 0 });
    const r = s.replay();
    expect(r.matchId).toBe(MATCH_ID);
    expect(r.seed).toBe(SEED);
    expect(r.inputs).toHaveLength(2);
    expect(r.inputs[0]).toEqual({ tick: 0, playerIndex: 0, data: { cell: 4 } });
    expect(r.inputs[1]).toEqual({ tick: 1, playerIndex: 1, data: { cell: 0 } });
  });
});
