import { describe, expect, it } from 'vitest';
import {
  isBotUserIdSync,
  resolveGameIdentitySync,
} from '@/modules/game-bot/bot-identity';

describe('bot-identity', () => {
  it('masks human user ids in public snapshots', () => {
    expect(resolveGameIdentitySync('player-abc123')).toEqual({
      display_name: 'Player abc123',
      avatar_url: null,
    });
  });

  it('does not treat arbitrary ids as bots without cache data', () => {
    expect(isBotUserIdSync('gbot01aarav')).toBe(false);
  });
});
