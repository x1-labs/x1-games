use anchor_lang::prelude::*;
use anchor_lang::system_program;
use game_registry::Game;

declare_id!("kPnK69DwUAmEobyLiWNNmra6STdJLFszJxc314XkEKb");

pub const MAX_SEATS: u8 = 16;
pub const MAX_RAKE_BPS: u16 = 1_000;

#[program]
pub mod match_program {
    use super::*;

    pub fn create_match(ctx: Context<CreateMatch>, args: CreateMatchArgs) -> Result<()> {
        require!(args.seats > 0, MatchError::InvalidSeats);
        require!(args.seats <= MAX_SEATS, MatchError::TooManySeats);
        require!(args.rake_bps <= MAX_RAKE_BPS, MatchError::RakeTooHigh);
        require!(
            args.funding_deadline < args.settlement_deadline,
            MatchError::DeadlinesOutOfOrder,
        );

        let game = &ctx.accounts.game;
        require!(
            args.seats >= game.seats_min && args.seats <= game.seats_max,
            MatchError::SeatsOutOfGameRange,
        );
        require!(
            args.attestor == game.attestor_pubkey,
            MatchError::AttestorMismatch,
        );
        // TRUSTED and COSIGNED are atomic settle+pay — no dispute window.
        // OPTIMISTIC requires a non-zero window. ZK is deferred.
        match args.model {
            AttestationModel::Trusted | AttestationModel::Cosigned => {
                require!(args.challenge_window_secs == 0, MatchError::WindowNotAllowed);
            }
            AttestationModel::Optimistic => {
                require!(args.challenge_window_secs > 0, MatchError::WindowRequired);
            }
            AttestationModel::Zk => {
                // ZK path not enabled in v0.
                return err!(MatchError::UnsupportedModel);
            }
        }

        let m = &mut ctx.accounts.match_account;
        m.game_id = game.key();
        m.nonce = args.nonce;
        m.seats = args.seats;
        m.stake_per_seat = args.stake_per_seat;
        m.rake_bps = args.rake_bps;
        m.funding_deadline = args.funding_deadline;
        m.settlement_deadline = args.settlement_deadline;
        m.model = args.model;
        m.state = MatchState::Created;
        m.creator = ctx.accounts.creator.key();
        m.attestor = args.attestor;
        m.treasury = args.treasury;
        m.players = Vec::new();
        m.challenge_window_secs = args.challenge_window_secs;
        m.settled_at = 0;
        m.bump = ctx.bumps.match_account;
        m.vault_bump = ctx.bumps.vault;

        let v = &mut ctx.accounts.vault;
        v.match_account = ctx.accounts.match_account.key();
        v.bump = ctx.bumps.vault;

        Ok(())
    }

    pub fn join_match(ctx: Context<JoinMatch>) -> Result<()> {
        let m = &mut ctx.accounts.match_account;

        require!(
            matches!(m.state, MatchState::Created | MatchState::Funded),
            MatchError::NotJoinable,
        );
        require!(
            (m.players.len() as u8) < m.seats,
            MatchError::MatchFull,
        );

        let player_key = ctx.accounts.player.key();
        require!(
            !m.players.iter().any(|p| *p == player_key),
            MatchError::AlreadyJoined,
        );

        // Transfer stake from player to vault PDA via system_program.
        let stake = m.stake_per_seat;
        let cpi_ctx = CpiContext::new(
            ctx.accounts.system_program.key(),
            system_program::Transfer {
                from: ctx.accounts.player.to_account_info(),
                to: ctx.accounts.vault.to_account_info(),
            },
        );
        system_program::transfer(cpi_ctx, stake)?;

        m.players.push(player_key);

        // State machine: Created → Funded (first join) → Live (all seats filled)
        m.state = if (m.players.len() as u8) == m.seats {
            MatchState::Live
        } else {
            MatchState::Funded
        };

        Ok(())
    }

