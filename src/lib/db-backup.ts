import { PrismaClient as BackupPrismaClient } from '@/generated/backup-client'

/**
 * Backup engine cluster: CockroachDB — snapshots, restore source, shift
 * overflow writes, replication mirror, activity logs. Replaces the old
 * Turso backup database in all of those roles.
 */

const globalForBackup = globalThis as unknown as {
  dbBackup?: BackupPrismaClient
}

export const dbBackup =
  globalForBackup.dbBackup ??
  new BackupPrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

// Cached in every env (same rationale as src/lib/db.ts): avoids a fresh
// pool per worker/module-eval in bundled runtimes.
globalForBackup.dbBackup = dbBackup
