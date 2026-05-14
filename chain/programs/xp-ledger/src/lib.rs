use anchor_lang::prelude::*;
use match_program::{Match, MatchState};

declare_id!("E4ccwzzHoLeziC4S7so55etspU6Ag6zrGNERKhSuaD74");

pub const WINNER_XP: u64 = 100;
pub const LOSER_XP: u64 = 25;

#[program]
pub mod xp_ledger {
    use super::*;

    /// Credit XP to a participant of a settled match.
    ///
    /// Anyone may call this — the credit amount is deterministic from the
    /// settled Match state. The CreditReceipt PDA enforces single-use: a
    /// second call for the same (match, player) tuple fails on PDA re-init.
    ///
    /// Soulbound: the only mutation to XpBalance is increment via this path.
    /// There is no burn, no transfer, no spend instruction in v0.
    pub fn credit_xp(ctx: Context<CreditXp>) -> Result<()> {
        let m = &ctx.accounts.match_account;
        require!(
            matches!(m.state, MatchState::Paid | MatchState::Settled),
            XpLedgerError::MatchNotSettled,
        );

        let outcome = m
            .outcome
            .as_ref()
            .ok_or(XpLedgerError::OutcomeMissing)?;

        let claimant = ctx.accounts.player.key();
        let is_participant = m.players.iter().any(|p| *p == claimant);
        require!(is_participant, XpLedgerError::NotAParticipant);

        let amount: u64 = if outcome.winners.iter().any(|w| w.pubkey == claimant) {
            WINNER_XP
        } else {
            LOSER_XP
        };

        // Initialize or update the running balance.
        let balance = &mut ctx.accounts.xp_balance;
        if balance.player == Pubkey::default() {
            balance.game = m.game_id;
            balance.player = claimant;
            balance.bump = ctx.bumps.xp_balance;
        }
        balance.amount = balance
            .amount
            .checked_add(amount)
            .ok_or(XpLedgerError::Overflow)?;

        let receipt = &mut ctx.accounts.credit_receipt;
        receipt.match_account = m.key();
        receipt.player = claimant;
        receipt.amount = amount;
        receipt.credited_at = Clock::get()?.unix_timestamp;
        receipt.bump = ctx.bumps.credit_receipt;

        Ok(())
    }
}

// --- accounts ----------------------------------------------------------------

#[derive(Accounts)]
pub struct CreditXp<'info> {
    /// Settled Match account. Owned by match_program; Anchor validates that.
    pub match_account: Account<'info, Match>,

    /// CHECK: just a Pubkey; validated against match_account.players in body.
    pub player: UncheckedAccount<'info>,

    /// Running XP balance for (match.game_id, player). Initialized lazily.
    #[account(
        init_if_needed,
        payer = payer,
        space = 8 + XpBalance::INIT_SPACE,
        seeds = [b"xp", match_account.game_id.as_ref(), player.key().as_ref()],
        bump,
    )]
    pub xp_balance: Account<'info, XpBalance>,

    /// Single-use credit receipt per (match, player). Re-init fails, which
    /// is exactly the anti-double-credit guarantee.
    #[account(
        init,
        payer = payer,
        space = 8 + CreditReceipt::INIT_SPACE,
        seeds = [b"xp-receipt", match_account.key().as_ref(), player.key().as_ref()],
        bump,
    )]
    pub credit_receipt: Account<'info, CreditReceipt>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// --- state -------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct XpBalance {
    pub game: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CreditReceipt {
    pub match_account: Pubkey,
    pub player: Pubkey,
    pub amount: u64,
    pub credited_at: i64,
    pub bump: u8,
}

// --- errors ------------------------------------------------------------------

#[error_code]
pub enum XpLedgerError {
    #[msg("match has not settled yet")]
    MatchNotSettled,
    #[msg("match has no outcome recorded")]
    OutcomeMissing,
    #[msg("player is not a participant in this match")]
    NotAParticipant,
    #[msg("arithmetic overflow")]
    Overflow,
}
