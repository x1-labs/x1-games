// Off-chain attestation: borsh-encoding via Anchor IDL + ed25519 signing.
//
// Single source of truth for the canonical OutcomeEnvelope payload, used by
// both backends (real chain + stub) so envelopes are wire-compatible and
// independently verifiable regardless of which backend produced them.
//
// Canonical signing payload:
//   matchPda (32 bytes) ++ borsh(PostOutcomeArgs)
//
// The borsh layout comes from the chain IDL — no hand-rolled offsets.

import * as anchor from "@coral-xyz/anchor";
import * as web3 from "@solana/web3.js";
import nacl from "tweetnacl";
import bs58 from "bs58";
import type { OutcomeEnvelope } from "@x1-labs/games-protocol";
import matchIdlJson from "./idl/match_program.json" with { type: "json" };
import type { SolanaSigner, WalletLikeSigner } from "./solana.js";

const { BorshCoder, BN } = anchor;
const { PublicKey } = web3;

// One coder, one IDL — the SDK ships the canonical match-program IDL it was
// built against. Verifiers and signers must agree on this layout.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const matchIdl: any = matchIdlJson;
const coder = new BorshCoder(matchIdl);
const U32_BYTES = 4;
const U64_BYTES = 8;
const REPLAY_HASH_BYTES = 32;

/** PostOutcomeArgs as the SDK uses it — camelCase for TS ergonomics. */
export interface PostOutcomeArgs {
  payouts: anchor.BN[];
  /** 32-byte content hash, as a number[] of bytes (matches IDL [u8; 32]). */
  replayHash: number[];
}

/** Anchor's low-level BorshCoder.types uses the IDL's snake_case field names
 *  verbatim (unlike `Program.methods.<name>()` which auto-converts). Translate
 *  at the coder boundary so the rest of the SDK stays in camelCase. */
interface PostOutcomeArgsRaw {
  payouts: anchor.BN[];
  replay_hash: number[];
}

function toRaw(args: PostOutcomeArgs): PostOutcomeArgsRaw {
  return { payouts: args.payouts, replay_hash: args.replayHash };
}

function fromRaw(raw: PostOutcomeArgsRaw): PostOutcomeArgs {
  return { payouts: raw.payouts, replayHash: raw.replay_hash };
}

/** Borsh-encode `PostOutcomeArgs` via the chain IDL. */
export function encodePostOutcomeArgs(args: PostOutcomeArgs): Buffer {
  return coder.types.encode("PostOutcomeArgs", toRaw(args));
}

function assertPostOutcomeArgsShape(bytes: Buffer): void {
  if (bytes.length < U32_BYTES + REPLAY_HASH_BYTES) {
    throw new Error(
      `PostOutcomeArgs is too short: expected at least ${U32_BYTES + REPLAY_HASH_BYTES} bytes, got ${bytes.length}`,
    );
  }

  const payoutCount = bytes.readUInt32LE(0);
  const expectedLength = U32_BYTES + payoutCount * U64_BYTES + REPLAY_HASH_BYTES;
  if (expectedLength !== bytes.length) {
    throw new Error(
      `PostOutcomeArgs length mismatch: payout count ${payoutCount} requires ${expectedLength} bytes, got ${bytes.length}`,
    );
  }
}

/** Decode borsh-encoded `PostOutcomeArgs`. Throws on malformed input. */
export function decodePostOutcomeArgs(bytes: Uint8Array | Buffer): PostOutcomeArgs {
  const buf = Buffer.from(bytes);
  assertPostOutcomeArgsShape(buf);
  const raw: PostOutcomeArgsRaw = coder.types.decode("PostOutcomeArgs", buf);
  return fromRaw(raw);
}

/** Build the canonical bytes the attestor signs: matchPda ++ borsh(args). */
export function outcomeSigningPayload(
  matchPda: web3.PublicKey,
  argsBorsh: Buffer,
): Buffer {
  return Buffer.concat([matchPda.toBuffer(), argsBorsh]);
}

function isKeypair(s: SolanaSigner): s is web3.Keypair {
  return "secretKey" in s && (s as web3.Keypair).secretKey instanceof Uint8Array;
}

/** Sign `payload` with the given signer using ed25519.
 *  - Keypair: signs locally via tweetnacl with the secret key.
 *  - WalletLikeSigner with signMessage: delegates to the wallet.
 *  - WalletLikeSigner without signMessage: throws (no way to produce a sig). */
