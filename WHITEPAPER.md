# X1 Games

### A Settlement Layer for Wagered Play on X1

*Draft v0.5 — 2026-05-12*

---

## Abstract

X1 Games is a gaming platform on the X1 blockchain whose core product is not a game but a **settlement primitive**: a Solana-style on-chain program that takes stakes from players, holds them in escrow, accepts a signed game outcome, and pays the winner. Individual games — single-player skill challenges, head-to-head matches, async tournaments — are clients of this primitive. They run off-chain at native speed; the chain only sees deposits, outcomes, and payouts.

The platform ships four things: (1) a **Match program** with a standard account layout, (2) an **outcome attestation** framework with multiple trust models so each game can pick the right one, (3) an **SDK** (`@x1-labs/games-sdk`) that lets a solo developer — or an AI agent — wire a new game into matchmaking, escrow, identity, and leaderboards in a weekend, and (4) a **public API** (tRPC-canonical, with a generated REST shim) powering discovery, lobbies, and replays for our own UI and any third-party client.

The off-chain runtime is **managed first, self-hosted as the goal**: in v1 most games ship by uploading a deterministic simulator and a frontend to our managed infrastructure, with the platform acting as the attestor. The off-chain services are open-source from day one so any builder can fork and self-host once they have reason to. Developer access is **tiered permissionless with a bond**: a free Demo tier for anyone (including agents), a bonded Live tier for real-stakes play (default bond 100 XNT, configurable per game), and a Featured tier curated by an on-chain multisig committee. The org behind the platform is **x1-labs**.

The token model is treated in depth in §7. The decision is a **four-layer separation of concerns**: XNT for value, soulbound per-game XP for progression signal, transferable per-game achievement NFTs for collectibility and builder royalties, and an optional per-game sink token (deferred from v1) for in-game spend. Each layer has exactly one job. §7.7 documents the failure patterns this structure exists to avoid — single-token-does-everything, play-to-earn mintable tokens, decaying-emission FOMO curves, and platform-wide transferable tokens.

---

## 1. Motivation

Most "web3 gaming" projects fail in one of two ways. Either they put game state on-chain and end up with a slow, expensive, joyless product; or they ship a token before they ship a game, and the token economy collapses under speculative pressure with no underlying play to support it.

We start from the opposite premise. The chain is good at exactly one thing in this domain: **trust-minimized settlement of value between players who do not know each other**. Everything else — rendering, physics, matchmaking, replays, social — is better done off-chain. The platform's job is to make settlement so cheap and so safe that staking real value on a game outcome stops being a novelty and becomes the default mode of competitive play.

