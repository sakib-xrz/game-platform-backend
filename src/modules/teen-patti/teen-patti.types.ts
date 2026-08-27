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

export type TeenPattiPublicIdentity = {
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
};

export type TeenPattiBettorAggregate = TeenPattiPublicIdentity & {
  round_id: string;
  option_id: string;
  total_amount: string;
  bet_count: number;
  first_bet_at: string;
  last_bet_at: string;
};

export type TeenPattiPreviewCard = {
  option_id: string;
  card: string;
};

export type TeenPattiTopWinner = TeenPattiPublicIdentity & {
  rank: number;
  winning_stake: string;
  bet_count: number;
  total_payout: string;
  first_bet_at: string;
};

export type TeenPattiBetPlacedPayload = TeenPattiPublicIdentity & {
  bet_id: string;
  round_id: string;
  option_id: string;
  amount: string;
  accepted_at: string;
  user_total_amount: string;
  option_total_amount: string;
  bet_count: number;
  first_bet_at: string;
  last_bet_at: string;
  player_count: number;
  round_bet_count: number;
};
