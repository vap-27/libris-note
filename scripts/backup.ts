/**
 * CLI tool for CockroachDB backup and recovery
 * Usage:
 *   npx tsx scripts/backup.ts status
 *   npx tsx scripts/backup.ts backup
 *   npx tsx scripts/backup.ts restore
 *   npx tsx scripts/backup.ts init
 */
import {
  initBackupTables,
  snapshotToBackup,
  restoreFromBackup,
  getBackupStats,
  isBackupConfigured,
} from '../src/lib/backup-engine'

async function main() {
  const cmd = process.argv[2] || 'status'

  if (!isBackupConfigured()) {
    console.error('âŒ BACKUP_DATABASE_URL is missing in .env')
    process.exit(1)
  }

  console.log(`\nâ”€â”€ Libris CockroachDB Backup Tool [${cmd}] â”€â”€`)

  switch (cmd) {
    case 'init': {
      console.log('Backup schema is managed by prisma db push (see npm run db:push:backup) â€” nothing to init.')
      await initBackupTables()
      console.log('âœ… Backup engine reachable.')
      break
    }

    case 'backup': {
      console.log('Running snapshot backup from TiDB -> CockroachDB...')
      const res = await snapshotToBackup()
      console.log('âœ… Backup complete!')
      console.log('   Books backed up:', res.stats.books)
      console.log('   Pages backed up:', res.stats.pages)
      console.log('   Page notes backed up:', res.stats.pageNotes)
      console.log('   Board notes backed up:', res.stats.boardNotes)
      console.log('   Timestamp:', res.stats.timestamp)
      break
    }

    case 'restore': {
      console.log('Restoring data from CockroachDB -> TiDB...')
      const res = await restoreFromBackup()
      console.log('âœ… Restore complete!')
      console.log('   Books restored:', res.restored.books)
      console.log('   Pages restored:', res.restored.pages)
      console.log('   Page notes restored:', res.restored.pageNotes)
      console.log('   Board notes restored:', res.restored.boardNotes)
      break
    }

    case 'status':
    default: {
      const stats = await getBackupStats()
      console.log('ðŸ“Š CockroachDB Backup Status:')
      console.log('   Configured:', stats.configured)
      console.log('   Books in backup:', stats.booksCount)
      console.log('   Pages in backup:', stats.pagesCount)
      console.log('   Page Notes in backup:', stats.pageNotesCount)
      console.log('   Board Notes in backup:', stats.boardNotesCount)
      console.log('   Last Backup At:', stats.lastBackupAt || 'None')
      console.log('   Database URL:', stats.databaseUrl)
      break
    }
  }
}

main().catch((err) => {
  console.error('âŒ Error executing backup command:', err)
  process.exit(1)
})
