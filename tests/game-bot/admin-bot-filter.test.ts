import { describe, expect, it, vi } from 'vitest';
import { buildExcludeBotsSql, humanOnlyBetUserFilter } from '@/modules/game-bot/admin-bot-filter';

vi.mock('@/modules/game-bot/bot-identity', () => ({
  getActiveBotIds: vi.fn().mockResolvedValue(['bot-a', 'bot-b']),
}));

describe('admin-bot-filter', () => {
  it('passes through an explicit user id', async () => {
    await expect(humanOnlyBetUserFilter('human-1')).resolves.toBe('human-1');
  });

  it('builds a notIn filter when bots exist', async () => {
    await expect(humanOnlyBetUserFilter()).resolves.toEqual({
      notIn: ['bot-a', 'bot-b'],
    });
  });

  it('builds SQL that excludes bot ids', () => {
    const sql = buildExcludeBotsSql(['bot-a', 'bot-b']);
    expect(sql.values).toEqual(['bot-a', 'bot-b']);
  });

  it('uses TRUE when no bot ids are configured', () => {
    const sql = buildExcludeBotsSql([]);
    expect(sql.strings.join('')).toContain('TRUE');
  });
});
