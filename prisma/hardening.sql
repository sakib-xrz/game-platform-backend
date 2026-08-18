-- Prisma does not model every PostgreSQL CHECK constraint in schema.prisma.
-- This idempotent hardening script should be executed after the initial migration.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_balance_non_negative_ck') THEN
    ALTER TABLE wallets ADD CONSTRAINT wallet_balance_non_negative_ck CHECK (balance >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'wallet_ledger_math_ck') THEN
    ALTER TABLE wallet_ledger ADD CONSTRAINT wallet_ledger_math_ck CHECK (balance_after = balance_before + amount AND balance_after >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_config_limits_ck') THEN
    ALTER TABLE greedy_config_versions ADD CONSTRAINT greedy_config_limits_ck CHECK (
      betting_duration_ms > 0 AND lock_duration_ms > 0 AND drawing_duration_ms > 0 AND result_duration_ms > 0
      AND min_bet > 0 AND max_single_bet >= min_bet AND max_round_bet >= max_single_bet
    );
  END IF;
END $$;


DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_chip_value_positive_ck') THEN
    ALTER TABLE greedy_chip_value_versions ADD CONSTRAINT greedy_chip_value_positive_ck CHECK (amount > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_option_positive_math_ck') THEN
    ALTER TABLE greedy_option_versions ADD CONSTRAINT greedy_option_positive_math_ck CHECK (
      payout_numerator > 0 AND payout_denominator > 0 AND probability_weight > 0
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_round_number_positive_ck') THEN
    ALTER TABLE greedy_rounds ADD CONSTRAINT greedy_round_number_positive_ck CHECK (round_number > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_bet_amount_positive_ck') THEN
    ALTER TABLE greedy_bets ADD CONSTRAINT greedy_bet_amount_positive_ck CHECK (amount > 0 AND payout_numerator > 0 AND payout_denominator > 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_settlement_payout_non_negative_ck') THEN
    ALTER TABLE greedy_bet_settlements ADD CONSTRAINT greedy_settlement_payout_non_negative_ck CHECK (payout_amount >= 0);
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_user_payout_non_negative_ck') THEN
    ALTER TABLE greedy_user_payouts ADD CONSTRAINT greedy_user_payout_non_negative_ck CHECK (
      winning_bet_count > 0 AND total_winning_stake > 0 AND total_payout > 0
    );
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'greedy_user_refund_positive_ck') THEN
    ALTER TABLE greedy_user_refunds ADD CONSTRAINT greedy_user_refund_positive_ck CHECK (total_bet_amount > 0);
  END IF;
END $$;
