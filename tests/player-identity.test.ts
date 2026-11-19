import { beforeEach, describe, expect, it, vi } from 'vitest';
import { signPlayerToken } from '@/utils/player-token';

const app = {
  id: 'app_kotha',
  app_key: 'kotha-live',
  package_name: 'com.kotha.live',
  status: 'active',
  wallet_mode: 'seamless',
  player_token_secret: 'player-secret',
  signing_secret: 'signing-secret',
  signing_secret_previous: null,
};

const users = new Map<string, any>();

const { syncMock, walletContextMock } = vi.hoisted(() => ({
  syncMock: vi.fn(async () => 1007056n),
  walletContextMock: vi.fn(),
}));

vi.mock('@/config', () => ({
  default: {
    allow_dev_identity_header: true,
    player_token_session_grace_seconds: 24 * 60 * 60,
  },
}));

vi.mock('@/lib/prisma', () => ({
  default: {
    platformApp: {
      findFirst: vi.fn(async () => app),
    },
    platformUser: {
      findUnique: vi.fn(async ({ where }: any) => {
        const key = where.platform_app_id_external_user_id;
        return users.get(`${key.platform_app_id}:${key.external_user_id}`) ?? null;
      }),
      create: vi.fn(async ({ data }: any) => {
        const user = { id: `cuid_${data.external_user_id}`, ...data };
        users.set(`${data.platform_app_id}:${data.external_user_id}`, user);
        return user;
      }),
      update: vi.fn(async ({ where, data }: any) => {
        const user = [...users.values()].find((u) => u.id === where.id);
        Object.assign(user, data);
        return user;
      }),
    },
  },
}));

vi.mock('@/modules/platform-integration/seamless-wallet.services', () => ({
  syncSeamlessUserBalance: syncMock,
  getUserWalletContext: walletContextMock,
}));

const { resolvePlayerIdentity } = await import('@/middlewares/player-context');
const { clearPlayerTokenCache } = await import(
  '@/modules/platform-integration/player-identity.services'
);

const hostToken = (sub: string, secret = 'player-secret', ttl = 900) =>
  signPlayerToken({ sub, app: 'kotha-live', username: 'tuptap' }, secret, ttl);

describe('host player identity resolution', () => {
  beforeEach(() => {
    users.clear();
    clearPlayerTokenCache();
    syncMock.mockClear();
    walletContextMock.mockReset();
    users.set('app_kotha:3', {
      id: 'cuid_existing_3',
      platform_app_id: 'app_kotha',
      external_user_id: '3',
      display_name: 'tuptap',
      photo_url: null,
      status: 'active',
    });
  });

  it('maps a host token (sub "3") to the internal player id, not "3"', async () => {
    const userId = await resolvePlayerIdentity({
      token: hostToken('3'),
      headerUserId: '3', // what the old frontend also sends
    });
    expect(userId).toBe('cuid_existing_3');
    expect(syncMock).not.toHaveBeenCalled();
  });

  it('creates the player on first sight and pulls the host balance', async () => {
    const userId = await resolvePlayerIdentity({ token: hostToken('77') });
    expect(userId).toBe('cuid_77');
    expect(syncMock).toHaveBeenCalledWith('cuid_77');
  });

  it('keeps an open session alive after the 15 minute launch expiry', async () => {
    const expiredOneHourAgo = hostToken('3', 'player-secret', -3600);
    await expect(
      resolvePlayerIdentity({ token: expiredOneHourAgo }),
    ).resolves.toBe('cuid_existing_3');
  });

  it('rejects tokens past the session grace window', async () => {
    const expiredTwoDaysAgo = hostToken('3', 'player-secret', -2 * 24 * 3600);
    await expect(
      resolvePlayerIdentity({ token: expiredTwoDaysAgo }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('rejects a forged token', async () => {
    await expect(
      resolvePlayerIdentity({ token: hostToken('3', 'attacker-secret') }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('refuses a bare X-User-Id for a seamless host player', async () => {
    walletContextMock.mockResolvedValue({ isSeamless: true });
    await expect(
      resolvePlayerIdentity({ headerUserId: 'cuid_existing_3' }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it('still accepts the legacy header for non-seamless players', async () => {
    walletContextMock.mockResolvedValue({ isSeamless: false });
    await expect(
      resolvePlayerIdentity({ headerUserId: 'local_player_1' }),
    ).resolves.toBe('local_player_1');
  });
});