X1 makes this premise tractable. It is an SVM-compatible Layer-1 fork of Solana with a deliberate set of economic and performance enhancements: a 16–32-thread transaction scheduler (4–8× upstream Solana's parallelism), VRF-based leader selection with an Anti-Collusion Protocol, a dynamic EIP-1559-style base fee with native burn, native MEV capture redistributed to validators rather than private builders, and staking-discounted base fees. Crucially, X1 is monolithic — atomic composability and high-speed transaction finality at the base layer are an explicit thesis, with L2s rejected as centralizing. For us this means settlement is genuinely at the base layer: we never bridge or batch, and a thousand matches can settle in parallel in the same slot because each writes to its own PDAs. The cost of an on-chain settlement is dominated by signature verification and a small amount of state writes — well below what would justify routing it off-chain.

If we get this right, the network effect is on the *developer* side, not the player side. A solo dev or an AI agent that wants to ship a wagered game should pick X1 Games for the same reason a solo dev picks Stripe over building card processing: the platform absorbs the parts that are hard, regulated, or easy to get wrong.

---

## 2. Audiences

X1 Games has two audiences and the platform's surface area must serve both.

### 2.1 Players

Anyone with an X1 wallet. We assume they hold XNT, can sign transactions, and want to play games with real stakes. We do **not** assume they understand bonding curves, mint authorities, or program-derived addresses. The player UX never mentions any of these.

Players come to the platform for games, not for the platform. Branding and discovery happen at the game level; X1 Games is the trust layer underneath.

### 2.2 Builders

Three sub-audiences, treated as one with the same SDK:

1. **The existing X1 / SVM developer crowd.** Familiar with Anchor, SPL tokens, PDAs, and the rent model. The SDK must feel idiomatic to them — typed Rust on the program side, typed TS on the client side — and must not paper over Solana account model details when they matter.
2. **Game developers from outside crypto.** Care about gameplay, not about chains. The SDK must give them a path where they never write program code, never reason about lamports, and never see a transaction. They write a game server, hand us signed outcomes, and we handle the rest.
3. **AI agents building games autonomously.** A growing share of new games will be built end-to-end by agents — possibly a single user prompting a coding agent to "make me a game". This audience is real, will be larger than the others by Phase 2, and shapes SDK design in specific ways (§8.3).

These three audiences look different but want the same thing: a small, typed, deterministic, well-documented surface that does what it says.

---

## 3. Design Principles

1. **Settlement on-chain, gameplay off-chain.** No frame, input, or game state touches the chain unless it is load-bearing for settlement.
2. **Outcomes are signed messages, not transactions.** A game produces a small attested artifact; the chain verifies signatures and pays out.
3. **One primitive, many trust models.** The same Match program supports trusted-operator, co-signed, optimistic-with-dispute, and (eventually) ZK-attested outcomes. Game devs pick the model that fits.
4. **Boring value flow.** XNT for stakes and payouts. Rake, not inflation, funds the platform.
5. **No platform token in v1.** A platform-wide transferable token is deferred until a concrete need exists that XNT cannot meet. See §7.
6. **Agent-friendly by construction.** Every primitive is reachable from a typed, idempotent, schema-described SDK call. Behaviors that are obvious to humans (retry semantics, error categories, idempotency keys) are made explicit so agents can act on them without guessing.
7. **Solo-builder friendly.** If integrating a new game takes more than a weekend, the SDK is wrong.
8. **Managed first, self-hosted as the goal.** The off-chain runtime ships as a managed service for v1 to minimize builder friction, but the services are open-source and a self-hosted path is a first-class option from day one. The hosted instance is the well-supported example of code anyone can run, never a private monolith.
9. **Permissionless with skin in the game.** Anyone — human or agent — can register a Demo-tier game with no gatekeeper. Real-stakes play requires a slashable bond. Editorial promotion (Featured tier) is the only place we are explicitly curatorial, and that curation runs through an on-chain multisig.

---

## 4. Architecture Overview

> **[ INSERT FIGURE 1 HERE ]** — file: [`diagrams/architecture.png`](diagrams/architecture.png) · vector: [`diagrams/architecture.svg`](diagrams/architecture.svg)

*Figure 1 — X1 Games architecture. Off-chain (amber): Game Client, matchmaking, simulator, replay storage, attestors. On-chain (mint): Match / Game-registry / XP-ledger programs and Treasury. The bridge between them is a signed outcome message.*

The chain holds value and final state, expressed as PDAs derived from `(gameId, matchNonce)` and similar seeds. The off-chain services hold everything else, and produce signed outcomes that the chain accepts as truth (subject to the attestation model in use).

Three programs do the work:

- **Match program** — creation, funding, settlement, dispute, payout. Holds stake in a per-match vault PDA. The only program a game dev's server must touch.
- **Game registry program** — game IDs, attestor public keys, allowed attestation models, simulator references, dev-side revenue receiver.
- **XP ledger program** — soulbound per-game XP balances and earn/spend events.

X1's parallelism story is a real win here. Sealevel-style parallel execution — extended on X1 to a 16–32-thread scheduler, 4–8× upstream Solana — means thousands of matches can settle in the same slot without contending, because each match writes to its own PDAs. The platform scales horizontally with games and players for essentially free.

---

## 5. The Match Primitive

A **Match** is an on-chain account that holds stakes, knows who is allowed to settle it, and pays out when settlement arrives. It is the only contract a game developer must understand.

### 5.1 Lifecycle

```
  CREATED ──► FUNDED ──► LIVE ──► SETTLED ──► PAID
                  │                   │
                  └── EXPIRED         └── DISPUTED ──► RESOLVED
```

- **CREATED**: a match is opened with a game ID, stake per seat, seat count, attestation model, and timeout.
- **FUNDED**: seats fill as players deposit stakes into the match vault PDA.
- **LIVE**: the game runs off-chain. The chain does not care what happens here.
- **SETTLED**: a valid outcome attestation is submitted on-chain.
- **PAID**: winnings (pot minus rake) are released; XP is credited; the match closes and the vault is drained.
- **EXPIRED**: if the match never reaches LIVE, stakes are returned.
- **DISPUTED / RESOLVED**: only used by attestation models that support challenges.

### 5.2 Account layout sketch

Anchor-flavored pseudocode. Final form depends on X1's exact program model.

```rust
#[account]
pub struct Match {
    pub game_id: Pubkey,           // PDA of the registered game
    pub seats: u8,
    pub stake_per_seat: u64,       // lamports of XNT
    pub rake_bps: u16,
    pub funding_deadline: i64,
    pub settlement_deadline: i64,
    pub model: AttestationModel,   // Trusted | Cosigned | Optimistic | Zk
    pub state: MatchState,
    pub players: Vec<Pubkey>,      // filled as seats are taken
    pub outcome: Option<Outcome>,
    pub bump: u8,
}

#[account]
pub struct Outcome {
    pub winners: Vec<Pubkey>,
    pub payout_shares: Vec<u64>,   // sums to pot - rake
    pub replay_hash: [u8; 32],     // commitment to off-chain replay
    pub posted_at: i64,
    pub finalized_at: Option<i64>, // set after challenge window for optimistic
}

// Instructions: create_match, join_match, post_outcome,
//               dispute_outcome, finalize_match, refund_match.
```

Solo play is `seats = 1` with the **house** (a platform-controlled account funded from rake — see §13) putting up the prize. Tournaments are a tree of Matches sharing a `game_id`. PvP is the obvious two-seat case.

The vault is a separate PDA owned by the Match program. This keeps lamport custody isolated from match metadata and lets the indexer attribute fund movements precisely.

---

## 6. Outcome Attestation Models

The hardest question in wagered gaming is *who decides who won*. No single answer fits every game, so the Match program supports four models — ranked by trust assumption — chosen **per match**, not per game. A single game can run a free-play tier under TRUSTED and a high-stakes tier under OPTIMISTIC.

### 6.1 TRUSTED (operator-signed)

A single attestor — typically the game's server, or X1 Games itself for first-party games — signs the outcome. Fastest, cheapest, simplest. Players trust the attestor.

**Use when**: launching a new game, single-player skill games where the score is server-computed, low-stakes casual play, or any case where the operator has more to lose from cheating than to gain. This is the v1 default.

### 6.2 COSIGNED (n-of-n player signatures)

All players sign the agreed outcome before it goes on-chain. Trustless among the players. Breaks if any player is unreachable or unwilling, so it must combine with an idle-timeout fallback that grants the present player a forfeit win.

**Use when**: 2-player turn-based games with full information (chess, checkers, connect-four, simple card games with public state).

### 6.3 OPTIMISTIC (post-and-challenge)

An attestor posts an outcome. A challenge window opens (e.g. 1 hour). During the window, any party can submit evidence — typically a replay segment that, when re-simulated deterministically, contradicts the posted outcome. If unchallenged, the outcome stands.

**Use when**: deterministic single-player games where any third party can re-simulate. Pacman fits this exactly; so does any tick-deterministic arcade game.

A note on Solana compute limits: the SVM has a per-transaction compute budget. Full on-chain re-simulation of a whole game is usually infeasible inside one transaction. The dispute protocol therefore operates on **contested segments**: the challenger names a divergence point, both parties provide the simulator state just before it, and the program re-runs a small fixed number of ticks. This is bisection-style fraud proof, adapted for game replays. X1's larger thread count helps system-wide throughput (many disputes can run in parallel) but does not raise per-transaction compute budget, so this bisection structure is required regardless.

### 6.4 ZK (proof of correct execution)

The game server produces a zero-knowledge proof that the outcome is the result of running the canonical simulator on a sequence of inputs. The chain verifies the proof. Trustless and non-interactive.

ZK verification on Solana is real but currently expensive and toolchain-heavy. This is a v2+ option, not v1. When ZK arrives, it most naturally fits async high-stakes single-player matches where the simulator is small and tick-deterministic.

### 6.5 Choosing per match

`AttestationModel` is set at match creation. The SDK exposes it as a server-side config and the lobby surfaces it to players as a **trust badge**: a glance tells a player whether their stake is protected by operator reputation, by their counterparty's signature, by a public dispute window, or by a math proof. The badge is the user-facing summary of the trust assumption — and surfacing it honestly is part of what makes the platform credible.

### 6.6 Worked examples

Two end-to-end flows make the abstract lifecycle and the trust models concrete. Each shows exactly which steps cross the on-chain boundary (mint lane) and which stay off-chain (amber lanes).

#### 6.6.1 Solo game — single player vs house, OPTIMISTIC attestation

> **[ INSERT FIGURE 2 HERE ]** — file: [`diagrams/flow-solo.png`](diagrams/flow-solo.png) · vector: [`diagrams/flow-solo.svg`](diagrams/flow-solo.svg)

*Figure 2 — Solo game flow. Player stakes 5 XNT, house puts up 50 XNT, rake 3%. The game server runs the canonical simulation and signs the outcome (TRUSTED-style attestation); the chain opens a challenge window before finalizing (OPTIMISTIC-style dispute window). On-chain steps: 3 (createMatch + house funding), 6 (player deposit), 10 (post outcome), 11 (finalize after window), 12 (atomic payout + rake + XP). Everything else is off-chain.*

The interesting structural property here: there are only **four on-chain transactions** in the whole flow (create, deposit, post, finalize-and-pay). The game itself — input handling, simulation, score computation — is entirely off-chain. The chain is invoked once at the start to lock value, once at the end to release it, with one optional dispute window in between.

#### 6.6.2 Competitive game — two-seat PvP, COSIGNED attestation

> **[ INSERT FIGURE 3 HERE ]** — file: [`diagrams/flow-competitive.png`](diagrams/flow-competitive.png) · vector: [`diagrams/flow-competitive.svg`](diagrams/flow-competitive.svg)

*Figure 3 — Competitive game flow. Two players each stake 5 XNT (pot 10), rake 3%. Both players sign the agreed outcome before it goes on-chain — no dispute window is needed because the attestation is itself the agreement. On-chain steps: 4 (createMatch), 6 (A deposit), 7 (B deposit), 11 (post outcome with both signatures), 12 (verify + finalize), 13 (atomic payout + rake + XP).*

Compared to the solo flow, the trust assumption is stronger (no operator trust required) but the liveness assumption is weaker (a non-responsive player must be handled by an idle-timeout forfeit, step 8). Both deposits are independent transactions; the chain only treats the match as funded once both have landed. The `post_outcome` transaction carries two ed25519 signatures and is well within X1's per-transaction compute budget.

These two flows together cover the v1 product surface: TRUSTED/OPTIMISTIC for skill-class single-player and COSIGNED for full-information PvP. The same Match program serves both, parameterized only by `AttestationModel` and `seats`.

---

## 7. Token Model

This section is treated in depth because it is the single most consequential design decision in the platform, and the one most often gotten wrong by predecessors.

### 7.1 The decision

X1 Games adopts a **four-layer token model**, with each layer doing exactly one job:

| Layer | Type | Transferable? | Earned by play? | Purpose |
|---|---|---|---|---|
| **XNT** | Native chain asset | Yes | No | Stakes, payouts, rake, all value movement |
| **XP** | Per-game ledger entry | **No (soulbound)** | Yes | Matchmaking, ranking, anti-cheat signal |
| **Achievement NFTs** | Per-game SPL NFT | **Yes** | Yes (at milestones) | Collectibility, status, FOMO via scarcity, builder revenue via royalties |
| **In-game sink token** *(optional, per-game)* | Per-game SPL token | Yes | **No — bought with XNT** | Spend-only currency: cosmetics, premium entries, NFT crafting |

The fourth layer is **opt-in per game** and **deferred from v1**. Ship the first three. Revisit the sink token only when a specific game can argue it solves a problem that XNT-direct-spend cannot.

### 7.2 Why these four layers do four different jobs

The structural insight is that **every previous attempt at on-chain gaming tokens has failed by making one token do two jobs at once.** When a token is both *earned-by-play* and *transferable-as-money*, the speculative tail wags the gameplay dog. When a progression signal is *purchasable*, it stops being a signal. When a "platform token" tries to be *value*, *governance*, *loyalty*, and *speculation* simultaneously, none of those jobs are done well.

Separating the layers means:

- **XNT does *money*.** Stakes, pots, rake, treasury. One unit account, one place value lives. No bridging, no wrapping, no per-game value tokens that the platform has to support.
- **XP does *signal-of-play*.** Because it is soulbound, owning XP means you played. It is a credible input to matchmaking, ranking, anti-sybil, and "have they earned this match" gating. If XP were transferable, it would mean nothing and everything that depends on it would break.
- **NFTs do *status + collectibility + liquidity*.** Bounded by event, season, or rank — not by emission curve. Players who want upside, gifting, and secondary markets have a real path. Game developers earn from royalties on the trades.
- **Sink token (if used) does *abstracted-spend UX*.** Strictly spending, never earning. Functionally a prepaid in-game currency.

The point of this section is to make those single-job assignments explicit, so that no later proposal — including ones that sound clever — re-collapses the layers.

### 7.3 XNT — the value layer

All stakes, payouts, rake, treasury flows, and house funding are denominated in XNT, the X1 native token. No wrapping. No synthetics. No per-game stablecoins. No pegs.

The deliberate consequence: there is only one transferable unit of value on the platform, and the chain itself is the canonical custodian of it. Match vaults are XNT-denominated PDAs (§5). Rake is XNT. The treasury holds XNT. Prize pools are XNT.

### 7.4 XP — soulbound, per-game, the progression signal

Each game has its own XP ledger, expressed as a per-(game, player) account on the XP ledger program. XP is **non-transferable, non-redeemable, non-burnable from the outside.** It can be earned by playing or winning, and the chain stores the balance and emits earn events; nothing more.

XP unlocks whatever the game itself chooses to grant: leaderboard tiers, matchmaking buckets, seasonal eligibility, cosmetic flair, gating into higher-stake pools. Crucially, **XP does not have a market price.** This is the single property that makes XP useful — and the single property the rejected patterns in §7.7 destroyed.

If a game wants reputation-portable-across-games, the answer is an aggregate **reputation score** derived on the indexer from XP balances across games, not a transferable token. Reputation is a read-only projection, not an asset.

### 7.5 Achievement NFTs — transferable, per-game, the collectibility layer

Achievement NFTs are per-game SPL NFTs minted on milestone events: first win at stake tier X, top-N finish in a season, completing a hard achievement, ranking gold/platinum/champion in a season, participating in a tournament. They are **transferable**, so a secondary market for badges and trophies emerges naturally.

Three structural properties matter:

1. **Scarcity is by event, not by emission curve.** A "Season 3 Top 100" badge has exactly 100 holders for that game forever. There is no inflation schedule to defend.
2. **FOMO comes from rarity, not from a clock.** Seasonal NFTs create the urgency that decaying-mint tokens are usually trying to produce, without any of the failure modes (§7.7.3).
3. **Game developers earn royalties on secondary trades.** Combined with rake-split (§13.2), this gives builders two independent revenue streams: rake on every settled match, royalties on every badge trade. Successful games become real businesses on both axes.

Achievement NFTs are a Phase-2 ship (see §14). The v1 priority is settlement and gameplay; NFT issuance lands once we know which milestones players actually care about.

### 7.6 In-game sink token — optional, per-game, deferred

A game *may* define a per-game SPL sink token, used for in-game spending: cosmetics, premium tournament entry fees, NFT minting credits, gifting/tipping mechanics. Two strict rules apply:

- **Cannot be earned by playing.** Acquired only by trading XNT for it via the game's own swap.
- **Cannot be required for core gameplay or competitive advantage.** No pay-to-win. The sink token may unlock cosmetics and conveniences only — never matchmaking advantage, never starting resources, never anything that affects who wins a wagered match.

In practice, the sink token is one UX layer away from "just charging XNT directly." Most games should skip it. It exists in the model as an opt-in escape valve for games whose UX genuinely benefits from an abstracted currency (e.g., a casual social game where displaying "100 coins" feels right and "0.04 XNT" doesn't).

**Defer this layer entirely from v1.** Revisit when a specific game argues it can't ship without it.

### 7.7 Patterns we deliberately rejected, and what killed them

The decision in §7.1 is shaped by a set of recurring failure patterns in earlier on-chain gaming projects. We name them here so future proposals can be evaluated against the same bar.

#### 7.7.1 One token does everything

**Pattern.** A single fungible token serves as value, progression, governance, and speculation. Player earns it, spends it, stakes it, governs with it.

**Why it fails.** The four jobs have opposing incentive structures. *Value* wants stability and broad holding. *Progression* wants to be unforgeable and meaningful. *Governance* wants concentration to be costly. *Speculation* wants volatility and emission asymmetry. No token can serve all four simultaneously; one job's needs always degrade another's. In practice, speculation wins and the other three jobs are abandoned.

**How our model avoids this.** Each layer has one job. XNT is value; XP is signal; NFTs are collectibles; sink tokens are spend. The jobs don't compete because they live in different objects.

#### 7.7.2 The play-to-earn pattern (mintable, play-earned, transferable per-game token)

**Pattern.** Each game mints its own fungible SPL token. Players earn it by playing. It is transferable, listed on DEXes, holdable as a store of value. Token price becomes a proxy for game success.

**Canonical failures.** Axie Infinity's SLP — the play-earned token paired with AXS — collapsed once player growth slowed: SLP price tracked new-player inflow, and when inflow stalled the in-fiat earning rate dropped, players (especially scholarship-economy players) left, price dropped further, and the loop inverted. StepN's GST followed the same arc on a faster timeline. The pattern has been retried at smaller scale dozens of times with the same result.

**Why it fails (structural, not tuning).** When the thing players earn has a market price, players become labor and the game becomes a job. Labor flees when wages drop. Wages drop when token price drops. Token price drops when new-player demand softens. New-player demand softens because the only reason to onboard was the earning rate. Every link in the chain reinforces the next. This is not solvable by emission tuning; the loop is built into the token's existence.

**How our model avoids this.** XP is soulbound, so playing produces no transferable asset. Achievement NFTs are transferable but bounded by event, not by emission, so there is no curve to defend and no marginal-new-supply value to collapse.

#### 7.7.3 Decaying-emission curves as a FOMO mechanic

**Pattern.** A fungible per-game token issued on a decaying schedule — high emission early, tapering later — used as a deliberate urgency mechanic to drive launch acquisition.

**Why it fails.** The decaying curve amplifies the §7.7.2 failure mode rather than mitigating it. Early miners (often bots running at scale) extract disproportionate value; latecomers buy in expecting appreciation that the curve cannot deliver once it flattens; price collapses into latecomers' bids; everything in §7.7.2 then plays out faster. The FOMO mechanic optimizes for weeks 1–4 acquisition and is catastrophic for month-6+ retention — which is the opposite of what a repeat-play wager platform needs.

**Regulatory note.** A token with a declining issuance schedule, secondary trading, and platform-marketed scarcity hits Howey test prongs cleanly. The FOMO marketing itself is the investment-expectation prong.

**How our model avoids this.** FOMO is implemented through seasonal NFTs and ranked play — finite, identity-flavored scarcity that produces urgency without producing a market in marginal supply.

#### 7.7.4 Platform-wide transferable token

**Pattern.** A single token issued by the platform, used across all games for fee discounts, governance, loyalty, or staking.

**Why it fails (or rather: why it adds nothing).** It competes with XNT (which is already a transferable value token on X1). Either it pegs to XNT, in which case it is redundant, or it floats, in which case it is a speculative wrapper that pulls product focus onto tokenomics. Every platform-token project we have seen has eventually become a tokenomics project, with founder attention pulled away from gameplay and game-developer onboarding.

**How our model avoids this.** No platform token in v1. The bar for ever adding one: *what does this enable that XNT plus per-game NFTs cannot, and what concretely breaks if we do not have it?* "Marketing" and "community" are not answers. If the answer is "governance," that is its own debate and deserves its own design document.

#### 7.7.5 All-soulbound (no transferable layer)

**Pattern.** Both XP and NFTs are soulbound. Nothing is transferable except XNT itself.

**Why we rejected this** (even though it is the most conservative option). It leaves no liquidity path for collectors, no secondary-market royalty stream for developers, no gifting, no FOMO mechanic stronger than a leaderboard screenshot. The transferable-NFT layer is bounded enough that it does not reintroduce §7.7.1–7.7.3's failure modes, and gives up too much upside to omit.

### 7.8 House accounts and prize pools

Single-player matches are funded by **house accounts**: platform-controlled XNT pools that put up the prize. House accounts are funded from a slice of competitive-match rake. This creates one closed value loop on the platform — rake from PvP funds prize pools for skill play — and that loop is transparent and on-chain. The steady-state behavior of this loop is an open question (§15).

---

## 8. Game Developer SDK

The SDK is the platform's external surface. Everything in §4–7 must be reachable from idiomatic, typed code, and friendly to AI-agent builders.

### 8.1 Registration

Game registration writes a signed entry to the on-chain Game Registry (§4) and commits the simulator hash. Updates to any field require a signature from the dev key.

```ts
import { Platform } from "@x1-labs/games-sdk";

const platform = Platform.connect({ network: "x1-mainnet" });

await platform.registerGame({
  id: "pacman",
  displayName: "Pacman",
  tier: "DEMO",                          // DEMO | LIVE | FEATURED (§11)
  runtime: "MANAGED",                    // MANAGED | SELF_HOSTED (§10)
  attestationModels: ["TRUSTED", "OPTIMISTIC"],
  simulator: {
    kind: "wasm",
    uri: "ipfs://...",
    sha256: "0x...",                     // hash committed on-chain
  },
  devPubkey: "...",                      // principal — authorizes updates
  attestorPubkey: "...",                 // signs outcomes; may equal devPubkey
  revenueReceiver: "...",                // dev-side rake destination
  metadataUri: "ipfs://...",             // display name, screenshots, links
});
```

For SELF_HOSTED runtime, `attestorPubkey` is the builder's own signer. For MANAGED runtime, the SDK can request the platform to mint and hold the attestor key on the game's behalf and return its pubkey — the game dev never sees the private material.

### 8.2 Hosting a match

```ts
const match = await platform.createMatch({
  gameId: "pacman",
  seats: 1,
  stakePerSeat: XNT(5),
  housePrize: XNT(50),
  model: "OPTIMISTIC",
  fundingDeadline: minutes(2),
  idempotencyKey: "lobby-7af3...",   // see §8.3
});

// ... player joins, plays ...

await match.settle({
  winners: [playerAddr],
  payoutShares: [match.pot.minusRake()],
  replayHash: hashReplay(replay),
  attestation: await server.sign(outcome),
});

await replayStore.put(match.id, replay); // for challengers
```

### 8.3 Agent-friendliness

A growing share of new games will be built end-to-end by AI agents. We design for this explicitly:

- **Idempotency keys on every state-changing call.** An agent that retries after a timeout never duplicates a match, double-charges a player, or double-credits XP.
- **Typed errors, not strings.** Every error is a discriminated union with a category (`InsufficientFunds`, `MatchNotInState`, `AttestorRejected`, ...) and a machine-readable detail. Agents handle errors by branching on the category; humans get a readable message for free.
- **Dry-run mode on every action.** `createMatch.dryRun({...})` returns the exact account changes and lamport movement that would occur, without sending a transaction. Agents (and humans) can verify intent before committing.
- **Schema-described primitives.** The SDK ships JSON Schema / Zod schemas for every input and output, and an MCP server that exposes platform actions as agent tools. An agent integrates the platform by reading the MCP schema, not by reading docs.
- **Permission scopes.** API keys are scoped (`game:create`, `match:settle:pacman`, `xp:credit:pacman`). A compromised agent key cannot drain a treasury or settle matches in a game it does not own.
- **Deterministic test mode.** A local devnet harness that runs the same program code against an in-process validator, with deterministic clocks, lets an agent verify its integration end-to-end before touching mainnet.

These are not exotic features — they are what any well-designed API should have. The point is that "agent-friendly" and "well-designed" mostly coincide, and we should hold ourselves to the stricter standard.

### 8.4 Identity

Players use their X1 wallet directly. There is no platform-specific account. Display names and avatars live in an off-chain profile service keyed by wallet address; games may read or ignore them.

---

## 9. Public API and Discovery

The SDK is the platform's typed surface for TypeScript callers. The **public API** is the same set of operations re-exposed for everyone else: third-party UIs, non-TS clients, indexers, partners, and agents that don't want to take a TS dependency. Without it, every third-party UI rebuilds matchmaking, indexing, replay fetching, and leaderboards from scratch — an instant moat against integration. We will not build that moat.

### 9.1 Canonical surface: tRPC

The API is defined as a **tRPC** schema. tRPC gives us:

- Fully typed client-server contracts shared between SDK and services — directly the "boring/invisible to humans and agents" property (§3) of the design principles.
- Bun, Next.js, and edge-runtime compatibility out of the box.
- Zero-ceremony schema evolution: change a procedure signature, every consumer that re-compiles gets the new shape.

The SDK imports the tRPC router type from `@x1-labs/games-api` and exposes typed methods over it. SDK consumers never see the wire format.

### 9.2 REST / OpenAPI shim

A **REST shim is generated from the tRPC schema** (via `trpc-openapi` or equivalent) and shipped alongside. Non-TS consumers — Python agents, Unity clients, partner backends, curl — call the REST endpoints. The shim is *generated*, not hand-written, so the two surfaces cannot drift. The REST spec doubles as the public API documentation.

### 9.3 Auth: wallet signatures

All authenticated calls use **wallet-signature auth** (sign-in-with-X1, à la SIWE):

1. Client requests a nonce for a given wallet address.
2. Client signs `nonce + domain + timestamp` with the wallet key.
3. Server verifies the signature and issues a short-lived session token.

No email. No password. No session backend to defend. Permissions on the session token are scoped per §8.3 (`game:create`, `match:settle:pacman`, etc.) so that compromised tokens have bounded blast radius.

### 9.4 Real-time: WebSocket subscriptions

Lobby state, live match updates, replay-storage events, and indexer-derived signals (new top scores, big-pot matches) are exposed as **WebSocket subscriptions** alongside the tRPC procedures. Subscriptions are typed identically; the SDK abstracts whether a given call is a one-shot query or a stream.

### 9.5 Discovery surface

Discovery is split across chain and indexer:

- **On-chain (Game Registry program)**: source of truth for game existence, attestor pubkey, allowed attestation models, simulator hash, dev pubkey, revenue receiver, tier, bond status. Read directly via SDK or via the API.
- **Off-chain (indexer + API)**: aggregate signals — popularity, recent winners, big pots, search, social. Cached, ranked, search-shaped. Cannot live on-chain; cannot be trusted as much as on-chain data; carries an explicit "not authoritative" flag in the API response shape so callers know what they have.

The SDK presents both as a single namespace:

```ts
const games = await platform.games.list({ tier: "LIVE", sort: "popular" });
const game  = await platform.games.get("pacman");
const live  = await platform.lobbies.subscribe({ gameId: "pacman" });
```

Whether a call hits chain or service is the SDK's problem, not the caller's.

---

## 10. Off-chain Runtime: Managed and Self-Hosted

The platform's off-chain components — matchmaking, game session hosting, canonical simulation, attestor signing, replay storage, indexing, API serving — can be operated by us (managed) or by the game developer (self-hosted). Both modes are first-class; the only difference is *who runs the binary and holds the signer key*.

### 10.1 Managed runtime (v1 default)

In managed mode, the game developer ships two things: a deterministic simulator (WASM preferred) and a frontend. The platform:

- Hosts the game server and runs the simulator.
- Holds the attestor signer key in an HSM-backed enclave; signs outcomes on the game's behalf.
- Stores replays with a published retention SLA.
- Operates the API, indexer, and WebSocket fan-out for the game.
- Charges a slightly higher rake share (§13.2) to cover hosting costs.

This is the Stripe path: a solo developer or an AI agent can ship a working wagered game in a weekend without provisioning a single server. It is the default for Phase 0/1 and the path the SDK optimizes for.

### 10.2 Self-hosted runtime (the long-term goal)

In self-hosted mode, the game developer runs their own simulator, server, attestor, and replay storage. They register their attestor pubkey in the on-chain Game Registry, and the chain accepts signed outcomes from that key. They pay no managed-hosting premium, keep more of the rake share, and have full control of their infrastructure.

The architectural constraint is that **the managed services are open-source and forkable**. Our hosted instance is the well-supported example of code anyone can run, never a private monolith. A self-hosted operator runs the same code we run, ideally with a single config change pointing at their own infra and keys.

A managed game can migrate to self-hosted without redeploying the on-chain registration — only the `attestorPubkey` and `runtime` fields change.

### 10.3 What the chain sees

The on-chain programs care about exactly one thing: the attestor pubkey on each match's outcome. Managed and self-hosted are indistinguishable to the chain. This is by design — the runtime choice is an off-chain operational concern, not a trust-model concern. The trust model is the attestation model (§6), which is orthogonal.

### 10.4 Migration path and lock-in

Because managed and self-hosted use the same programs, the same SDK, and the same API surface, there is **no lock-in cost** for a game dev who starts managed and later moves self-hosted. This is deliberate: if managed-mode adoption depended on lock-in rather than convenience, the platform would have failed the "self-hosted as the goal" principle in §3.

---

## 11. Game Developer Access: Tiers and Bonds

The platform is permissionless at the contract level but tiered at the registration level. The three tiers exist to balance open access against quality, safety, and brand exposure.

### 11.1 The three tiers

| Tier | Bond required | Stake caps | Rake share to dev | Featured placement | Who decides |
|---|---|---|---|---|---|
| **Demo** | none | low cap (configurable, default 1 XNT per match) | 0% (platform-only rake) | no | nobody — fully open |
| **Live** | **XNT bond** (configurable, default 100 XNT, slashable) | uncapped | up to 40% (§13.2) | no | bond is the gate |
| **Featured** | bond + multisig approval | uncapped | premium share | yes — homepage, tournaments | on-chain multisig committee |

### 11.2 Demo tier — fully open

Anyone — including agents acting autonomously — can register a Demo-tier game with no bond, no review, no waiting. The game runs on the managed runtime, can host real wagered matches up to the Demo stake cap, and produces real outcomes settled on-chain. The dev receives no rake share at this tier; the platform takes the full rake to offset hosting cost on untested games.

Demo tier exists so that experimentation is genuinely free. Bad games are filtered by the market (nobody plays them), not by a committee.

### 11.3 Live tier — bonded permissionless

To take uncapped stakes and earn rake share, a game must post a slashable XNT bond. The default bond is **100 XNT**, **configurable per game** by the Featured-tier multisig (a high-popularity game may carry a higher bond; a niche game may be approved at a lower one). The bond is locked in a per-game escrow PDA, visible on-chain.

The bond is slashable on confirmed abuse — manipulated attestor signatures, illegal content per the platform's content policy, sustained pay-to-win mechanics, demonstrated repeated dishonesty in match outcomes. Slashing requires a multisig (§11.5) decision and is itself recorded on-chain; the slashed bond flows to the treasury or, where applicable, to harmed players.

The bond is the platform's anti-spam and skin-in-the-game mechanism. It is not a permission gate — a builder with 100 XNT and a working game gets Live tier on registration, without review. The bond size is set to *more than the expected rake from a single scam game's full lifecycle*, so abuse is economically irrational at the margin.

### 11.4 Featured tier — explicit curation

Featured tier unlocks homepage placement, tournament eligibility, featured-in-SDK badges, and the highest dev-rake share. It is the only place we are explicitly curatorial.

Promotion to Featured requires a Live-tier bond *and* approval by the **Featured Committee** (§11.5). Demotion from Featured is possible by the same body, with no slashing — the demoted game simply returns to Live status with its bond intact.

### 11.5 The Featured Committee: on-chain multisig

The Featured Committee is implemented as an **on-chain multisig** controlling the Featured-tier admit/demote and bond-slashing instructions on the Game Registry program. Initial composition is x1-labs leadership; the long-term path is to expand the multisig to include external members (top game devs, community-elected seats) so curation is not a single-party decision.

All multisig actions are on-chain transactions, visible and auditable. There is no off-chain back-channel for tier decisions; if it didn't happen on-chain, it didn't happen.

### 11.6 Implications for SDK and API

Every game's tier and bond status is a read on the Game Registry; the SDK exposes both. Lobby UIs are expected to surface tier alongside the attestation model trust badge (§6.5) — players should see at a glance whether they are about to wager into a Demo, Live, or Featured-tier game.

---

## 12. Anti-Cheat and Fairness

Wagering moves cheating from a social problem to a financial one. Three layers:

### 12.1 Server authority for skill games

For single-player skill games (Pacman-class), the canonical simulation runs on a platform-validated game server, not the player's client. Players send inputs; the server runs the sim; the server signs the score. Cheating now requires compromising the server, not the client. This is the single biggest anti-cheat lever and it is essentially free.

### 12.2 Replay commitments

Every settled match commits a `replay_hash` on-chain. The full replay lives off-chain (game-server-side, with a redundant pin on a public store for OPTIMISTIC games). Anyone can fetch, re-run, and compare — the foundation of OPTIMISTIC.

### 12.3 Collusion-resistant matchmaking

PvP is vulnerable to collusion: two accounts owned by one party deliberately losing to launder funds or farm XP. Mitigations:

- Matchmaking randomizes opponents above a stake threshold.
- XP gains capped per opponent per period.
- Anomaly detection on win/loss patterns; suspicious accounts have payouts held pending review.

We do not claim to solve collusion. We make it expensive and uninteresting.

---

## 13. Economics

### 13.1 Rake

Platform revenue is a percentage of each settled pot, configurable per game within a platform-set range (e.g. 1%–8%). Rake is taken at settlement, atomically with payout. No subscriptions, no listing fees, no inflation.

### 13.2 Revenue split

For third-party games, rake is split between platform and game developer. A reasonable default is 60/40 (dev/platform). A successful game on X1 Games is a real business for its developer — closer to a Stripe-on-Steam economic relationship than a loss leader.

### 13.3 Treasury and prize pools

The platform's share of rake flows to a treasury account. The treasury funds: house-funded prize pools (§7.8), seasonal tournaments, infrastructure, and developer grants. All treasury flows are on-chain and auditable.

### 13.4 Base fees and platform staking

X1 charges a dynamic EIP-1559-style base fee that adjusts with network load, with a portion burned. Match operations and house funding pay this fee like any other transaction. Two consequences:

- **Fee is a real operating cost in busy slots.** Per-match operations are small, but at scale (thousands of matches per slot) the aggregate base fee is non-trivial. The treasury budgets for it as an opex line rather than passing per-transaction surcharges to players.
- **Staking reduces base fees.** X1 discounts base fees proportionally to staked XNT and lock duration. The treasury staking a portion of its reserves is a straightforward cost optimization: it lowers ongoing settlement spend and is reversible. We stake because it is cheaper, not for governance influence.

We will not design custom fee economics on top of base fees. The platform earns rake on settled value; it does not surcharge transactions.

---

## 14. Roadmap

**Phase 0 — Primitives (now)**
- Match program, TRUSTED model only.
- Game Registry program (§4) with Demo-tier registration.
- SDK alpha (`@x1-labs/games-sdk`): create / join / settle / claim, with dry-run and idempotency.
- Managed runtime alpha: simulator hosting, attestor signing, replay storage for first-party games.
- tRPC API alpha for lobbies and registry reads (§9).
- First-party game: port the Pacman PoC as the reference integration.

**Phase 1 — Trust diversity and tier rollout**
- COSIGNED and OPTIMISTIC attestation models.
- Replay storage and challenge UX.
- Live tier with bond (§11.3) — third-party games can earn rake.
- REST/OpenAPI shim generated from tRPC (§9.2).
- WebSocket subscriptions for lobby state (§9.4).
- Second first-party game (head-to-head, to exercise COSIGNED).
- MCP server for agent builders.

**Phase 2 — Developer platform**
- Public dev portal, agent-friendly onboarding.
- Featured tier (§11.4) and on-chain multisig committee (§11.5).
- 3–5 third-party games onboarded with grants.
- XP ledger generally available.
- Achievement NFTs (§7.5) issued once we know which milestones players care about.
- Self-hosted runtime path documented and reference-deployed by an external builder (§10.2).

**Phase 3 — Scale and trust**
- ZK attestation for high-stakes matches.
- Tournament primitives (brackets, leaderboards-as-matches).
- Cross-game identity / reputation.
- Off-chain services open-sourced under a permissive license; first independent self-hosted deployments in production.

A platform token does **not** appear on this roadmap by design. Adding one will be a separate document and a separate debate.

---

## 15. Open Questions

1. **X1 platform-level VRF as game randomness oracle.** X1's leader selection already produces verifiable, manipulation-resistant randomness on-chain via VRFs. Many game classes (card shuffles, loot drops, opponent assignment, tournament seedings) need exactly this. Exposing the chain's VRF — directly or via a thin wrapper program — could remove every game's need to integrate its own VRF or commit-reveal. Worth a spike before Phase 1: is the slot-level randomness available to programs at acceptable cost, and can we expose it cleanly through the SDK?

2. **Treasury staking strategy.** §13.4 argues the treasury should stake XNT to lower its own base-fee bill. Open: target fraction of treasury staked, lock duration, and reserve calibration so that prize-pool funding obligations remain liquid through worst-case drawdowns. Needs a model before mainnet.

3. **Lobby ordering and MEV exposure.** X1's native MEV capture (no private builder market) removes the worst class of MEV games, but on-chain ordering still exists. Match creation, seat-claiming, and tournament progression could in principle be reordered by validators in ways that favor specific outcomes. We need to identify the concrete attack — most likely racing to claim a favorable seat — and decide whether commit-reveal join transactions are necessary, or whether the threat is small enough to ignore in v1.

4. **Custodial onramp.** Players holding XNT in their own wallet is the right end state. The right *starting* state may involve a custodial wallet or a session-key flow for new users. How far do we lean on that without becoming a custodian?

5. **Regulatory posture.** Wagered play is regulated differently across jurisdictions. The platform should be permissionless at the program level and compliant at the front-end level; the line between those needs legal review before mainnet.

6. **Single-player house exposure.** Funding house prizes from rake creates a feedback loop. If the house loses faster than rake comes in, prize pools shrink. We need a steady-state model under different player skill distributions, and a circuit-breaker for prize-pool drawdowns.

7. **Replay storage incentives.** OPTIMISTIC depends on replays being available to challengers. Who pays for storage, and what is the SLA? Candidates: game dev (cheap, aligned), platform (cleaner but cost grows), public store with bond-backed pinning.

8. **Bond sizing under real XNT price discovery.** The default 100 XNT Live-tier bond (§11.3) is a placeholder. The principle is "more than the rake from a scam game's full lifecycle"; the number depends on XNT's market price and on observed scam-game economics, neither of which we know yet. Set as a configurable parameter, revisit empirically.

9. **Featured Committee composition.** §11.5 commits to an on-chain multisig but defers membership. Initial composition (x1-labs leadership only) is fine for Phase 0/1 but is a credibility liability beyond that. Open: timing and selection method for adding external members (top game devs, community-elected seats, advisory council); also, signing threshold and key rotation policy.

10. **Managed runtime SLA.** §10.1 promises managed simulator hosting and replay storage but does not commit to uptime, retention period, or migration assistance. Need to publish an explicit SLA before any third-party game commits to managed. Particularly load-bearing for replay retention: if managed-instance loss of replays prevents a challenge in an OPTIMISTIC dispute, who bears the loss?

11. **Self-hosted onboarding spec.** §10.2 commits to first-class self-hosted support but does not specify the operator contract: which services must a self-host operator run, what configuration surface is exposed, what monitoring is expected, and what version compatibility guarantees we offer. Belongs in a separate operator's-handbook document, gated before Phase 2.

12. **Agent abuse, residual.** The Demo-tier + Live-tier-bond design (§11) handles the bulk of the agent-abuse risk from the v0.3 open question. Residual risk: agents registering thousands of Demo-tier games to spam search and discovery surfaces. May warrant per-wallet registration rate-limiting or a small XNT registration fee (not a bond) on Demo tier — pending empirical observation.

*(Resolved in v0.3: X1-specific affordances. The X1 whitepaper confirms SVM compatibility, monolithic L1 design with no L2 dependency, 16–32-thread execution (4–8× Solana), EIP-1559-style dynamic fees with burn, VRF + ACP leader selection, native MEV capture, and staking-discounted base fees. These are folded into §1, §4, §6.3, and §13.4. Two new design questions follow above (#1, #2); a third (#3) was surfaced by the native MEV property.)*

*(Resolved in v0.5: managed-vs-self-hosted runtime, developer access model, public API design. Managed-first with self-hosted as the long-term goal is now §10; tiered permissionless access with bonds and a Featured-tier on-chain multisig is now §11; the tRPC + REST + WebSocket public API is now §9. Open questions related to these decisions — e.g., bond sizing under real XNT price discovery, Featured-tier multisig membership, managed-runtime SLA — surface in subsequent drafts.)*

---

## 16. Summary

X1 Games is, in one sentence: **a Match program, a few ways to attest its outcome, an SDK and a public API that get out of the way, and a managed runtime that lets a solo builder ship a wagered game in a weekend.** Everything else — token model, tier system, attestation menu — is a consequence. Get those four right and games will follow; get them wrong and no amount of tokenomics will fix it.

Games come from builders — human or agent. Builders come from good primitives and don't-think-about-it infrastructure. Players come from good games. We start at the bottom.

---

*This is a working draft. Sections will move, claims will tighten, and the open questions in §15 will be resolved or escalated in subsequent revisions.*
