import httpStatus from 'http-status';
import {
  AuditActorType,
  PlatformAppStatus,
  PlatformUserStatus,
  Prisma,
} from '@/generated/prisma/client';
import AppError from '@/errors/app-error';
import prisma from '@/lib/prisma';
import { normalizePackageName, normalizeShaKey } from '@/modules/platform-app/platform-app.validation';
import { creditPlatformPurchase, debitPlatformWithdrawal, ensureWallet } from '@/modules/wallet/wallet.services';
import type {
  AppCredentials,
  CreditPlatformUserCoinsBody,
  SyncPlatformUserBody,
  WithdrawPlatformUserCoinsBody,
} from './platform-integration.validation';

const DEFAULT_CURRENCY_CODE = 'COIN';

export type PlatformAppContext = {
  id: string;
  app_name: string;
  package_name: string;
  sha_key: string;
  status: PlatformAppStatus;
};

const resolveActivePlatformApp = async (
  credentials: AppCredentials,
): Promise<PlatformAppContext> => {
  const package_name = normalizePackageName(credentials.package_name);
  const sha_key = normalizeShaKey(credentials.sha_key);
  const app_name = credentials.app_name.trim();

  const app = await prisma.platformApp.findUnique({
    where: { package_name },
    select: {
      id: true,
      app_name: true,
      package_name: true,
      sha_key: true,
      status: true,
    },
  });

  if (!app) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid app credentials');
  }

  const name_matches = app.app_name.trim().toLowerCase() === app_name.toLowerCase();
  const sha_matches = normalizeShaKey(app.sha_key) === sha_key;
  if (!name_matches || !sha_matches) {
    throw new AppError(httpStatus.UNAUTHORIZED, 'Invalid app credentials');
  }

  if (app.status !== PlatformAppStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform app is disabled');
  }

  return app;
};

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
} satisfies Prisma.PlatformUserSelect;

const writePlatformAudit = async (
  tx: Prisma.TransactionClient,
  platform_app_id: string,
  data: {
    action: string;
    entity_type: string;
    entity_id?: string;
    old_values?: Prisma.InputJsonValue;
    new_values?: Prisma.InputJsonValue;
    request_id?: string;
  },
) => {
  await tx.auditLog.create({
    data: {
      actor_type: AuditActorType.system,
      actor_id: platform_app_id,
      outcome: 'success',
      action: data.action,
      entity_type: data.entity_type,
      entity_id: data.entity_id,
      old_values: data.old_values,
      new_values: data.new_values,
      request_id: data.request_id,
    },
  });
};

const getWalletBalance = async (user_id: string, tx: Prisma.TransactionClient = prisma) => {
  const wallet = await ensureWallet(user_id, tx);
  return wallet.balance;
};

const serializeUserResponse = (
  user: Prisma.PlatformUserGetPayload<{ select: typeof platformUserSelect }>,
  balance: bigint,
  created: boolean,
) => ({
  external_user_id: user.external_user_id,
  email: user.email,
  name: user.display_name,
  photo_url: user.photo_url,
  balance: balance.toString(),
  currency: DEFAULT_CURRENCY_CODE,
  created,
});

const findPlatformUserOrThrow = async (
  platform_app: PlatformAppContext,
  external_user_id: string,
) => {
  const user = await prisma.platformUser.findUnique({
    where: {
      platform_app_id_external_user_id: {
        platform_app_id: platform_app.id,
        external_user_id,
      },
    },
    select: platformUserSelect,
  });
  if (!user) {
    throw new AppError(httpStatus.NOT_FOUND, 'Platform user not found for this app');
  }
  return user;
};

