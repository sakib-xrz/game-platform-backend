export type WalletBalanceUpdatedPayload = {
  wallet_id: string;
  balance: string;
  wallet_version: number;
  reason: string;
  round_id?: string;
  payout?: string;
  refund?: string;
};
