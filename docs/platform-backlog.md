# X1 Games Platform Backlog

This backlog tracks the work needed to move from the current v0 SDK/demo
surface to a production platform for wagered games.

The design goal is to keep authority decentralized where practical:

- Put escrow, ownership, deadlines, settlement rules, and verification
  commitments on-chain.
- Let game developers self-host whenever the service only exists to operate
  their own game.
- Make X1-hosted services default conveniences, not irreplaceable sources of
  truth, except where the product explicitly offers managed custody or curation.

## Current v0 State

- The SDK exposes `stub`, `x1-localnet`, `x1-testnet`, and `x1-mainnet`
  backends.
- Match lifecycle, settlement posting, XP, game registry, and match reads are
  wired through the SDK and Anchor programs.
- `stub` is an in-memory testing backend with real ed25519 outcome signatures.
- Replay storage is process-local and in-memory.
- `subscribeMatchStart` is implemented by the stub only; chain backends need an
  event delivery path.
- `MatchView.settlementDeadline` is exposed by the SDK as of `0.1.3`.

## Service Decentralization Split

| Service | Can Be On-Chain? | Can Game Dev Own? | Must Be Centralized? |
| --- | --- | --- | --- |
| Public API / SDK backend | Partly. Chain owns canonical state; API wraps reads and off-chain conveniences. | Partly. Dev can call chain and host replay/webhook pieces. | No. X1 API should be replaceable where possible. |
| Match coordinator | Mostly authority on-chain. Off-chain only observes and submits transactions. | Yes, for a game's own rooms and watcher. | No. Keepers/watchers can be permissionless. |
| Managed attestor / signer | Registry and signature verification on-chain; private key cannot be on-chain. | Yes, via `SELF_HOSTED` attestor. | Only for `MANAGED` runtime. |
| Replay storage | Store hash and maybe URI on-chain; not blobs. | Yes. Game or third party can host canonical blobs. | No. Platform storage is a default service. |
| Webhook / event delivery | Source events from chain/accounts. | Yes. Dev can watch chain/indexer directly. | No. Webhooks are convenience delivery. |
| Indexing / read model | Canonical state on-chain. | Yes. Anyone can run an indexer if schemas/IDLs are public. | No. Hosted indexer is convenience and UX. |
| Auth / permissions | Game ownership, admins, attestors, treasury authority can be on-chain. | Partly. Dev owns game/team keys. | No, except dashboard/API-key sessions. |
| Treasury / house funding | Escrow, rake destinations, caps, and payout rules can be on-chain. | Yes. Game, DAO, or platform can fund. | No, but each treasury has an operator. |
| Finalizer / settlement worker | Rules should be on-chain. | Yes. Anyone should be able to submit valid finalization transactions. | No. Platform worker is default keeper. |
| Dispute / verification | Challenge windows and challenge results on-chain; simulation usually off-chain. | Partly. Dev supplies verifier/simulator. | Depends on verifier model. Aim for reproducible, public verifiers. |
| Developer/admin service | Critical game config can be on-chain; UX and moderation off-chain. | Dev owns game config. | Curation/moderation is centralized unless governed. |

## Decentralized Core

These are the pieces that should be canonical on-chain or enforced by programs.
They are the foundation for decentralization and should be prioritized before
expanding hosted convenience services.

### Game Registry

Owner: chain programs and platform SDK.

Scope:

- Register game id, owner/admin authorities, runtime mode, attestor/verifier
  pubkeys, treasury/rake destinations, simulator hash, metadata URI, and allowed
  attestation models.
- Support game config updates through on-chain authority checks.
- Preserve enough history or versioning to audit which config governed a match.
- Keep SDK registration and reads aligned with the deployed IDL.

Acceptance criteria:

- A game developer can register and update critical game config without relying
  on a centralized database.
- Match creation references on-chain game config, not an API-only record.
- SDK reads expose the same canonical config seen by programs.