    /// Post the outcome of a Live match. Winner accounts arrive as
    /// `remaining_accounts`, in the same order as `args.payouts`. Transitions
    /// to Settled and records the outcome. For zero-window models (TRUSTED,
    /// COSIGNED), also pays out inline and transitions to Paid.
    pub fn post_outcome<'info>(
        ctx: Context<'info, PostOutcome<'info>>,
        args: PostOutcomeArgs,
    ) -> Result<()> {
        let m = &mut ctx.accounts.match_account;

        require!(m.state == MatchState::Live, MatchError::NotSettleable);
        require!(
            matches!(
                m.model,
                AttestationModel::Trusted | AttestationModel::Optimistic
            ),
            MatchError::UnsupportedModel,
        );
        require!(
            ctx.accounts.attestor.key() == m.attestor,
            MatchError::AttestorMismatch,
        );
        require!(
            ctx.accounts.treasury.key() == m.treasury,
            MatchError::TreasuryMismatch,
        );

        // Winner accounts are passed as remaining_accounts in the same order as
        // args.payouts. Validate count and bounds first.
        let n = args.payouts.len();
        require!(n >= 1 && n <= MAX_SEATS as usize, MatchError::InvalidWinners);
        require!(
            ctx.remaining_accounts.len() == n,
            MatchError::WinnersAccountsMismatch,
        );

        let pot: u64 = m
            .stake_per_seat
            .checked_mul(m.players.len() as u64)
            .ok_or(MatchError::Overflow)?;
        let rake: u64 = (pot as u128)
            .checked_mul(m.rake_bps as u128)
            .ok_or(MatchError::Overflow)?
            .checked_div(10_000)
            .ok_or(MatchError::Overflow)? as u64;

        let total_payout: u64 = args
            .payouts
            .iter()
            .try_fold(0u64, |acc, p| acc.checked_add(*p))
            .ok_or(MatchError::Overflow)?;
        require!(
            total_payout.checked_add(rake).ok_or(MatchError::Overflow)? == pot,
            MatchError::PayoutMismatch,
        );

        let mut winners: Vec<WinnerEntry> = Vec::with_capacity(n);
        for (i, payout) in args.payouts.iter().enumerate() {
            winners.push(WinnerEntry {
                pubkey: *ctx.remaining_accounts[i].key,
                payout: *payout,
            });
        }

        let now = Clock::get()?.unix_timestamp;
        m.outcome = Some(MatchOutcome {
            winners: winners.clone(),
            rake,
            replay_hash: args.replay_hash,
            posted_at: now,
        });
        m.state = MatchState::Settled;
        m.settled_at = now;

        // Atomic settle+pay path for zero-window models (TRUSTED).
        if m.challenge_window_secs == 0 {
            pay_out_many(
                &ctx.accounts.vault.to_account_info(),
                ctx.remaining_accounts,
                &ctx.accounts.treasury,
                &winners,
                rake,
            )?;
            m.state = MatchState::Paid;
        }

        Ok(())
    }

    /// Pay out a Settled match whose challenge window has elapsed. Anyone may
    /// call this — the action is deterministic from the on-chain outcome.
    /// Winner accounts arrive as remaining_accounts in the same order as
    /// match.outcome.winners.
    pub fn finalize_match<'info>(
        ctx: Context<'info, FinalizeMatch<'info>>,
    ) -> Result<()> {
        let m = &mut ctx.accounts.match_account;

        require!(m.state == MatchState::Settled, MatchError::NotFinalizable);
        require!(
            ctx.accounts.treasury.key() == m.treasury,
            MatchError::TreasuryMismatch,
        );

        let outcome = m.outcome.as_ref().ok_or(MatchError::OutcomeMissing)?;
        require!(
            ctx.remaining_accounts.len() == outcome.winners.len(),
            MatchError::WinnersAccountsMismatch,
        );
        for (i, entry) in outcome.winners.iter().enumerate() {
            require!(
                *ctx.remaining_accounts[i].key == entry.pubkey,
                MatchError::WinnerMismatch,
            );
        }

        let now = Clock::get()?.unix_timestamp;
        let earliest = m
            .settled_at
            .checked_add(m.challenge_window_secs as i64)
            .ok_or(MatchError::Overflow)?;
        require!(now >= earliest, MatchError::ChallengeWindowOpen);

        pay_out_many(
            &ctx.accounts.vault.to_account_info(),
            ctx.remaining_accounts,
            &ctx.accounts.treasury,
            &outcome.winners,
            outcome.rake,
        )?;
        m.state = MatchState::Paid;
        Ok(())
    }
}

