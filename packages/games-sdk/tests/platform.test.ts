import { describe, expect, test } from "bun:test";
import web3 from "@solana/web3.js";
import { Platform } from "../src/index";
import { SolanaBackend, type WalletLikeSigner } from "../src/solana";

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

describe("Platform.joinMatch input guard", () => {
  test("rejects unknown fields (e.g. `player`) with a clear error", async () => {
    const p = Platform.connect({ network: "stub" });
    await expect(
      // @ts-expect-error — deliberately passing an unsupported field
      p.joinMatch({ matchId: "abc", player: "someone-else" }),
    ).rejects.toThrow(/unsupported field\(s\): player/);
  });
});

describe("SolanaBackend signer abstraction", () => {
  test("accepts a wallet-adapter–shaped signer (no raw secret key)", () => {
    // A browser wallet exposes only publicKey + sign methods. We only need to
    // verify construction succeeds and actorPubkey is derived correctly — we
    // can't make RPC calls without a live cluster, and chain integration tests
    // already cover the Keypair path end-to-end.
    const kp = web3.Keypair.generate();
    const wallet: WalletLikeSigner = {
      publicKey: kp.publicKey,
      async signTransaction(tx) {
        return tx;
      },
      async signAllTransactions(txs) {
        return txs;
      },
    };
    const backend = new SolanaBackend({
      rpcUrl: "http://127.0.0.1:8899",
      signer: wallet,
    });
    expect(backend.actorPubkey).toBe(kp.publicKey.toBase58());
  });

  test("still accepts a raw Keypair (server-side path unchanged)", () => {
    const kp = web3.Keypair.generate();
    const backend = new SolanaBackend({
      rpcUrl: "http://127.0.0.1:8899",
      signer: kp,
    });
    expect(backend.actorPubkey).toBe(kp.publicKey.toBase58());
  });
});