### Match Escrow and Lifecycle

Owner: chain programs.

Scope:

- Create matches, join seats, hold escrow, enforce funding deadlines, track
  settlement deadlines, and store terminal state.
- Encode solo-vs-house and PvP rules in program state.
- Enforce payout, rake, and timeout/fallback rules.
- Emit enough account/log state for indexers and game watchers.

Acceptance criteria:

- Money movement and terminal match state do not depend on an X1 server being
  online.
- A valid third-party watcher can reconstruct match state from chain.
- Finalization and timeout behavior is deterministic from on-chain state.

### Attestor and Verifier Registry

Owner: chain programs and SDK.

Scope:

- Record accepted attestor pubkeys for managed and self-hosted games.
- Record verifier identity or simulator commitment for optimistic games.
- Verify outcome envelope signatures against the registered attestor.
- Support key rotation with clear activation semantics.

Acceptance criteria:

- A self-hosted game can sign outcomes without giving X1 the private key.
- A managed game can prove which platform attestor signed an envelope.
- Old and new keys have auditable validity windows.

### Replay Commitments

Owner: chain programs and protocol package.

Scope:

- Store or verify the canonical replay hash committed in `OutcomeBody`.
- Optionally store a content URI or storage provider hint.
- Keep canonical JSON and replay hashing stable for v0 or versioned when it
  changes.

Acceptance criteria:

- Settlement commits to replay content by hash.
- Replay blob location can change without changing the committed hash.
- Dispute/verifier services can fetch a replay and prove it matches the
  on-chain commitment.

### Permissionless Finalization

Owner: chain programs.

Scope:

- Allow any actor to finalize a match when protocol conditions are met.
- Prevent invalid finalization through program checks instead of worker
  permissions.
- Make timeout/force-loss and optimistic challenge-window behavior explicit.

Acceptance criteria:

- A stuck match can be unstuck by any keeper submitting a valid transaction.
- Platform finalizer downtime cannot permanently block settlement.
- Repeated finalization attempts are safe and deterministic.

## Game-Developer-Owned Surface

These pieces should be possible for a game developer to operate independently,
even if X1 provides hosted defaults.

### Game Runtime and Room State

Owner: game developer.

Scope:

- Run the simulator, render/game server, room lifecycle, and player reconnect.
- Persist game-specific room/session state needed to resume after restart.
- Consume `MatchStart` from chain/indexer/webhook and start a room exactly once.
- Configure reconnect grace windows per game mode.

Acceptance criteria:

- A game server restart does not lose live wagered room state.
- `X1_RECONNECT_GRACE_MS`-style grace windows are explicit game config.
- The game can recover from duplicate or delayed `MatchStart` delivery.

### Self-Hosted Attestation

Owner: game developer.

Scope:

- Hold a game-owned attestor key for `SELF_HOSTED` runtime.
- Sign canonical outcome envelopes after local policy checks.
- Rotate keys by updating on-chain game registry config.
- Keep signing idempotent by match and outcome.

Acceptance criteria:

- The platform can verify the game-signed outcome without holding the private
  key.
- A game can opt out of managed signing.
- Compromised attestor keys can be rotated.

### Replay Generation and Optional Storage

Owner: game developer for replay generation; storage can be game, platform, or
third party.

Scope:

- Emit deterministic replay documents from match input logs and final state.
- Upload canonical replay blobs to platform storage, game storage, or
  content-addressed storage.
- Preserve replay data long enough for disputes and audits.

Acceptance criteria:

- The game can reproduce the committed replay hash locally.
- X1-hosted storage is not the only possible replay source.
- Replay format is versioned and validated by protocol schemas.

### Direct Chain / Indexer Integration

Owner: game developer, optionally assisted by SDK.

Scope:

- Allow advanced games to watch chain state or run their own indexer.
- Keep public IDLs and event/account schemas documented.
- Let games bypass X1 webhooks when they need lower trust or custom infra.

