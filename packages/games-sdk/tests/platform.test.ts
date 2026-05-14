import { describe, expect, test } from "bun:test";
import { Platform } from "../src/index";

describe("Platform.connect", () => {
  test("returns a Platform instance carrying the chosen network", () => {
    const p = Platform.connect({ network: "stub" });

    expect(p).toBeDefined();
    expect(p.network).toBe("stub");
    expect(p.pubkey).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });

  test("rejects an unknown network at construction time", () => {
    expect(() => {
      // @ts-expect-error — deliberate runtime probe
      Platform.connect({ network: "not-a-real-network" });
    }).toThrow(/Unknown network/);
  });

  test("rejects networks that are valid but not yet implemented", () => {
    expect(() => {
      Platform.connect({ network: "x1-mainnet" });
    }).toThrow(/not yet implemented/);
    expect(() => {
      Platform.connect({ network: "x1-devnet" });
    }).toThrow(/not yet implemented/);
  });

  test("two stub platforms get different actor pubkeys", () => {
    const a = Platform.connect({ network: "stub" });
    const b = Platform.connect({ network: "stub" });
    expect(a.pubkey).not.toBe(b.pubkey);
  });
});
