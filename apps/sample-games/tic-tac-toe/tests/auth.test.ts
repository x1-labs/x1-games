import { describe, expect, test } from "bun:test";
import nacl from "tweetnacl";
import { PublicKey } from "@solana/web3.js";
import {
  DOMAIN,
  TIMESTAMP_SKEW_SEC,
  buildSignedPayload,
  newNonce,
  signHello,
  verifyHello,
} from "../src/auth";

// Solana keypairs ARE tweetnacl-compatible ed25519 pairs; using tweetnacl
// directly here keeps the test free of higher-level wrappers.
function genKeypair() {
  const kp = nacl.sign.keyPair();
  return {
    secretKey: kp.secretKey,
    publicKey: kp.publicKey,
    base58: new PublicKey(kp.publicKey).toBase58(),
  };
}

const MATCH = "MatchPdaXYZeWvG816bUx9EPa2Lh9KqWa1KcvqtfgUn";

describe("auth", () => {
  test("newNonce returns 16 hex chars", () => {
    const n = newNonce();
    expect(n).toMatch(/^[0-9a-f]{16}$/);
    expect(n).not.toBe(newNonce()); // randomness, not constant
  });

  test("verifyHello accepts a signature produced by signHello", () => {
    const kp = genKeypair();
    const nonce = newNonce();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHello(nonce, ts, MATCH, kp.base58, kp.secretKey);
    const result = verifyHello(
      { nonce, timestamp: ts },
      { type: "hello", matchId: MATCH, player: kp.base58, signature: sig },
      kp.publicKey,
      ts + 1,
    );
    expect(result).toBeNull();
  });

  test("verifyHello rejects a signature from the wrong key", () => {
    const owner = genKeypair();
    const imposter = genKeypair();
    const nonce = newNonce();
    const ts = Math.floor(Date.now() / 1000);
    // Imposter signs claiming to be the owner.
    const sig = signHello(nonce, ts, MATCH, owner.base58, imposter.secretKey);
    const result = verifyHello(
      { nonce, timestamp: ts },
      { type: "hello", matchId: MATCH, player: owner.base58, signature: sig },
      owner.publicKey,
      ts,
    );
    expect(result).toMatch(/does not verify/);
  });

  test("verifyHello rejects a stale timestamp", () => {
    const kp = genKeypair();
    const nonce = newNonce();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHello(nonce, ts, MATCH, kp.base58, kp.secretKey);
    const result = verifyHello(
      { nonce, timestamp: ts },
      { type: "hello", matchId: MATCH, player: kp.base58, signature: sig },
      kp.publicKey,
      ts + TIMESTAMP_SKEW_SEC + 5,
    );
    expect(result).toMatch(/stale/);
  });

  test("verifyHello rejects a different matchId than what was signed", () => {
    const kp = genKeypair();
    const nonce = newNonce();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHello(nonce, ts, MATCH, kp.base58, kp.secretKey);
    // Server thinks the hello is for a different match.
    const result = verifyHello(
      { nonce, timestamp: ts },
      { type: "hello", matchId: "DifferentMatchABC", player: kp.base58, signature: sig },
      kp.publicKey,
      ts,
    );
    expect(result).toMatch(/does not verify/);
  });

  test("verifyHello rejects a signature with the wrong nonce", () => {
    const kp = genKeypair();
    const nonceA = newNonce();
    const nonceB = newNonce();
    const ts = Math.floor(Date.now() / 1000);
    const sig = signHello(nonceA, ts, MATCH, kp.base58, kp.secretKey);
    // Server expects nonceB but client signed nonceA.
    const result = verifyHello(
      { nonce: nonceB, timestamp: ts },
      { type: "hello", matchId: MATCH, player: kp.base58, signature: sig },
      kp.publicKey,
      ts,
    );
    expect(result).toMatch(/does not verify/);
  });

  test("verifyHello rejects malformed signatures", () => {
    const kp = genKeypair();
    const ts = Math.floor(Date.now() / 1000);
    const result = verifyHello(
      { nonce: newNonce(), timestamp: ts },
      { type: "hello", matchId: MATCH, player: kp.base58, signature: "0xabcd" },
      kp.publicKey,
      ts,
    );
    expect(result).toMatch(/wrong shape/);
  });

  test("buildSignedPayload is stable", () => {
    const a = buildSignedPayload("nnnn", 1, "m", "p");
    const b = buildSignedPayload("nnnn", 1, "m", "p");
    expect(a).toEqual(b);
    const decoded = new TextDecoder().decode(a);
    expect(decoded).toBe(`${DOMAIN}|nnnn|1|m|p`);
  });
});