fn pay_out_many<'info>(
    vault: &AccountInfo<'info>,
    winner_accounts: &[AccountInfo<'info>],
    treasury: &UncheckedAccount<'info>,
    winners: &[WinnerEntry],
    rake: u64,
) -> Result<()> {
    require!(
        winner_accounts.len() == winners.len(),
        MatchError::WinnersAccountsMismatch,
    );

    let mut vault_lamports = vault.try_borrow_mut_lamports()?;
    for (i, entry) in winners.iter().enumerate() {
        let mut wl = winner_accounts[i].try_borrow_mut_lamports()?;
        **vault_lamports = vault_lamports
            .checked_sub(entry.payout)
            .ok_or(MatchError::InsufficientVault)?;
        **wl = wl.checked_add(entry.payout).ok_or(MatchError::Overflow)?;
    }

    let mut treasury_lamports = treasury.try_borrow_mut_lamports()?;
    **vault_lamports = vault_lamports
        .checked_sub(rake)
        .ok_or(MatchError::InsufficientVault)?;
    **treasury_lamports = treasury_lamports
        .checked_add(rake)
        .ok_or(MatchError::Overflow)?;
    Ok(())
}

// --- args --------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct CreateMatchArgs {
    pub nonce: u64,
    pub seats: u8,
    pub stake_per_seat: u64,
    pub rake_bps: u16,
    pub funding_deadline: i64,
    pub settlement_deadline: i64,
    pub model: AttestationModel,
    /// Pubkey authorized to sign / submit the outcome for this match.
    /// Must equal the registered Game's attestor_pubkey.
    pub attestor: Pubkey,
    /// Destination for the rake portion of the pot at settlement.
    pub treasury: Pubkey,
    /// Seconds between `post_outcome` and earliest `finalize_match`.
    /// Must be 0 for TRUSTED/COSIGNED (atomic settle+pay). For OPTIMISTIC, this
    /// is the dispute window — anyone may challenge during this period (the
    /// dispute path itself is not implemented in v0).
    pub challenge_window_secs: u32,
}

// --- accounts ----------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: CreateMatchArgs)]
pub struct CreateMatch<'info> {
    /// The registered Game this match belongs to. Owned by game_registry.
    pub game: Account<'info, Game>,

    #[account(
        init,
        payer = creator,
        space = 8 + Match::INIT_SPACE,
        seeds = [b"match", game.key().as_ref(), &args.nonce.to_le_bytes()],
        bump,
    )]
    pub match_account: Account<'info, Match>,

    /// Vault PDA — program-owned, holds escrowed lamports plus a back-reference
    /// to the match. Created at match creation so it exists for the first
    /// deposit (house prize in solo, player stakes in PvP).
    #[account(
        init,
        payer = creator,
        space = 8 + Vault::INIT_SPACE,
        seeds = [b"vault", match_account.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct PostOutcomeArgs {
    /// Payouts, in lamports, one per winner. Winner pubkeys are passed as
    /// remaining_accounts in the same order.
    pub payouts: Vec<u64>,
    pub replay_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct PostOutcome<'info> {
    #[account(
        mut,
        seeds = [b"match", match_account.game_id.as_ref(), &match_account.nonce.to_le_bytes()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,

    #[account(
        mut,
        seeds = [b"vault", match_account.key().as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: validated against match.attestor at runtime; signer-checked.
    pub attestor: Signer<'info>,

    /// CHECK: validated against match.treasury at runtime.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    // Winners arrive as remaining_accounts in the same order as args.payouts.
}

#[derive(Accounts)]
pub struct FinalizeMatch<'info> {
    #[account(
        mut,
        seeds = [b"match", match_account.game_id.as_ref(), &match_account.nonce.to_le_bytes()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,

    #[account(
        mut,
        seeds = [b"vault", match_account.key().as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, Vault>,

    /// CHECK: validated against match.treasury.
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,
    // Winners arrive as remaining_accounts in the same order as
    // match.outcome.winners.
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(
        mut,
        seeds = [b"match", match_account.game_id.as_ref(), &match_account.nonce.to_le_bytes()],
        bump = match_account.bump,
    )]
    pub match_account: Account<'info, Match>,

    #[account(
        mut,
        seeds = [b"vault", match_account.key().as_ref()],
        bump = match_account.vault_bump,
    )]
    pub vault: Account<'info, Vault>,

    #[account(mut)]
    pub player: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// --- state -------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Match {
    pub game_id: Pubkey,
    pub nonce: u64,
    pub seats: u8,
    pub stake_per_seat: u64,
    pub rake_bps: u16,
    pub funding_deadline: i64,
    pub settlement_deadline: i64,
    pub model: AttestationModel,
    pub state: MatchState,
    pub creator: Pubkey,
    pub attestor: Pubkey,
    pub treasury: Pubkey,
    pub outcome: Option<MatchOutcome>,
    /// Seconds between settle (`post_outcome`) and earliest finalize.
    /// 0 means atomic settle+pay (TRUSTED). >0 means dispute window (OPTIMISTIC).
    pub challenge_window_secs: u32,
    /// Unix timestamp at which `post_outcome` ran. 0 until the match is Settled.
    pub settled_at: i64,
    #[max_len(MAX_SEATS as usize)]
    pub players: Vec<Pubkey>,
    pub bump: u8,
    pub vault_bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, InitSpace, PartialEq, Eq, Debug)]
