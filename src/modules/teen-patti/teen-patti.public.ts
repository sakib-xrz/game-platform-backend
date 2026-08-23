import type { Prisma } from '@/generated/prisma/client';
import type { CardCode, HandCategory } from './teen-patti.rank';
import type {
  TeenPattiBetPlacedPayload,
  TeenPattiPreviewCard,
} from './teen-patti.types';

export type StoredTeenPattiHand = {
  option_id: string;
  option_code: string;
  cards: [CardCode, CardCode, CardCode];
  category: HandCategory;
  rank_key: string;
};

type StoredResultForPreview = {
  audit_hash: string;
  hands: Prisma.JsonValue;
};

const isStoredHand = (value: unknown): value is StoredTeenPattiHand => {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<StoredTeenPattiHand>;
  return (
    typeof candidate.option_id === 'string' &&
    Array.isArray(candidate.cards) &&
    candidate.cards.length === 3 &&
    candidate.cards.every((card) => typeof card === 'string')
  );
};

/**
 * This is the only projection used before reveal. It deliberately returns one
 * card per option and never copies the stored hand, category, rank, or winner.
 */
export const buildTeenPattiPreview = (
  result: StoredResultForPreview,
): { preview_cards: TeenPattiPreviewCard[]; result_commitment: string } => {
  const hands = Array.isArray(result.hands)
    ? result.hands.filter(isStoredHand)
    : [];

  return {
    preview_cards: hands.map((hand) => ({
      option_id: hand.option_id,
      card: hand.cards[0],
    })),
    result_commitment: result.audit_hash,
  };
};

export const buildTeenPattiBetPlacedPayload = (
  bet: {
    id: string;
    round_id: string;
    option_id: string;
    amount: bigint;
    accepted_at: Date;
    user_total_amount: bigint;
    option_total_amount: bigint;
    bet_count: number;
    first_bet_at: Date;
    last_bet_at: Date;
    player_count: number;
    round_bet_count: number;
  },
  bettor: {
    user_id: string;
    display_name: string | null;
    avatar_url: string | null;
  },
): TeenPattiBetPlacedPayload => ({
  bet_id: bet.id,
  round_id: bet.round_id,
  option_id: bet.option_id,
  user_id: bettor.user_id,
  display_name: bettor.display_name,
  avatar_url: bettor.avatar_url,
  amount: bet.amount.toString(),
  accepted_at: bet.accepted_at.toISOString(),
  user_total_amount: bet.user_total_amount.toString(),
  option_total_amount: bet.option_total_amount.toString(),
  bet_count: bet.bet_count,
  first_bet_at: bet.first_bet_at.toISOString(),
  last_bet_at: bet.last_bet_at.toISOString(),
  player_count: bet.player_count,
  round_bet_count: bet.round_bet_count,
});
