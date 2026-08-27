export const LUCKY_77_GAME_CODE = 'LUCKY_77';
export const LUCKY_77_CURRENCY_CODE = 'COIN';
export const LUCKY_77_SOCKET_ROOM = 'game:lucky-77';
export const LUCKY_77_RNG_ALGORITHM_VERSION = 'lucky-77-weighted-slots-v1';
export const LUCKY_77_RNG_ALGORITHM_VERSION_BIASED = 'lucky-77-weighted-biased-v3';
export const LUCKY_77_IDEMPOTENCY_SCOPE = 'lucky_77.place_bet';

/** Fixed wheel layout: index 0 is the first slot after the pointer baseline. */
export const LUCKY_77_SLOT_MAP = [
  'APPLE',
  'WATERMELON',
  'APPLE',
  'WATERMELON',
  'SEVENTY_SEVEN',
  'APPLE',
  'WATERMELON',
  'APPLE',
  'WATERMELON',
] as const;

export type Lucky77SlotCode = (typeof LUCKY_77_SLOT_MAP)[number];
