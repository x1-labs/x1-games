# X1 Games Platform Backlog

This backlog tracks the off-chain platform work needed to move from the current
v0 SDK/demo surface to a production platform for wagered games.

Current v0 state:

- The SDK exposes `stub`, `x1-localnet`, `x1-testnet`, and `x1-mainnet`
  backends.
- Match lifecycle, settlement posting, XP, game registry, and match reads are
  wired through the SDK and Anchor programs.
- `stub` is an in-memory testing backend with real ed25519 outcome signatures.
- Replay storage is process-local and in-memory.
- `subscribeMatchStart` is implemented by the stub only; chain backends need an
  off-chain delivery service.
- `MatchView.settlementDeadline` is exposed by the SDK as of `0.1.3`.

## P0 - Production Required

### Public API and SDK backend service

Owner: platform.

Build the hosted API surface that games call in production instead of relying
on in-process helpers.

Scope:

- Stable HTTPS API for game registration, match lookup, replay upload/download,
  outcome submission, XP reads/writes, and developer metadata.
- Versioned API contract aligned with `INTEGRATION.md`.
- Idempotency keys for mutating calls.
- API keys or wallet-scoped auth for server-to-platform calls.
- Per-game rate limits and abuse controls.
- Clear error taxonomy that maps to SDK errors.

Acceptance criteria:

- A game server can run without importing any process-local platform state.
- SDK chain backends can call the hosted API where off-chain state is required.
- All mutating endpoints are idempotent under retry.

### Match coordinator and lifecycle service

Owner: platform.

Coordinate wagered match creation from funded chain state to game-server start.

Scope:

- Watch funded matches and emit `MatchStart`.
- Track seats, join state, funding deadlines, settlement deadlines, and match
  readiness.
- Recover from process restarts without losing in-flight matches.
- Support solo-vs-house, PvP, and future multi-seat games.
- Provide join URLs and player payloads to the game.

Acceptance criteria:

- `subscribeMatchStart` works against localnet/testnet/mainnet through the SDK.
- Coordinator restart does not drop ready or live matches.
- Duplicate events are tolerated by game servers using idempotency keys.

### Durable replay storage

Owner: platform owns storage; games own replay generation.

Games must produce deterministic replay documents. The platform must store,
serve, and validate them.

Scope:

- Replace process-local `getDefaultReplayStore()` use with durable storage.
- Content-addressed storage keyed by canonical replay hash.
- Per-match single-writer semantics.
- Size limits, content-type validation, malware scanning if public downloads are
  supported, and retention policy.
- Signed upload URLs or authenticated direct upload.
- Public or permissioned replay retrieval for disputes and audits.

Acceptance criteria:

- A replay uploaded before a process restart is still retrievable afterward.
- Uploading different replay bodies for the same match fails with conflict.
- Posted `OutcomeBody.replayHash` can be resolved to the stored replay.

### Managed attestor service

Owner: platform.

Provide secure outcome signing for `MANAGED` games.

Scope:

- Key generation, custody, rotation, and per-game attestor mapping.
- HSM/KMS backed signing path, or equivalent operational controls.
- Policy checks before signing outcomes.
- Audit log for every signed envelope.
- Emergency key disablement and recovery.

Acceptance criteria:

- A managed game never handles the attestor private key.
- Signed envelopes verify against the registered attestor key.
- Signing can be disabled per game without redeploying the game.

### Settlement and finalization workers

Owner: platform.

Reliably push outcomes and finalization transactions to chain.

Scope:

- Queue outcome posts and finalization attempts.
- Retry transient RPC failures, blockhash expiry, and rate limits.
- Handle settlement deadline expiry and force-loss/fallback paths.
- Surface transaction status to API and dashboard.
- Support TRUSTED, COSIGNED, and OPTIMISTIC happy paths.

Acceptance criteria:

- A valid signed outcome eventually reaches chain unless the chain rejects it.
- Expired matches are finalized according to protocol rules.
- Operators can inspect stuck settlement jobs.

### Chain indexer and read model

Owner: platform.

Maintain queryable off-chain views of chain state.

Scope:

- Index game registry, match accounts, XP accounts, settlement events, and
  treasury movement.
