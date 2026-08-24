import httpStatus from 'http-status';
import { Prisma } from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { getPagination } from '@/utils/pagination';
import type {
  AdminPlatformUserLedgerQuery,
  AdminPlatformUserSearchQuery,
} from './platform-user.validation';

const DEFAULT_CURRENCY_CODE = 'COIN';
const PLATFORM_LEDGER_REFERENCE_TYPES = ['platform_coin_deposit', 'platform_coin_withdrawal'] as const;

const platformUserSelect = {
  id: true,
  platform_app_id: true,
  external_user_id: true,
  email: true,
  display_name: true,
  photo_url: true,
  status: true,
  created_at: true,
  updated_at: true,
  platform_app: {
    select: {
      app_name: true,
      package_name: true,
    },
  },
} satisfies Prisma.PlatformUserSelect;

type PlatformUserRecord = Prisma.PlatformUserGetPayload<{ select: typeof platformUserSelect }>;

const serializePlatformUser = (user: PlatformUserRecord, balance: bigint | null) => ({
  id: user.id,
  platform_app_id: user.platform_app_id,
  app_name: user.platform_app.app_name,
  package_name: user.platform_app.package_name,
  external_user_id: user.external_user_id,
  email: user.email,
  display_name: user.display_name,
  photo_url: user.photo_url,
  status: user.status,
  balance: balance?.toString() ?? '0',
  currency: DEFAULT_CURRENCY_CODE,
  created_at: user.created_at,
  updated_at: user.updated_at,
});

const getBalancesForUsers = async (user_ids: string[]) => {
  if (!user_ids.length) return new Map<string, bigint>();

  const wallets = await prisma.wallet.findMany({
    where: {
      user_id: { in: user_ids },
      currency: { code: DEFAULT_CURRENCY_CODE, is_active: true },
    },
    select: {
      user_id: true,
      balance: true,
    },
  });

  return new Map(wallets.map((wallet) => [wallet.user_id, wallet.balance]));
};

const listAdminPlatformUsers = async (query: AdminPlatformUserSearchQuery) => {
  const pagination = getPagination(query.page, query.limit);
  const normalized_search = query.search.trim();
  const where: Prisma.PlatformUserWhereInput = {
    ...(query.platform_app_id ? { platform_app_id: query.platform_app_id } : {}),
    ...(query.status ? { status: query.status } : {}),
    ...(normalized_search
      ? {
          OR: [
            { external_user_id: { contains: normalized_search, mode: 'insensitive' } },
            { email: { contains: normalized_search, mode: 'insensitive' } },
            { display_name: { contains: normalized_search, mode: 'insensitive' } },
          ],
        }
      : {}),
  };

  const [users, total] = await prisma.$transaction([
    prisma.platformUser.findMany({
      where,
      select: platformUserSelect,
      orderBy: [{ updated_at: 'desc' }, { external_user_id: 'asc' }],
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.platformUser.count({ where }),
  ]);

  const balances = await getBalancesForUsers(users.map((user) => user.id));

  return {
    items: users.map((user) => serializePlatformUser(user, balances.get(user.id) ?? null)),
    total,
    ...pagination,
  };
};

const getAdminPlatformUser = async (user_id: string) => {
  const user = await prisma.platformUser.findUnique({
    where: { id: user_id },
    select: platformUserSelect,
  });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform user not found');
  }

  const balances = await getBalancesForUsers([user.id]);
  return serializePlatformUser(user, balances.get(user.id) ?? null);
};

const listAdminPlatformUserLedger = async (user_id: string, query: AdminPlatformUserLedgerQuery) => {
  const user = await prisma.platformUser.findUnique({
    where: { id: user_id },
    select: { id: true },
  });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform user not found');
  }

  const pagination = getPagination(query.page, query.limit);
  const where: Prisma.WalletLedgerWhereInput = {
    user_id,
    reference_type: { in: [...PLATFORM_LEDGER_REFERENCE_TYPES] },
  };

  const [entries, total] = await prisma.$transaction([
    prisma.walletLedger.findMany({
      where,
      select: {
        id: true,
        type: true,
        amount: true,
        balance_before: true,
        balance_after: true,
        reference_type: true,
        reference_id: true,
        metadata: true,
        created_at: true,
      },
      orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
      skip: pagination.skip,
      take: pagination.limit,
    }),
    prisma.walletLedger.count({ where }),
  ]);

  return {
    items: entries.map((entry) => ({
      id: entry.id,
      type: entry.reference_type === 'platform_coin_deposit' ? 'deposit' as const : 'withdrawal' as const,
      ledger_type: entry.type,
      amount: (entry.amount < 0n ? -entry.amount : entry.amount).toString(),
      balance_before: entry.balance_before.toString(),
      balance_after: entry.balance_after.toString(),
      client_request_id: entry.reference_id,
      metadata: entry.metadata,
      created_at: entry.created_at,
    })),
    total,
    ...pagination,
  };
};

const listPlatformAppsForFilter = async () =>
  prisma.platformApp.findMany({
    select: {
      id: true,
      app_name: true,
      package_name: true,
      status: true,
    },
    orderBy: [{ app_name: 'asc' }],
  });

const PlatformUserService = {
  listAdminPlatformUsers,
  getAdminPlatformUser,
  listAdminPlatformUserLedger,
  listPlatformAppsForFilter,
};

export default PlatformUserService;