Acceptance criteria:

- A game can receive match starts without relying on X1 webhook delivery.
- Hosted API and self-hosted indexer produce equivalent canonical reads.

## X1-Hosted Platform Services

These services are still important. The backlog below prioritizes them as
default infrastructure and developer experience, while keeping the trust
boundary clear.

## P0 - Minimum Production Platform

### Public API and SDK Backend

Decentralization stance: hosted convenience. Chain and replay commitments remain
the source of truth.

Scope:

- Stable HTTPS API for game registration reads, match lookup, lobby views,
  replay upload/download, outcome submission, XP reads/writes, and developer
  metadata.
- Versioned API contract aligned with `INTEGRATION.md`.
- Idempotency keys for mutating calls.
- Wallet-scoped auth and API keys for game servers.
- Per-game rate limits and anti-abuse controls.
- Clear error taxonomy that maps to SDK errors.

Acceptance criteria:

- A game server can run without importing process-local platform state.
- SDK chain backends use the hosted API only where off-chain state or
  convenience delivery is required.
- All mutating endpoints are idempotent under retry.

### Match Coordinator and Event Source

Decentralization stance: default watcher/keeper. Authority stays in the match
program.

Scope:

- Watch funded matches and emit `MatchStart`.
- Track seats, join state, funding deadlines, settlement deadlines, and match
  readiness from chain state.
- Recover from process restarts without losing in-flight matches.
- Support solo-vs-house, PvP, and future multi-seat games.
- Submit timeout/finalization transactions when needed.

Acceptance criteria:

- `subscribeMatchStart` works against localnet/testnet/mainnet through the SDK.
- Coordinator restart does not drop ready or live matches.
- Duplicate events are tolerated by game servers using idempotency keys.
- A third-party watcher could produce equivalent `MatchStart` events.

### Durable Replay Storage

Decentralization stance: hosted default, not exclusive.

Scope:

- Replace process-local `getDefaultReplayStore()` use with durable storage.
- Store canonical replay blobs content-addressed by hash.
- Enforce per-match single-writer semantics.
- Provide signed upload/download URLs.
- Define retention policy and audit access.
- Support alternate storage providers by preserving hash-first semantics.

Acceptance criteria:

- A replay uploaded before a process restart is still retrievable afterward.
- Uploading different replay bodies for the same match fails with conflict.
- Posted `OutcomeBody.replayHash` can be resolved to the stored replay.

### Managed Attestor Service

Decentralization stance: explicitly centralized product feature. Optional for
games that do not want to self-host signing.

Scope:

- Key generation, custody, rotation, and per-game attestor mapping.
- HSM/KMS backed signing path, or equivalent operational controls.
- Policy checks before signing outcomes.
- Audit log for every signed envelope.
- Emergency key disablement and recovery.
- Idempotent sign-and-post by match and outcome.

Acceptance criteria:

- A managed game never handles the attestor private key.
- Signed envelopes verify against the registered attestor key.
- Signing can be disabled per game without redeploying the game.
- `SELF_HOSTED` remains a first-class alternative.

### Chain Indexer and Read Model

Decentralization stance: hosted replica of chain truth. Must be rebuildable by
third parties.

Scope:

- Index game registry, match accounts, XP accounts, settlement events, and
  treasury movement.
- Provide low-latency match/player/game reads for SDK and dashboards.
- Reconcile chain state after indexer restarts or RPC gaps.
- Track transaction signatures and slot/finality status.
- Publish enough schema/IDL context for external indexers.

Acceptance criteria:

- API reads do not require every caller to scan chain state directly.
- Indexer can rebuild from chain and converge on the same state.
- Read model exposes enough state for game reconnect and operator debugging.

### Finalizer and Settlement Worker

Decentralization stance: default keeper. Program rules should allow
permissionless equivalents.

Scope:

