import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  AdminRole,
  AdminStatus,
  ConfigVersionStatus,
  GameStatus,
  GreedyRuntimeStatus,
  GreedyClassicRuntimeStatus,
  Lucky77RuntimeStatus,
  Prisma,
  PrismaClient,
  TeenPattiRuntimeStatus,
  WalletLedgerType,
} from '../src/generated/prisma/client';
import { hashAdminPassword, normalizeAdminEmail } from '../src/modules/admin/admin.crypto';

const database_url = process.env.DATABASE_URL;

if (!database_url) {
  throw new Error('DATABASE_URL is required');
}

const adapter = new PrismaPg({ connectionString: database_url });
const prisma = new PrismaClient({ adapter });

const greedy_food_options = [
  {
    code: 'HOT_DOG',
    name: 'Hot dog',
    image_url: '/assets/greedy/hot-dog.png',
    display_order: 1,
    payout_numerator: 10n,
    payout_denominator: 1n,
    probability_weight: 45n,
  },
  {
    code: 'KEBAB',
    name: 'Barbecue kebab',
    image_url: '/assets/greedy/kebab.png',
    display_order: 2,
    payout_numerator: 15n,
    payout_denominator: 1n,
    probability_weight: 30n,
  },
  {
    code: 'HAM',
    name: 'Ham',
    image_url: '/assets/greedy/ham.png',
    display_order: 3,
    payout_numerator: 25n,
    payout_denominator: 1n,
    probability_weight: 18n,
  },
  {
    code: 'STEAK',
    name: 'Grilled steak',
    image_url: '/assets/greedy/steak.png',
    display_order: 4,
    payout_numerator: 45n,
    payout_denominator: 1n,
    probability_weight: 10n,
  },
  {
    code: 'CARROT',
    name: 'Carrot',
    image_url: '/assets/greedy/carrot.png',
    display_order: 5,
    payout_numerator: 5n,
    payout_denominator: 1n,
    probability_weight: 90n,
  },
  {
    code: 'CORN',
    name: 'Corn',
    image_url: '/assets/greedy/corn.png',
    display_order: 6,
    payout_numerator: 5n,
    payout_denominator: 1n,
    probability_weight: 90n,
  },
  {
    code: 'CABBAGE',
    name: 'Cabbage',
    image_url: '/assets/greedy/cabbage.png',
    display_order: 7,
    payout_numerator: 5n,
    payout_denominator: 1n,
    probability_weight: 90n,
  },
  {
    code: 'TOMATO',
    name: 'Tomato',
    image_url: '/assets/greedy/tomato.png',
    display_order: 8,
    payout_numerator: 5n,
    payout_denominator: 1n,
    probability_weight: 90n,
  },
];

