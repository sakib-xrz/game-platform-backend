import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { adminWalletSearchSchema } from '@/modules/wallet/wallet.validation';

describe('admin wallet search contract', () => {
  it('normalizes bounded search and pagination query values', () => {
    const parsed = adminWalletSearchSchema.parse({
      query: { search: '  player-10  ', page: '2', limit: '25' },
    });
    expect(parsed.query).toEqual({
      search: 'player-10',
      page: 2,
      limit: 25,
    });
  });

  it('protects wallet search with wallet.read permission', () => {
    const routes = readFileSync('src/modules/wallet/wallet.routes.ts', 'utf8');
    expect(routes).toMatch(
      /WalletAdminRoutes\.get\('\/'[\s\S]*requireAdminPermission\('wallet\.read'\)/,
    );
  });
});