- Queue outcome posts and finalization attempts.
- Retry transient RPC failures, blockhash expiry, and rate limits.
- Handle settlement deadline expiry and force-loss/fallback paths.
- Finalize optimistic matches after challenge windows.
- Credit XP where appropriate.
- Surface transaction status to API and dashboard.

Acceptance criteria:

- A valid signed outcome eventually reaches chain unless the chain rejects it.
- Expired matches are finalized according to protocol rules.
- Operators can inspect stuck settlement jobs.
- Any valid keeper can perform equivalent finalization where protocol allows.

### Auth, Permissions, and Developer Accounts

Decentralization stance: split. On-chain for game authority; off-chain for API
sessions, tokens, and dashboard permissions.

Scope:

- Developer account model tied to wallet identity.
- Game ownership and admin checks based on on-chain registry authorities.
- API token creation, rotation, and revocation.
- Scoped permissions such as `game:create`, `match:settle:{gameId}`, and
  replay read/write scopes.
- Audit trails for sensitive operations.

Acceptance criteria:

- A compromised game-server token can be revoked without affecting the owner
  wallet.
- Cross-game data access is denied by default.
- Sensitive actions are attributable to a developer, token, wallet, or service.
- Critical ownership checks resolve to on-chain authority.

### Treasury and House-Prize Funding

Decentralization stance: program-enforced custody and limits; operator can be
platform, game, DAO, or other treasury authority.

Scope:

- Treasury account configuration per game/tier.
- House-prize budgets and hard caps where feasible.
- Rake destination and reporting.
- Balance monitoring and low-balance alerts.
- Withdrawal and treasury admin flows.
- Risk limits for platform-funded solo-vs-house matches.

Acceptance criteria:

- A game cannot create matches beyond configured house risk limits.
- Operators can reconcile deposits, payouts, and rake.
- Treasury changes are permissioned and audited.
- Platform treasury is not the only possible funding source.

## P1 - Production Quality

### Webhook and Event Delivery

Decentralization stance: convenience delivery over canonical chain/indexer
events.

Scope:

- Webhook subscriptions per game.
- Retries with exponential backoff and dead-letter handling.
- Signed webhook payloads.
- Event replay from a cursor.
- Developer dashboard for recent delivery attempts.

Acceptance criteria:

- A game server can recover missed events after downtime.
- Webhook receivers can verify payload authenticity.
- Failed deliveries are visible and replayable.
- A game can choose direct indexer/chain consumption instead.

### Reconnect and Parked-Room Persistence Guidance

Decentralization stance: shared responsibility. Platform supplies durable match
and event state; games persist game-specific room state.

Paxman feedback: parked rooms currently live in memory. A server restart loses
them, so a player cannot resume and the grace-timeout safety net may settle a
loss without play.

Scope:

- Document the split between platform match state and game room state.
- Add SDK/service examples for restart-safe reconnect flows.
- Provide platform APIs to fetch live match metadata, deadlines, players, and
  latest delivery cursor.
- Let games configure reconnect grace windows per mode.
- Consider a shared room-state helper for sample games, backed by SQLite.

Acceptance criteria:

- A sample game can restart and restore a live wagered room from durable state.
- Grace windows are explicit game config.
- The platform can tell whether a match is live, expired, or settled.

### Developer Dashboard and Admin Console

Decentralization stance: off-chain UX over on-chain and hosted service state.
Curation/moderation is centralized unless later governed.

Scope:

- Game registration and metadata management.
- Match search and detail views.
- Replay lookup and download links.
- Settlement job status.
- Webhook delivery logs.
- API key management.
- Incident controls such as pause game, disable managed signing, and retry job.
- Curation controls such as featured status and moderation flags.

Acceptance criteria:

- Developers can debug an integration without direct database or chain access.
- Operators can pause risky hosted services and inspect stuck matches.
- Dashboard actions that affect canonical game config submit on-chain updates.

### Observability and Operations

