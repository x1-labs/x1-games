// SIWS-style WebSocket auth for the TTT demo.
//
// Protocol:
//   1. Server opens WS → immediately sends ChallengeMsg with nonce + timestamp.
//   2. Client signs   `${DOMAIN}|${nonce}|${timestamp}|${matchId}|${player}`
//      with its ed25519 key.
//   3. Client sends HelloMsg with matchId, player pubkey, and the hex signature.
//   4. Server verifies signature against the claimed pubkey, the nonce it
//      issued for THIS connection, and a fresh timestamp.
//
// Replay safety:
//   - nonce is per-connection (stored server-side until consumed)
//   - timestamp is the server-issued one (echoed by client unchanged)
//   - the same signature can't be used on a different connection (different nonce)
//   - the same signature can't authenticate a different player or match
//     (both are bound into the message)

import nacl from "tweetnacl";

export const DOMAIN = "x1-games-ttt-v0";
export const TIMESTAMP_SKEW_SEC = 60;

export interface ChallengeMsg {
  type: "challenge";
  nonce: string; // 16 hex chars (8 bytes)
  timestamp: number; // unix sec
  domain: string;
}

export interface HelloMsg {
  type: "hello";
  matchId: string;
  player: string; // base58 pubkey
  signature: string; // "0x" + 128 hex chars
}

export function buildSignedPayload(
  nonce: string,
  timestamp: number,
  matchId: string,
  player: string,
): Uint8Array {
  return new TextEncoder().encode(
    `${DOMAIN}|${nonce}|${timestamp}|${matchId}|${player}`,
  );
}

/** Generate a fresh 8-byte hex nonce. */
export function newNonce(): string {
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Sign a hello payload with a Solana secret key (64-byte ed25519 secret). */
export function signHello(
  nonce: string,
  timestamp: number,
  matchId: string,
  player: string,
  secretKey: Uint8Array,
): string {
  const msg = buildSignedPayload(nonce, timestamp, matchId, player);
  const sig = nacl.sign.detached(msg, secretKey);
  return (
    "0x" + Array.from(sig, (b) => b.toString(16).padStart(2, "0")).join("")
  );
}

/** Verify a hello signature. Returns null on success, an error string otherwise. */
export function verifyHello(
  expected: { nonce: string; timestamp: number },
  hello: HelloMsg,
  pubkeyBytes: Uint8Array,
  now: number,
): string | null {
  if (Math.abs(now - expected.timestamp) > TIMESTAMP_SKEW_SEC) {
    return `stale challenge (issued at ${expected.timestamp}, now ${now})`;
  }
  if (!hello.signature.startsWith("0x") || hello.signature.length !== 2 + 128) {
    return "signature has wrong shape (expect 0x + 128 hex chars)";
  }
  let sig: Uint8Array;
  try {
    sig = Uint8Array.from(
      hello.signature
        .slice(2)
        .match(/.{2}/g)!
        .map((b) => parseInt(b, 16)),
    );
  } catch {
    return "signature is not valid hex";
  }
  const msg = buildSignedPayload(
    expected.nonce,
    expected.timestamp,
    hello.matchId,
    hello.player,
  );
  if (!nacl.sign.detached.verify(msg, sig, pubkeyBytes)) {
    return "signature does not verify against player pubkey";
  }
  return null;
}
