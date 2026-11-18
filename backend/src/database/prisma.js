// Reusable Prisma client (process-wide singleton).
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Verify database connectivity by executing a trivial query.
 * Throws Prisma's connection error when the database is unreachable.
 */
export async function verifyConnection() {
  await prisma.$queryRaw`SELECT 1`;
  return true;
}

export default prisma;