- Provide low-latency match/player/game reads for SDK and dashboards.
- Reconcile chain state after indexer restarts or RPC gaps.
- Track transaction signatures and slot/finality status.

Acceptance criteria:

- API reads do not require every caller to scan chain state directly.
- Indexer can rebuild from chain and converge on the same state.
- Read model exposes enough state for game reconnect and operator debugging.

### Auth, permissions, and developer accounts

Owner: platform.

Define who can create games, mutate game metadata, sign outcomes, and inspect
private data.

Scope:

- Developer account model tied to wallet identity.
- Game ownership and team membership.
- API token creation, rotation, and revocation.
- Scoped permissions for game server calls versus dashboard calls.
- Audit trails for sensitive operations.

Acceptance criteria:

- A compromised game-server token can be revoked without affecting the owner
  wallet.
- Cross-game data access is denied by default.
- Sensitive actions are attributable to a developer, token, or service.

## P1 - Production Quality

### Webhook and event delivery

Owner: platform.

Deliver match and settlement events to game servers and developer systems.

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

### Reconnect and parked-room persistence

Owner: shared. Platform supplies durable match/read/event state; each game
persists game-specific room/session state.

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
- `X1_RECONNECT_GRACE_MS`-style grace windows are explicit game config.
- The platform can tell whether a match is still live, expired, or settled.

### Treasury and prize funding controls

Owner: platform.

Manage house funds, rake, payout limits, and operational risk.

Scope:

- Treasury account configuration per game/tier.
- House-prize budgets and caps.
- Rake reporting.
- Balance monitoring and low-balance alerts.
- Withdrawal and treasury admin flows.

Acceptance criteria:

- A game cannot create matches beyond configured house risk limits.
- Operators can reconcile deposits, payouts, and rake.
- Treasury changes are permissioned and audited.

### Developer dashboard and admin console

Owner: platform.

Make platform state inspectable and operable.

Scope:

- Game registration and metadata management.
- Match search and detail views.
- Replay lookup and download links.
- Settlement job status.
- Webhook delivery logs.
- API key management.
- Basic incident controls such as pause game, disable signing, and retry job.

Acceptance criteria:

- Developers can debug an integration without direct database or chain access.
- Operators can pause risky games and inspect stuck matches.

### Observability and operations

Owner: platform.

Provide production telemetry for all platform services.

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

### Dispute and verification service

Owner: platform.

Support OPTIMISTIC disputes and future verification models.

Scope:

- Replay retrieval and deterministic simulation hooks.
- Challenge submission and evidence tracking.
- Dispute worker that validates replays against game-specific simulators.
- Result publication and settlement integration.
- Framework for later ZK or external verifier integration.

Acceptance criteria:

- OPTIMISTIC games can publish replays and accept challenges.
- A disputed match has a clear lifecycle and operator-visible evidence.

## P2 - Scale and Ecosystem

### SDK and protocol hardening

Owner: platform SDK.

Scope:

- Lock `OutcomeBody` Borsh layout before v1.
- Keep generated IDL bindings in sync with deployed programs.
- Add compatibility tests for browser bundles, Node, Bun, and major wallet
  adapters.
- Define SDK behavior for API outages, retry policy, and idempotency.
- Publish migration guides for protocol version changes.

Acceptance criteria:

- A game can upgrade SDK minor versions with documented behavior changes.
- Packaging works from npm without workspace-only assumptions.

### Local development stack

Owner: platform developer experience.

Scope:

- One-command local stack for chain, API, workers, replay storage, and sample
  games.
- Seed data and fixture matches.
- Local webhook receiver tooling.
- Deterministic smoke tests across SDK, services, and chain.

Acceptance criteria:

- A new game developer can run a wagered match locally without manual service
  setup.
- CI and local smoke tests exercise the same core path.

### Compliance and policy controls

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

### Multi-region and scaling

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

## Release Notes To Track

- SDK `0.1.3` exposes `MatchView.settlementDeadline` so game bindings no longer
  need an in-memory deadline map for matches created through the SDK.
- Durable reconnect across game-server restarts remains backlog work. The
  platform should expose durable match state and delivery cursors; each game
  still needs to persist game-specific room/session state.
- Replay storage is a platform feature. Games generate canonical replay bodies;
  the platform stores and serves them.
