/**
 * CLI tool for CockroachDB backup and recovery
 * Usage:
 *   npx tsx scripts/turso-backup.ts status
 *   npx tsx scripts/turso-backup.ts backup
 *   npx tsx scripts/turso-backup.ts restore
 *   npx tsx scripts/turso-backup.ts init
 * (Script name is historical; every command below hits CockroachDB.)
 */
import {
  initTursoTables,
  backupAllToTurso,
  restoreAllFromTurso,
  getTursoBackupStats,
  isTursoConfigured,
} from '../src/lib/turso'

async function main() {
  const cmd = process.argv[2] || 'status'

  if (!isTursoConfigured()) {
    console.error('❌ BACKUP_DATABASE_URL is missing in .env')
    process.exit(1)
  }

  console.log(`\n── Libris CockroachDB Backup Tool [${cmd}] ──`)

  switch (cmd) {
    case 'init': {
      console.log('Backup schema is managed by prisma db push (see npm run db:push:backup) — nothing to init.')
      await initTursoTables()
      console.log('✅ Backup engine reachable.')
      break
    }

    case 'backup': {
      console.log('Running snapshot backup from TiDB -> CockroachDB...')
      const res = await backupAllToTurso()
      console.log('✅ Backup complete!')
      console.log('   Books backed up:', res.stats.books)
      console.log('   Pages backed up:', res.stats.pages)
      console.log('   Page notes backed up:', res.stats.pageNotes)
      console.log('   Board notes backed up:', res.stats.boardNotes)
      console.log('   Timestamp:', res.stats.timestamp)
      break
    }

    case 'restore': {
      console.log('Restoring data from CockroachDB -> TiDB...')
      const res = await restoreAllFromTurso()
      console.log('✅ Restore complete!')
      console.log('   Books restored:', res.restored.books)
      console.log('   Pages restored:', res.restored.pages)
      console.log('   Page notes restored:', res.restored.pageNotes)
      console.log('   Board notes restored:', res.restored.boardNotes)
      break
    }

    case 'status':
    default: {
      const stats = await getTursoBackupStats()
      console.log('📊 CockroachDB Backup Status:')
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
  console.error('❌ Error executing backup command:', err)
  process.exit(1)
})