Decentralization stance: platform operational requirement for hosted services.

Scope:

- Structured logs with match/game/player correlation IDs.
- Metrics for match lifecycle, signing, replay upload, settlement latency,
  webhook delivery, RPC errors, and queue depth.
- Distributed tracing across API, workers, and RPC calls.
- Alerts for stuck settlement, replay upload failure, signer errors, and chain
  indexing lag.
- Runbooks for common incidents.

Acceptance criteria:

- A failed match can be traced from API request to chain transaction.
- Operators receive actionable alerts before deadlines are missed.
- Public status or incident artifacts distinguish chain issues from hosted
  service issues.

### Dispute and Verification Service

Decentralization stance: challenge lifecycle on-chain; verification should be
public and reproducible, with hosted workers as default executors.

Scope:

- Replay retrieval and deterministic simulation hooks.
- Challenge submission and evidence tracking.
- Dispute worker that validates replays against game-specific simulators.
- Result publication and settlement integration.
- Framework for later ZK, TEE, or external verifier integration.

Acceptance criteria:

- OPTIMISTIC games can publish replays and accept challenges.
- A disputed match has a clear lifecycle and operator-visible evidence.
- Verifier code and replay format are public enough for independent challenge
  execution.

## P2 - Scale and Ecosystem

### SDK and Protocol Hardening

Owner: platform SDK.

Scope:

- Lock `OutcomeBody` Borsh layout before v1.
- Keep generated IDL bindings in sync with deployed programs.
- Add compatibility tests for browser bundles, Node, Bun, and major wallet
  adapters.
- Define SDK behavior for API outages, retry policy, and idempotency.
- Publish migration guides for protocol version changes.
- Document direct-chain, hosted-API, and self-hosted modes clearly.

Acceptance criteria:

- A game can upgrade SDK minor versions with documented behavior changes.
- Packaging works from npm without workspace-only assumptions.
- Developers can tell when they are relying on centralized hosted services.

### Local Development Stack

Owner: platform developer experience.

Scope:

- One-command local stack for chain, API, workers, replay storage, and sample
  games.
- Seed data and fixture matches.
- Local webhook receiver tooling.
- Deterministic smoke tests across SDK, services, and chain.
- Self-hosted watcher/indexer examples.

Acceptance criteria:

- A new game developer can run a wagered match locally without manual service
  setup.
- CI and local smoke tests exercise the same core path.
- Developers can test both hosted-style and self-hosted flows.

### Compliance and Policy Controls

Owner: platform and legal/compliance.

Scope:

- Jurisdiction and eligibility gates.
- Game tier policy and review workflow.
- Responsible play limits where required.
- Retention and privacy policy for player, replay, and transaction data.
- Sanctions and abuse screening if required by launch markets.

Acceptance criteria:

- Production launch markets have explicit policy controls.
- Data retention and access are documented and enforceable.
- Centralized policy controls are clearly separated from decentralized
  settlement rules.

### Multi-Region and Scaling

Owner: platform infrastructure.

Scope:

- Region strategy for API, webhooks, replay storage, and indexers.
- Queue partitioning by game or match.
- RPC provider failover.
- Backpressure controls during traffic spikes.
- Load testing with realistic match and settlement volume.

Acceptance criteria:

- A single service restart or regional issue does not lose match state.
- The platform can degrade gracefully under RPC or webhook pressure.
- Hosted service degradation does not corrupt canonical chain state.

## Release Notes To Track

- SDK `0.1.3` exposes `MatchView.settlementDeadline` so game bindings no longer
  need an in-memory deadline map for matches created through the SDK.
- Durable reconnect across game-server restarts remains backlog work. The
  platform should expose durable match state and delivery cursors; each game
  still needs to persist game-specific room/session state.
- Replay storage is a platform feature when X1 hosts it, but not a platform
  monopoly. Games generate canonical replay bodies, and any storage provider can
  serve blobs that match the committed replay hash.