pub struct WinnerEntry {
    pub pubkey: Pubkey,
    pub payout: u64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, InitSpace)]
pub struct MatchOutcome {
    #[max_len(MAX_SEATS as usize)]
    pub winners: Vec<WinnerEntry>,
    pub rake: u64,
    pub replay_hash: [u8; 32],
    pub posted_at: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Vault {
    pub match_account: Pubkey,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum AttestationModel {
    Trusted,
    Cosigned,
    Optimistic,
    Zk,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum MatchState {
    Created,
    Funded,
    Live,
    Settled,
    Paid,
    Expired,
    Disputed,
    Resolved,
}

// --- errors ------------------------------------------------------------------

#[error_code]
pub enum MatchError {
    #[msg("seats must be greater than zero")]
    InvalidSeats,
    #[msg("seats exceeds platform maximum")]
    TooManySeats,
    #[msg("seats out of range registered by the game")]
    SeatsOutOfGameRange,
    #[msg("rake_bps exceeds platform maximum")]
    RakeTooHigh,
    #[msg("funding_deadline must precede settlement_deadline")]
    DeadlinesOutOfOrder,
    #[msg("match is not in a joinable state")]
    NotJoinable,
    #[msg("match is already full")]
    MatchFull,
    #[msg("player has already joined this match")]
    AlreadyJoined,
    #[msg("match is not in a settleable state (must be Live)")]
    NotSettleable,
    #[msg("attestation model not supported by this instruction")]
    UnsupportedModel,
    #[msg("signer does not match match.attestor")]
    AttestorMismatch,
    #[msg("treasury account does not match match.treasury")]
    TreasuryMismatch,
    #[msg("payout + rake does not equal pot")]
    PayoutMismatch,
    #[msg("vault has insufficient lamports for payout")]
    InsufficientVault,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("challenge_window_secs must be 0 for this attestation model")]
    WindowNotAllowed,
    #[msg("challenge_window_secs must be > 0 for OPTIMISTIC")]
    WindowRequired,
    #[msg("match is not in a finalizable state (must be Settled)")]
    NotFinalizable,
    #[msg("winner account does not match the posted outcome")]
    WinnerMismatch,
    #[msg("challenge window has not yet expired")]
    ChallengeWindowOpen,
    #[msg("match has no outcome recorded")]
    OutcomeMissing,
    #[msg("winners count is invalid (must be 1..=MAX_SEATS)")]
    InvalidWinners,
    #[msg("remaining_accounts length does not match the winners list")]
    WinnersAccountsMismatch,
}
