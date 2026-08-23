export const RANK_CHARS = ['A', 'K', 'Q', 'J', 'T', '9', '8', '7', '6', '5', '4', '3', '2'] as const;
export const SUIT_CHARS = ['S', 'H', 'D', 'C'] as const;

export type RankChar = (typeof RANK_CHARS)[number];
export type SuitChar = (typeof SUIT_CHARS)[number];
export type CardCode = `${RankChar}${SuitChar}`;

export type HandCategory =
  | 'trail'
  | 'pure_sequence'
  | 'sequence'
  | 'color'
  | 'pair'
  | 'high_card';

export type EvaluatedHand = {
  cards: [CardCode, CardCode, CardCode];
  category: HandCategory;
  rank_key: string;
};

const RANK_VALUE: Record<RankChar, number> = {
  A: 14,
  K: 13,
  Q: 12,
  J: 11,
  T: 10,
  '9': 9,
  '8': 8,
  '7': 7,
  '6': 6,
  '5': 5,
  '4': 4,
  '3': 3,
  '2': 2,
};

const CATEGORY_SCORE: Record<HandCategory, number> = {
  trail: 6,
  pure_sequence: 5,
  sequence: 4,
  color: 3,
  pair: 2,
  high_card: 1,
};

const pad = (value: number): string => String(value).padStart(2, '0');

const rankKey = (category: HandCategory, a: number, b = 0, c = 0): string =>
  `${CATEGORY_SCORE[category]}:${pad(a)}:${pad(b)}:${pad(c)}`;

export const parseCard = (code: string): { rank: RankChar; suit: SuitChar; value: number } => {
  const rank = code[0] as RankChar;
  const suit = code[1] as SuitChar;
  if (!RANK_VALUE[rank] || !SUIT_CHARS.includes(suit)) {
    throw new Error(`Invalid card code: ${code}`);
  }
  return { rank, suit, value: RANK_VALUE[rank] };
};

const sequenceHigh = (values: number[]): number | null => {
  const unique = [...new Set(values)].sort((left, right) => left - right);
  if (unique.length !== 3) return null;
  if (unique[0] === 2 && unique[1] === 3 && unique[2] === 14) return 15;
  const low = unique[0]!;
  const mid = unique[1]!;
  const high = unique[2]!;
  if (high - low === 2 && mid === low + 1) return high;
  return null;
};

export const evaluateHand = (cards: [CardCode, CardCode, CardCode]): EvaluatedHand => {
  const parsed = cards.map(parseCard);
  const values = parsed.map((card) => card.value);
  const suits = parsed.map((card) => card.suit);
  const is_flush = suits[0] === suits[1] && suits[1] === suits[2];
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);

  if ([...counts.values()].includes(3)) {
    return { cards, category: 'trail', rank_key: rankKey('trail', values[0]!) };
  }

  const seq_high = sequenceHigh(values);
  if (seq_high !== null) {
    const category: HandCategory = is_flush ? 'pure_sequence' : 'sequence';
    return { cards, category, rank_key: rankKey(category, seq_high) };
  }

  if (is_flush) {
    const ordered = [...values].sort((left, right) => right - left);
    return {
      cards,
      category: 'color',
      rank_key: rankKey('color', ordered[0]!, ordered[1]!, ordered[2]!),
    };
  }

  const pair_entry = [...counts.entries()].find(([, count]) => count === 2);
  if (pair_entry) {
    const kicker = [...counts.entries()].find(([, count]) => count === 1)?.[0] ?? 0;
    return { cards, category: 'pair', rank_key: rankKey('pair', pair_entry[0], kicker) };
  }

  const ordered = [...values].sort((left, right) => right - left);
  return {
    cards,
    category: 'high_card',
    rank_key: rankKey('high_card', ordered[0]!, ordered[1]!, ordered[2]!),
  };
};

export const compareRankKeys = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

export const uniqueHighestIndex = (hands: EvaluatedHand[]): number | null => {
  if (!hands.length) return null;
  let best = 0;
  for (let index = 1; index < hands.length; index += 1) {
    if (compareRankKeys(hands[index]!.rank_key, hands[best]!.rank_key) > 0) best = index;
  }
  const ties = hands.filter((hand) => hand.rank_key === hands[best]!.rank_key).length;
  return ties === 1 ? best : null;
};
