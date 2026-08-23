export type BetResponse = {
  bet_id: string;
  round_id: string;
  option_id: string;
  amount: string;
  client_request_id: string;
  wallet_balance: string;
  wallet_version: number;
  accepted_at: string;
};

export type GreedyPublicIdentity = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type GreedyBettorAggregate = GreedyPublicIdentity & {
  round_id: string;
  option_id: string;
  total_amount: string;
  bet_count: number;
  first_bet_at: string;
  last_bet_at: string;
};

export type GreedyTopWinner = GreedyPublicIdentity & {
  rank: number;
  winning_stake: string;
  bet_count: number;
  total_payout: string;
  first_bet_at: string;
};

export type GreedyBetPlacedPayload = {
  bet_id: string;
  round_id: string;
  option_id: string;
  amount: string;
  accepted_at: string;
  total_amount: string;
  bet_count: number;
  first_bet_at: string;
  last_bet_at: string;
  bettor: GreedyPublicIdentity;
};
