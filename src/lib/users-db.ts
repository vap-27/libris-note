import { PrismaClient as UsersPrismaClient } from '@/generated/users-client'

/**
 * Users store: third TiDB cluster (`users_db`) — claimed display names
 * (+ PIN hashes), presence heartbeats, advisory page edit leases.
 * Replaces the old Turso-backed UsrInfo database (fully decommissioned).
 */

const globalForUsers = globalThis as unknown as {
  dbUsers?: UsersPrismaClient
}

export const dbUsers =
  globalForUsers.dbUsers ??
  new UsersPrismaClient({
    log: process.env.NODE_ENV === 'production' ? ['error'] : ['error', 'warn'],
  })

// Cached in every env (same rationale as src/lib/db.ts): avoids a fresh
// pool per worker/module-eval in bundled runtimes.
globalForUsers.dbUsers = dbUsers
