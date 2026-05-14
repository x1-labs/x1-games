use anchor_lang::prelude::*;

declare_id!("92NzjeGS2kEuLw53vAvox6eFdNfT2VoSTrSX4uGTHKbS");

pub const MIN_ID_LEN: usize = 3;
pub const MAX_ID_LEN: usize = 32;

#[program]
pub mod game_registry {
    use super::*;

    pub fn register_game(ctx: Context<RegisterGame>, args: RegisterGameArgs) -> Result<()> {
        require!(
            args.id.len() >= MIN_ID_LEN && args.id.len() <= MAX_ID_LEN,
            GameRegistryError::InvalidIdLength,
        );
        require!(
            args.id.bytes().all(|b| matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-')),
            GameRegistryError::InvalidIdCharset,
        );
        require!(
            args.seats_min > 0 && args.seats_min <= args.seats_max,
            GameRegistryError::InvalidSeats,
        );

        let g = &mut ctx.accounts.game;
        g.dev_pubkey = ctx.accounts.dev.key();
        g.attestor_pubkey = args.attestor_pubkey;
        g.revenue_receiver = args.revenue_receiver;
        g.simulator_sha256 = args.simulator_sha256;
        g.tier = args.tier;
        g.seats_min = args.seats_min;
        g.seats_max = args.seats_max;
        g.created_at = Clock::get()?.unix_timestamp;
        g.id = args.id;
        g.bump = ctx.bumps.game;

        Ok(())
    }
}

// --- args --------------------------------------------------------------------

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct RegisterGameArgs {
    pub id: String,
    pub attestor_pubkey: Pubkey,
    pub revenue_receiver: Pubkey,
    pub simulator_sha256: [u8; 32],
    pub tier: Tier,
    pub seats_min: u8,
    pub seats_max: u8,
}

// --- accounts ----------------------------------------------------------------

#[derive(Accounts)]
#[instruction(args: RegisterGameArgs)]
pub struct RegisterGame<'info> {
    #[account(
        init,
        payer = dev,
        space = 8 + Game::INIT_SPACE,
        seeds = [b"game", args.id.as_bytes()],
        bump,
    )]
    pub game: Account<'info, Game>,

    #[account(mut)]
    pub dev: Signer<'info>,

    pub system_program: Program<'info, System>,
}

// --- state -------------------------------------------------------------------

#[account]
#[derive(InitSpace)]
pub struct Game {
    pub dev_pubkey: Pubkey,
    pub attestor_pubkey: Pubkey,
    pub revenue_receiver: Pubkey,
    pub simulator_sha256: [u8; 32],
    pub tier: Tier,
    pub seats_min: u8,
    pub seats_max: u8,
    pub created_at: i64,
    #[max_len(MAX_ID_LEN)]
    pub id: String,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, Debug, InitSpace)]
pub enum Tier {
    Demo,
    Live,
    Featured,
}

// --- errors ------------------------------------------------------------------

#[error_code]
pub enum GameRegistryError {
    #[msg("game id length must be 3-32 chars")]
    InvalidIdLength,
    #[msg("game id must match [a-z0-9-]+")]
    InvalidIdCharset,
    #[msg("seats_min must be > 0 and <= seats_max")]
    InvalidSeats,
}
