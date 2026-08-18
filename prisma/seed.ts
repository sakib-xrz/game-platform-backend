import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import {
  ConfigVersionStatus,
  GameStatus,
  GreedyRuntimeStatus,
  PrismaClient,
} from '../src/generated/prisma/client';

const database_url = process.env.DATABASE_URL;

if (!database_url) {
  throw new Error('DATABASE_URL is required');
}

const adapter = new PrismaPg({ connectionString: database_url });
const prisma = new PrismaClient({ adapter });

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

  let greedy_config = await prisma.greedyConfigVersion.findFirst({
    where: { game_id: game.id, version: 1 },
    include: { options: true },
  });

  if (!greedy_config) {
    greedy_config = await prisma.greedyConfigVersion.create({
      data: {
        game_id: game.id,
        version: 1,
        status: ConfigVersionStatus.published,
        betting_duration_ms: 15000,
        lock_duration_ms: 1000,
        drawing_duration_ms: 4000,
        result_duration_ms: 3000,
        min_bet: 10n,
        max_single_bet: 10000n,
        max_round_bet: 50000n,
        notes:
          'Technical baseline. Replace names/images/economy before public launch.',
        published_at: new Date(),
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
  }

  await prisma.greedyRuntimeState.upsert({
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

  console.log({
    seeded: true,
    currency: currency.code,
    game: game.code,
    config_version: greedy_config.version,
    runtime_status: 'stopped',
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