const syncPlatformUser = async (
  body: SyncPlatformUserBody,
  request_id?: string,
) => {
  const platform_app = await resolveActivePlatformApp(body);
  const external_user_id = body.external_user_id.trim();
  const email = body.email.trim().toLowerCase();
  const display_name = body.name.trim();
  const photo_url = body.photo_url?.trim() || null;

  const existing = await prisma.platformUser.findUnique({
    where: {
      platform_app_id_external_user_id: {
        platform_app_id: platform_app.id,
        external_user_id,
      },
    },
    select: platformUserSelect,
  });

  if (existing) {
    const result = await prisma.$transaction(async (tx) => {
      const updated = await tx.platformUser.update({
        where: { id: existing.id },
        data: {
          email,
          display_name,
          photo_url,
        },
        select: platformUserSelect,
      });
      const balance = await getWalletBalance(updated.id, tx);
      await writePlatformAudit(tx, platform_app.id, {
        action: 'platform_user.sync',
        entity_type: 'platform_user',
        entity_id: updated.id,
        request_id,
        old_values: {
          email: existing.email,
          name: existing.display_name,
          photo_url: existing.photo_url,
        },
        new_values: {
          email: updated.email,
          name: updated.display_name,
          photo_url: updated.photo_url,
        },
      });
      return { user: updated, balance, created: false };
    });

    return serializeUserResponse(result.user, result.balance, result.created);
  }

  const result = await prisma.$transaction(async (tx) => {
    const created = await tx.platformUser.create({
      data: {
        platform_app_id: platform_app.id,
        external_user_id,
        email,
        display_name,
        photo_url,
        status: PlatformUserStatus.active,
      },
      select: platformUserSelect,
    });
    const balance = await getWalletBalance(created.id, tx);
    await writePlatformAudit(tx, platform_app.id, {
      action: 'platform_user.sync',
      entity_type: 'platform_user',
      entity_id: created.id,
      request_id,
      new_values: {
        external_user_id,
        email,
        name: display_name,
        photo_url,
        balance: balance.toString(),
      },
    });
    return { user: created, balance, created: true };
  });

  return serializeUserResponse(result.user, result.balance, result.created);
};

const getPlatformUserCoins = async (
  credentials: AppCredentials,
  external_user_id: string,
) => {
  const platform_app = await resolveActivePlatformApp(credentials);
  const user = await findPlatformUserOrThrow(platform_app, external_user_id.trim());
  const balance = await getWalletBalance(user.id);
  return {
    external_user_id: user.external_user_id,
    balance: balance.toString(),
    currency: DEFAULT_CURRENCY_CODE,
  };
};

