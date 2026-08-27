import { describe, expect, it } from 'vitest';
import {
  assertBotNamePools,
  BOT_GAME_CODES,
  BOT_HANDLE_PATTERN,
  BOT_NAME_POOLS,
  stylizeHandle,
} from '@/modules/game-bot/bot-name-pools';

describe('bot name pools', () => {
  it('passes pool validation at module load', () => {
    expect(() => assertBotNamePools()).not.toThrow();
  });

  it('provides 50 names per game and 200 total', () => {
    let total = 0;
    for (const game_code of BOT_GAME_CODES) {
      expect(BOT_NAME_POOLS[game_code]).toHaveLength(50);
      total += BOT_NAME_POOLS[game_code].length;
    }
    expect(total).toBe(200);
  });

  it('mixes 25 plain names and 25 username handles per game', () => {
    for (const game_code of BOT_GAME_CODES) {
      const handles = BOT_NAME_POOLS[game_code].filter((name) => BOT_HANDLE_PATTERN.test(name));
      expect(handles).toHaveLength(25);
      expect(BOT_NAME_POOLS[game_code].length - handles.length).toBe(25);
    }
  });

  it('keeps names globally unique case-insensitively', () => {
    const seen = new Set<string>();
    for (const game_code of BOT_GAME_CODES) {
      for (const name of BOT_NAME_POOLS[game_code]) {
        const key = name.toLowerCase();
        expect(seen.has(key)).toBe(false);
        seen.add(key);
      }
    }
  });

  it('builds username handles in the expected style', () => {
    expect(stylizeHandle('rakib', 12)).toBe('raKIB_12');
    expect(stylizeHandle('sumit', 7)).toBe('suMIT_07');
    expect(stylizeHandle('nadia', 33)).toBe('naDIA_33');
    expect(BOT_HANDLE_PATTERN.test('raKIB_12')).toBe(true);
  });
});