export async function signMessageWith(
  signer: SolanaSigner,
  payload: Uint8Array,
): Promise<Uint8Array> {
  if (isKeypair(signer)) {
    return nacl.sign.detached(payload, signer.secretKey);
  }
  const wallet = signer as WalletLikeSigner;
  if (typeof wallet.signMessage === "function") {
    const out = await wallet.signMessage(payload);
    return out instanceof Uint8Array ? out : out.signature;
  }
  throw new Error(
    "Signer does not support signMessage — needed to produce the OutcomeEnvelope " +
      "attestation signature. Either construct the Platform with a Keypair, or use a " +
      "wallet adapter that exposes signMessage() (Phantom, Solflare, Backpack, Glow, " +
      "and the @solana/wallet-adapter standard interface all do).",
  );
}

function bytesToHex(b: Uint8Array | Buffer): string {
  return "0x" + Buffer.from(b).toString("hex");
}

function hexToBytes(hex: string): Uint8Array {
  const stripped = hex.startsWith("0x") ? hex.slice(2) : hex;
  return Uint8Array.from(Buffer.from(stripped, "hex"));
}

/** Build the {borsh, signature} pair for an OutcomeEnvelope.
 *
 *  Takes a `sign` callback so the caller chooses how the payload gets signed:
 *  - SolanaBackend passes `(p) => signMessageWith(this.signer, p)` to use the
 *    Platform's Keypair or wallet-adapter signer.
 *  - StubBackend passes a callback that signs with the per-game in-memory
 *    Keypair it generated at registerGame time.
 *
 *  Returns 0x-hex strings ready to drop into the envelope. */
export async function buildEnvelopeAttestation(input: {
  matchPda: web3.PublicKey;
  args: PostOutcomeArgs;
  sign: (payload: Uint8Array) => Promise<Uint8Array>;
}): Promise<{ borsh: string; signature: string }> {
  const argsBorsh = encodePostOutcomeArgs(input.args);
  const payload = outcomeSigningPayload(input.matchPda, argsBorsh);
  const signature = await input.sign(payload);
  return { borsh: bytesToHex(argsBorsh), signature: bytesToHex(signature) };
}

// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  /** Human-readable failure reason. `null` when `ok === true`. */
  reason: string | null;
}

/** Verify the cryptographic integrity of an `OutcomeEnvelope`.
 *
 *  Returns `{ ok: true }` if the envelope's signature is a valid ed25519
 *  signature by `envelope.outcome.attestor` over the canonical payload, AND
 *  the envelope's borsh round-trip-matches the outcome's payouts + replayHash.
 *
 *  Returns `{ ok: false, reason }` otherwise — never throws on bad input.
 *
 *  Does NOT check that the attestor is the one authorized on-chain for the
 *  match. For that, read the Match account on-chain via `platform.getMatch`
 *  and compare its `attestorPubkey` to `envelope.outcome.attestor`. */
export function verifyOutcomeEnvelope(envelope: OutcomeEnvelope): VerifyResult {
  try {
    const matchPda = new PublicKey(envelope.outcome.matchId);
    const argsBorsh = Buffer.from(hexToBytes(envelope.borsh));
    const signature = hexToBytes(envelope.signature);

    let decoded: PostOutcomeArgs;
    try {
      decoded = decodePostOutcomeArgs(argsBorsh);
    } catch (e) {
      return {
        ok: false,
        reason: `borsh field is not a valid PostOutcomeArgs: ${(e as Error).message}`,
      };
    }

    if (decoded.payouts.length !== envelope.outcome.payoutShares.length) {
      return { ok: false, reason: "borsh payouts length differs from outcome.payoutShares" };
    }
    for (let i = 0; i < decoded.payouts.length; i++) {
      if (decoded.payouts[i]!.toString() !== envelope.outcome.payoutShares[i]) {
        return {
          ok: false,
          reason: `borsh payouts[${i}] differs from outcome.payoutShares[${i}]`,
        };
      }
    }
    const replayHashHex =
      "0x" + Buffer.from(Uint8Array.from(decoded.replayHash)).toString("hex");
    if (replayHashHex !== envelope.outcome.replayHash) {
      return { ok: false, reason: "borsh replay_hash differs from outcome.replayHash" };
    }

    const signingPayload = outcomeSigningPayload(matchPda, argsBorsh);
    const attestorBytes = bs58.decode(envelope.outcome.attestor);
    if (attestorBytes.length !== 32) {
      return { ok: false, reason: "attestor is not a 32-byte pubkey" };
    }
    if (signature.length !== 64) {
      return { ok: false, reason: `signature is not 64 bytes (got ${signature.length})` };
    }
    const valid = nacl.sign.detached.verify(signingPayload, signature, attestorBytes);
    if (!valid) {
      return { ok: false, reason: "ed25519 signature does not verify against attestor pubkey" };
    }

    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: (e as Error).message };
  }
}

// `BN` is re-exported so backends can build payouts: anchor.BN[] without
// importing anchor themselves just for the type.
export { BN };