const creditPlatformUserCoins = async (
  body: CreditPlatformUserCoinsBody,
  request_id?: string,
) => {
  const platform_app = await resolveActivePlatformApp(body);
  const external_user_id = body.external_user_id.trim();
  const amount = BigInt(body.amount);
  const client_request_id = body.client_request_id.trim();

  const user = await findPlatformUserOrThrow(platform_app, external_user_id);
  if (user.status !== PlatformUserStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform user is disabled');
  }

  const existing_deposit = await prisma.platformCoinDeposit.findUnique({
    where: {
      platform_app_id_client_request_id: {
        platform_app_id: platform_app.id,
        client_request_id,
      },
    },
    include: {
      wallet_ledger: {
        select: {
          balance_after: true,
        },
      },
    },
  });

  if (existing_deposit) {
    if (existing_deposit.external_user_id !== external_user_id) {
      throw new AppError(httpStatus.CONFLICT, 'client_request_id belongs to another user');
    }
    return {
      external_user_id,
      received_amount: existing_deposit.received_amount.toString(),
      converted_amount: existing_deposit.converted_amount.toString(),
      balance: existing_deposit.wallet_ledger.balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: true,
    };
  }

  return prisma.$transaction(async (tx) => {
    const { ledger, balance_after } = await creditPlatformPurchase(tx, {
      user_id: user.id,
      amount,
      reference_type: 'platform_coin_deposit',
      reference_id: client_request_id,
      metadata: {
        platform_app_id: platform_app.id,
        external_user_id,
        client_request_id,
        received_amount: amount.toString(),
        converted_amount: amount.toString(),
      },
    });

    const deposit = await tx.platformCoinDeposit.create({
      data: {
        platform_app_id: platform_app.id,
        platform_user_id: user.id,
        external_user_id,
        client_request_id,
        received_amount: amount,
        converted_amount: amount,
        wallet_ledger_id: ledger.id,
      },
    });

    await writePlatformAudit(tx, platform_app.id, {
      action: 'platform_user.coin_credit',
      entity_type: 'platform_coin_deposit',
      entity_id: deposit.id,
      request_id,
      new_values: {
        external_user_id,
        received_amount: amount.toString(),
        converted_amount: amount.toString(),
        balance: balance_after.toString(),
        client_request_id,
      },
    });

    return {
      external_user_id,
      received_amount: amount.toString(),
      converted_amount: amount.toString(),
      balance: balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

const withdrawPlatformUserCoins = async (
  body: WithdrawPlatformUserCoinsBody,
  request_id?: string,
) => {
  const platform_app = await resolveActivePlatformApp(body);
  const external_user_id = body.external_user_id.trim();
  const amount = BigInt(body.amount);
  const client_request_id = body.client_request_id.trim();

  const user = await findPlatformUserOrThrow(platform_app, external_user_id);
  if (user.status !== PlatformUserStatus.active) {
    throw new AppError(httpStatus.FORBIDDEN, 'Platform user is disabled');
  }

  const existing_withdrawal = await prisma.platformCoinWithdrawal.findUnique({
    where: {
      platform_app_id_client_request_id: {
        platform_app_id: platform_app.id,
        client_request_id,
      },
    },
    include: {
      wallet_ledger: {
        select: {
          balance_after: true,
        },
      },
    },
  });

  if (existing_withdrawal) {
    if (existing_withdrawal.external_user_id !== external_user_id) {
      throw new AppError(httpStatus.CONFLICT, 'client_request_id belongs to another user');
    }
    return {
      external_user_id,
      requested_amount: existing_withdrawal.requested_amount.toString(),
      transferred_amount: existing_withdrawal.transferred_amount.toString(),
      balance: existing_withdrawal.wallet_ledger.balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: true,
    };
  }

  const current_balance = await getWalletBalance(user.id);
  if (current_balance < amount) {
    throw new AppError(httpStatus.BAD_REQUEST, 'Insufficient wallet balance for withdrawal', {
      balance: [current_balance.toString()],
      requested_amount: [amount.toString()],
      shortfall: [(amount - current_balance).toString()],
      currency: [DEFAULT_CURRENCY_CODE],
    });
  }

  return prisma.$transaction(async (tx) => {
    const { ledger, balance_after } = await debitPlatformWithdrawal(tx, {
      user_id: user.id,
      amount,
      reference_type: 'platform_coin_withdrawal',
      reference_id: client_request_id,
      metadata: {
        platform_app_id: platform_app.id,
        external_user_id,
        client_request_id,
        requested_amount: amount.toString(),
        transferred_amount: amount.toString(),
      },
    });

    const withdrawal = await tx.platformCoinWithdrawal.create({
      data: {
        platform_app_id: platform_app.id,
        platform_user_id: user.id,
        external_user_id,
        client_request_id,
        requested_amount: amount,
        transferred_amount: amount,
        wallet_ledger_id: ledger.id,
      },
    });

    await writePlatformAudit(tx, platform_app.id, {
      action: 'platform_user.coin_withdraw',
      entity_type: 'platform_coin_withdrawal',
      entity_id: withdrawal.id,
      request_id,
      new_values: {
        external_user_id,
        requested_amount: amount.toString(),
        transferred_amount: amount.toString(),
        balance: balance_after.toString(),
        client_request_id,
      },
    });

    return {
      external_user_id,
      requested_amount: amount.toString(),
      transferred_amount: amount.toString(),
      balance: balance_after.toString(),
      currency: DEFAULT_CURRENCY_CODE,
      idempotent: false,
    };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
};

const PlatformIntegrationService = {
  syncPlatformUser,
  getPlatformUserCoins,
  creditPlatformUserCoins,
  withdrawPlatformUserCoins,
};

export default PlatformIntegrationService;
