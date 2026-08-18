import { PrismaPg } from '@prisma/adapter-pg';
import config from '@/config';
import { PrismaClient } from '@/generated/prisma/client';

if (!config.database_url) {
  throw new Error('DATABASE_URL is required');
}

const global_for_prisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

const create_prisma_client = (): PrismaClient => {
  const adapter = new PrismaPg({ connectionString: config.database_url });
  return new PrismaClient({ adapter });
};

const prisma = global_for_prisma.prisma ?? create_prisma_client();

if (config.node_env !== 'production') {
  global_for_prisma.prisma = prisma;
}

export default prisma;