const main = async (): Promise<void> => {
  const currency = await prisma.currency.upsert({
    where: { code: 'COIN' },
    create: { code: 'COIN', name: 'Coin', symbol: '●' },
    update: { is_active: true },
  });

  const game = await prisma.game.upsert({
    where: { code: 'GREEDY' },
    create: { code: 'GREEDY', name: 'Greedy', status: GameStatus.active },
    update: {},
  });

  const greedy_config = await prisma.$transaction(async (tx) => {
    const greedy_configs = await tx.greedyConfigVersion.findMany({
      where: { game_id: game.id },
      orderBy: { version: 'desc' },
      include: { options: true, chip_values: true },
    });
    const published_greedy_config = greedy_configs.find(
      (config) => config.status === ConfigVersionStatus.published,
    );
    const existing_food_config = greedy_configs.find(
      (config) =>
        config.options.length === greedy_food_options.length &&
        greedy_food_options.every((seeded_option) => {
          const current_option = config.options.find(
            (option) => option.display_order === seeded_option.display_order,
          );
          return (
            current_option?.code === seeded_option.code &&
            current_option.name === seeded_option.name &&
            current_option.image_url === seeded_option.image_url &&
            current_option.payout_numerator === seeded_option.payout_numerator &&
            current_option.payout_denominator === seeded_option.payout_denominator &&
            current_option.probability_weight === seeded_option.probability_weight &&
            current_option.is_enabled
          );
        }),
    );

    // Once this seed has been applied, preserve any newer operator-published config.
    if (existing_food_config) {
      await tx.greedyRuntimeState.upsert({
        where: { game_id: game.id },
        create: {
          game_id: game.id,
          active_config_version_id: published_greedy_config?.id ?? null,
          status: GreedyRuntimeStatus.stopped,
        },
        update: {},
      });
      return existing_food_config;
    }

    // Change only the wheel content when upgrading an existing installation.
    const baseline_config = published_greedy_config ?? greedy_configs[0];
    const chip_values = baseline_config?.chip_values.length
      ? baseline_config.chip_values.map((chip) => ({
          amount: chip.amount,
          display_order: chip.display_order,
          is_enabled: chip.is_enabled,
        }))
      : [
          { amount: 10n, display_order: 1, is_enabled: true },
          { amount: 50n, display_order: 2, is_enabled: true },
          { amount: 100n, display_order: 3, is_enabled: true },
          { amount: 500n, display_order: 4, is_enabled: true },
          { amount: 1000n, display_order: 5, is_enabled: true },
          { amount: 5000n, display_order: 6, is_enabled: true },
        ];
    let greedy_config = await tx.greedyConfigVersion.create({
      data: {
        game_id: game.id,
        version: (greedy_configs[0]?.version ?? 0) + 1,
        status: ConfigVersionStatus.draft,
        betting_duration_ms: baseline_config?.betting_duration_ms ?? 15000,
        lock_duration_ms: baseline_config?.lock_duration_ms ?? 1000,
        drawing_duration_ms: baseline_config?.drawing_duration_ms ?? 4000,
        result_duration_ms: baseline_config?.result_duration_ms ?? 3000,
        min_bet: baseline_config?.min_bet ?? 10n,
        max_single_bet: baseline_config?.max_single_bet ?? 10000n,
        max_round_bet: baseline_config?.max_round_bet ?? 50000n,
        notes:
          'Greedy food wheel baseline. Screenshot order with equalized 97.19% theoretical return per option.',
        chip_values: { create: chip_values },
        options: { create: greedy_food_options },
      },
    });

    greedy_config = await tx.greedyConfigVersion.update({
      where: { id: greedy_config.id },
      data: { status: ConfigVersionStatus.review_pending },
    });

    const published_at = new Date();
    await tx.greedyConfigVersion.updateMany({
      where: {
        game_id: game.id,
        status: ConfigVersionStatus.published,
        id: { not: greedy_config.id },
      },
      data: {
        status: ConfigVersionStatus.retired,
        retired_at: published_at,
      },
    });
    greedy_config = await tx.greedyConfigVersion.update({
      where: { id: greedy_config.id },
      data: {
        status: ConfigVersionStatus.published,
        published_at,
      },
    });

    await tx.greedyRuntimeState.upsert({
      where: { game_id: game.id },
      create: {
        game_id: game.id,
        active_config_version_id: greedy_config.id,
        status: GreedyRuntimeStatus.stopped,
      },
      update: {
        active_config_version_id: greedy_config.id,
      },
    });
    return greedy_config;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  });

  const greedy_classic_game = await prisma.game.upsert({
    where: { code: 'GREEDY_CLASSIC' },
    create: { code: 'GREEDY_CLASSIC', name: 'Greedy Classic', status: GameStatus.active },
    update: {},
  });

  let greedy_classic_config = await prisma.greedyClassicConfigVersion.findFirst({
    where: { game_id: greedy_classic_game.id, version: 1 },
    include: { options: true },
  });

  if (!greedy_classic_config) {
    greedy_classic_config = await prisma.greedyClassicConfigVersion.create({
      data: {
        game_id: greedy_classic_game.id,
        version: 1,
        status: ConfigVersionStatus.draft,
        betting_duration_ms: 15000,
        lock_duration_ms: 1000,
        drawing_duration_ms: 4000,
        result_duration_ms: 3000,
        min_bet: 10n,
        max_single_bet: 10000n,
        max_round_bet: 50000n,
        notes:
          'Technical baseline. Replace names/images/economy before public launch.',
        chip_values: {
          create: [
            { amount: 10n, display_order: 1 },
            { amount: 50n, display_order: 2 },
            { amount: 100n, display_order: 3 },
            { amount: 500n, display_order: 4 },
            { amount: 1000n, display_order: 5 },
            { amount: 5000n, display_order: 6 },
          ],
        },
        options: {
          create: [
            {
              code: 'FALCON',
              name: 'Falcon',
              display_order: 1,
              payout_numerator: 4n,
              payout_denominator: 1n,
              probability_weight: 210n,
            },
            {
              code: 'TIGER',
              name: 'Tiger',
              display_order: 2,
              payout_numerator: 5n,
              payout_denominator: 1n,
              probability_weight: 168n,
            },
            {
              code: 'PANDA',
              name: 'Panda',
              display_order: 3,
              payout_numerator: 6n,
              payout_denominator: 1n,
              probability_weight: 140n,
            },
            {
              code: 'LION',
              name: 'Lion',
              display_order: 4,
              payout_numerator: 7n,
              payout_denominator: 1n,
              probability_weight: 120n,
            },
            {
              code: 'SHARK',
              name: 'Shark',
              display_order: 5,
              payout_numerator: 8n,
              payout_denominator: 1n,
              probability_weight: 105n,
            },
            {
              code: 'DRAGON',
              name: 'Dragon',
              display_order: 6,
              payout_numerator: 10n,
              payout_denominator: 1n,
              probability_weight: 84n,
            },
            {
              code: 'CROWN',
              name: 'Crown',
              display_order: 7,
              payout_numerator: 15n,
              payout_denominator: 1n,
              probability_weight: 56n,
            },
            {
              code: 'DIAMOND',
              name: 'Diamond',
              display_order: 8,
              payout_numerator: 20n,
              payout_denominator: 1n,
              probability_weight: 42n,
            },
          ],
        },
      },
      include: { options: true },
    });

    greedy_classic_config = await prisma.greedyClassicConfigVersion.update({
      where: { id: greedy_classic_config.id },
      data: { status: ConfigVersionStatus.review_pending },
      include: { options: true },
    });
    greedy_classic_config = await prisma.greedyClassicConfigVersion.update({
      where: { id: greedy_classic_config.id },
      data: {
        status: ConfigVersionStatus.published,
        published_at: new Date(),
      },
      include: { options: true },
    });
  }

  await prisma.greedyClassicRuntimeState.upsert({
    where: { game_id: greedy_classic_game.id },
    create: {
      game_id: greedy_classic_game.id,
      active_config_version_id: greedy_classic_config.id,
      status: GreedyClassicRuntimeStatus.stopped,
    },
    update: {
      active_config_version_id: greedy_classic_config.id,
    },
  });

  const teen_patti_game = await prisma.game.upsert({
    where: { code: 'TEEN_PATTI' },
    create: { code: 'TEEN_PATTI', name: 'Teen Patti', status: GameStatus.active },
    update: {},
  });

  let teen_patti_config = await prisma.teenPattiConfigVersion.findFirst({
    where: { game_id: teen_patti_game.id, version: 1 },
    include: { options: true },
  });

  if (!teen_patti_config) {
    teen_patti_config = await prisma.teenPattiConfigVersion.create({
      data: {
        game_id: teen_patti_game.id,
        version: 1,
        status: ConfigVersionStatus.draft,
        betting_duration_ms: 15000,
        lock_duration_ms: 1500,
        drawing_duration_ms: 5500,
        result_duration_ms: 5000,
        min_bet: 10n,
        max_single_bet: 10000n,
        max_round_bet: 50000n,
        rake_bps: 500,
        notes:
          'Technical baseline. Three decks, highest Teen Patti hand wins the pot minus rake.',
        chip_values: {
          create: [
            { amount: 10n, display_order: 1 },
            { amount: 50n, display_order: 2 },
            { amount: 100n, display_order: 3 },
            { amount: 500n, display_order: 4 },
            { amount: 1000n, display_order: 5 },
            { amount: 5000n, display_order: 6 },
          ],
        },
        options: {
          create: [
            { code: 'DECK_A', name: 'Hand 1', display_order: 1 },
            { code: 'DECK_B', name: 'Hand 2', display_order: 2 },
            { code: 'DECK_C', name: 'Hand 3', display_order: 3 },
          ],
        },
      },
      include: { options: true },
    });

    teen_patti_config = await prisma.teenPattiConfigVersion.update({
      where: { id: teen_patti_config.id },
      data: { status: ConfigVersionStatus.review_pending },
      include: { options: true },
    });
    teen_patti_config = await prisma.teenPattiConfigVersion.update({
      where: { id: teen_patti_config.id },
      data: {
        status: ConfigVersionStatus.published,
        published_at: new Date(),
      },
      include: { options: true },
    });
  } else {
    teen_patti_config = await prisma.teenPattiConfigVersion.update({
      where: { id: teen_patti_config.id },
      data: {
        lock_duration_ms: 1500,
        drawing_duration_ms: 5500,
        result_duration_ms: 5000,
      },
      include: { options: true },
    });
  }

  await prisma.teenPattiRuntimeState.upsert({
    where: { game_id: teen_patti_game.id },
    create: {
      game_id: teen_patti_game.id,
      active_config_version_id: teen_patti_config.id,
      status: TeenPattiRuntimeStatus.stopped,
    },
    update: {
      active_config_version_id: teen_patti_config.id,
    },
  });

  const lucky_77_game = await prisma.game.upsert({
    where: { code: 'LUCKY_77' },
    create: { code: 'LUCKY_77', name: 'Lucky 77', status: GameStatus.active },
    update: {},
  });

  let lucky_77_config = await prisma.lucky77ConfigVersion.findFirst({
    where: { game_id: lucky_77_game.id, version: 1 },
    include: { options: true },
  });

  if (!lucky_77_config) {
    lucky_77_config = await prisma.lucky77ConfigVersion.create({
      data: {
        game_id: lucky_77_game.id,
        version: 1,
        status: ConfigVersionStatus.draft,
        betting_duration_ms: 15000,
        lock_duration_ms: 1000,
        drawing_duration_ms: 4000,
        result_duration_ms: 3000,
        min_bet: 10n,
        max_single_bet: 10000n,
        max_round_bet: 50000n,
        notes:
          'Technical baseline. Apple / Watermelon / 77 fixed-multiplier wheel with weighted slots.',
        chip_values: {
          create: [
            { amount: 10n, display_order: 1 },
            { amount: 50n, display_order: 2 },
            { amount: 100n, display_order: 3 },
            { amount: 500n, display_order: 4 },
            { amount: 1000n, display_order: 5 },
            { amount: 5000n, display_order: 6 },
          ],
        },
        options: {
          create: [
            {
              code: 'APPLE',
              name: 'Apple',
              display_order: 1,
              payout_numerator: 2n,
              payout_denominator: 1n,
              probability_weight: 4n,
            },
            {
              code: 'WATERMELON',
              name: 'Watermelon',
              display_order: 2,
              payout_numerator: 2n,
              payout_denominator: 1n,
              probability_weight: 4n,
            },
            {
              code: 'SEVENTY_SEVEN',
              name: '77',
              display_order: 3,
              payout_numerator: 8n,
              payout_denominator: 1n,
              probability_weight: 1n,
            },
          ],
        },
      },
      include: { options: true },
    });

    lucky_77_config = await prisma.lucky77ConfigVersion.update({
      where: { id: lucky_77_config.id },
      data: { status: ConfigVersionStatus.review_pending },
      include: { options: true },
    });
    lucky_77_config = await prisma.lucky77ConfigVersion.update({
      where: { id: lucky_77_config.id },
      data: {
        status: ConfigVersionStatus.published,
        published_at: new Date(),
      },
      include: { options: true },
    });
  }

  await prisma.lucky77RuntimeState.upsert({
    where: { game_id: lucky_77_game.id },
    create: {
      game_id: lucky_77_game.id,
      active_config_version_id: lucky_77_config.id,
      status: Lucky77RuntimeStatus.stopped,
    },
    update: {
      active_config_version_id: lucky_77_config.id,
    },
  });

  const admin_email = normalizeAdminEmail(
    process.env.ADMIN_SEED_EMAIL || 'admin@example.com',
  );
  const admin_password = process.env.ADMIN_SEED_PASSWORD || 'AdminPassword123';
  if (admin_password.length < 12 || admin_password.length > 128) {
    throw new Error('ADMIN_SEED_PASSWORD must be between 12 and 128 characters');
  }

  const password_hash = await hashAdminPassword(admin_password);
  const admin = await prisma.adminUser.upsert({
    where: { email: admin_email },
    create: {
      email: admin_email,
      display_name: 'Platform Admin',
      role: AdminRole.super_admin,
      status: AdminStatus.active,
      password_hash,
      force_password_change: false,
      failed_login_count: 0,
      locked_until: null,
      password_changed_at: new Date(),
    },
    update: {
      display_name: 'Platform Admin',
      role: AdminRole.super_admin,
      status: AdminStatus.active,
      password_hash,
      force_password_change: false,
      failed_login_count: 0,
      locked_until: null,
      password_changed_at: new Date(),
    },
    select: { id: true, email: true, role: true },
  });

  await prisma.adminSession.updateMany({
    where: { admin_user_id: admin.id, revoked_at: null },
    data: { revoked_at: new Date() },
  });
  await prisma.adminPolicy.upsert({
    where: { code: 'default' },
    create: {},
    update: {},
  });

  const default_users = ['user-001', 'user-002', 'user-003', 'user-004', 'user-005'];
  const seeded_initial_balance = 10000n;

  for (const user_id of default_users) {
    const existing_wallet = await prisma.wallet.findUnique({
      where: {
        user_id_currency_id: {
          user_id,
          currency_id: currency.id,
        },
      },
    });

    if (!existing_wallet) {
      const wallet = await prisma.wallet.create({
        data: {
          user_id,
          currency_id: currency.id,
          balance: seeded_initial_balance,
          version: 0,
        },
      });

      await prisma.walletLedger.create({
        data: {
          wallet_id: wallet.id,
          user_id,
          type: WalletLedgerType.admin_credit,
          amount: seeded_initial_balance,
          balance_before: 0n,
          balance_after: seeded_initial_balance,
          reference_type: 'initial_seed',
          metadata: { reason: 'Initial dev seed balance' },
        },
      });
    } else if (existing_wallet.balance !== seeded_initial_balance) {
      const balance_difference = seeded_initial_balance - existing_wallet.balance;
      const updated_wallet = await prisma.wallet.update({
        where: { id: existing_wallet.id },
        data: {
          balance: seeded_initial_balance,
          version: { increment: 1 },
        },
      });

      await prisma.walletLedger.create({
        data: {
          wallet_id: updated_wallet.id,
          user_id,
          type: balance_difference > 0n ? WalletLedgerType.admin_credit : WalletLedgerType.admin_debit,
          amount: balance_difference,
          balance_before: existing_wallet.balance,
          balance_after: seeded_initial_balance,
          reference_type: 'initial_seed',
          metadata: { reason: 'Reset dev seed balance to 10000' },
        },
      });
    }
  }

  console.log({
    seeded: true,
    currency: currency.code,
    users: default_users,
    user_initial_balance: seeded_initial_balance.toString(),
    game: game.code,
    teen_patti_game: teen_patti_game.code,
    lucky_77_game: lucky_77_game.code,
    greedy_classic_game: greedy_classic_game.code,
    config_version: greedy_config.version,
    teen_patti_config_version: teen_patti_config.version,
    lucky_77_config_version: lucky_77_config.version,
    greedy_classic_config_version: greedy_classic_config.version,
    runtime_status: 'stopped',
    admin: admin.email,
  });
};

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
