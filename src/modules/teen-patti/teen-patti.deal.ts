import crypto from 'crypto';
import { sha256 } from '@/utils/hash';
import { TEEN_PATTI_MAX_DEAL_ATTEMPTS } from './teen-patti.constant';
import {
  RANK_CHARS,
  SUIT_CHARS,
  evaluateHand,
  uniqueHighestIndex,
  type CardCode,
  type EvaluatedHand,
} from './teen-patti.rank';

export type DealtHand = EvaluatedHand & {
  option_id: string;
  option_code: string;
};

export type DealResult = {
  winner_index: number;
  hands: DealtHand[];
  entropy_digest: string;
  deal_attempt_count: number;
};

type DeckOption = { id: string; code: string };

const fullDeck = (): CardCode[] => {
  const cards: CardCode[] = [];
  for (const rank of RANK_CHARS) {
    for (const suit of SUIT_CHARS) {
      cards.push(`${rank}${suit}` as CardCode);
    }
  }
  return cards;
};

const shuffle = (cards: CardCode[]): { cards: CardCode[]; entropy: Buffer } => {
  const entropy_chunks: Buffer[] = [];
  const shuffled = [...cards];
  for (let index = shuffled.length - 1; index > 0; index -= 1) {
    const bytes = crypto.randomBytes(4);
    entropy_chunks.push(bytes);
    const pick = bytes.readUInt32BE(0) % (index + 1);
    const current = shuffled[index]!;
    shuffled[index] = shuffled[pick]!;
    shuffled[pick] = current;
  }
  return { cards: shuffled, entropy: Buffer.concat(entropy_chunks) };
};

export const dealUniqueWinner = (options: DeckOption[]): DealResult => {
  if (options.length !== 3) throw new Error('Teen Patti requires exactly three decks');

  const entropy_parts: Buffer[] = [];
  for (let attempt = 1; attempt <= TEEN_PATTI_MAX_DEAL_ATTEMPTS; attempt += 1) {
    const shuffled = shuffle(fullDeck());
    entropy_parts.push(shuffled.entropy);
    const hands: DealtHand[] = options.map((option, index) => {
      const start = index * 3;
      const cards: [CardCode, CardCode, CardCode] = [
        shuffled.cards[start]!,
        shuffled.cards[start + 1]!,
        shuffled.cards[start + 2]!,
      ];
      return {
        option_id: option.id,
        option_code: option.code,
        ...evaluateHand(cards),
      };
    });
    const winner_index = uniqueHighestIndex(hands);
    if (winner_index !== null) {
      return {
        winner_index,
        hands,
        entropy_digest: sha256(Buffer.concat(entropy_parts)),
        deal_attempt_count: attempt,
      };
    }
  }

  throw new Error('Teen Patti deal could not produce a unique winner');
};

export const dealWithWinningOption = (
  options: DeckOption[],
  forcedWinnerOptionId: string,
): DealResult => {
  if (options.length !== 3) throw new Error('Teen Patti requires exactly three decks');

  const forced_index = options.findIndex((option) => option.id === forcedWinnerOptionId);
  if (forced_index === -1) {
    throw new Error('Teen Patti forced winner option was not found');
  }

  const entropy_parts: Buffer[] = [];
  for (let attempt = 1; attempt <= TEEN_PATTI_MAX_DEAL_ATTEMPTS; attempt += 1) {
    const shuffled = shuffle(fullDeck());
    entropy_parts.push(shuffled.entropy);
    const hands: DealtHand[] = options.map((option, index) => {
      const start = index * 3;
      const cards: [CardCode, CardCode, CardCode] = [
        shuffled.cards[start]!,
        shuffled.cards[start + 1]!,
        shuffled.cards[start + 2]!,
      ];
      return {
        option_id: option.id,
        option_code: option.code,
        ...evaluateHand(cards),
      };
    });
    const winner_index = uniqueHighestIndex(hands);
    if (winner_index !== null && winner_index === forced_index) {
      return {
        winner_index,
        hands,
        entropy_digest: sha256(Buffer.concat(entropy_parts)),
        deal_attempt_count: attempt,
      };
    }
  }

  throw new Error('Teen Patti deal could not produce the forced winner');
};
