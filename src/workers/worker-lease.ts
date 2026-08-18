import { Prisma } from '@/generated/prisma/client';
import prisma from '@/lib/prisma';

const LEASE_SECONDS = 5;

export const acquireOrRenewLease = async (
  lease_key: string,
  owner_id: string,
): Promise<boolean> => {
  // Ensure the row exists. The actual lease decision below is a single atomic
  // PostgreSQL UPDATE and uses the database clock, not an application clock.
  await prisma.workerLease.upsert({
    where: { lease_key },
    create: {
      lease_key,
      owner_id,
      lease_until: new Date(0),
      heartbeat_at: new Date(0),
    },
    update: {},
  });

  const rows = await prisma.$queryRaw<Array<{ owner_id: string }>>(Prisma.sql`
    UPDATE worker_leases
    SET
      owner_id = ${owner_id},
      fencing_token = fencing_token + 1,
      heartbeat_at = CURRENT_TIMESTAMP,
      lease_until = CURRENT_TIMESTAMP + (${LEASE_SECONDS} * INTERVAL '1 second'),
      updated_at = CURRENT_TIMESTAMP
    WHERE lease_key = ${lease_key}
      AND (owner_id = ${owner_id} OR lease_until <= CURRENT_TIMESTAMP)
    RETURNING owner_id
  `);

  return rows.length === 1 && rows[0]?.owner_id === owner_id;
};

export const releaseLease = async (
  lease_key: string,
  owner_id: string,
): Promise<void> => {
  await prisma.$executeRaw(Prisma.sql`
    UPDATE worker_leases
    SET
      lease_until = CURRENT_TIMESTAMP,
      heartbeat_at = CURRENT_TIMESTAMP,
      updated_at = CURRENT_TIMESTAMP
    WHERE lease_key = ${lease_key}
      AND owner_id = ${owner_id}
  `);
};
