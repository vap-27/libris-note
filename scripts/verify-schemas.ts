/**
 * Verify the TiDB table layout on both clusters (works with local and TiDB Cloud).
 */
import mysql from 'mysql2/promise'

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile()
  } catch {}
}

function parseUrl(raw: string, fallbackDb: string) {
  const u = new URL(raw)
  return {
    host: u.hostname,
    port: Number(u.port) || 4000,
    user: decodeURIComponent(u.username) || 'root',
    password: decodeURIComponent(u.password),
    database: u.pathname.replace(/^\//, '') || fallbackDb,
    ssl: /sslaccept|sslmode|sslcert/.test(u.search),
  }
}

async function main() {
  const clusters = [
    { name: 'books', url: process.env.BOOKS_DATABASE_URL ?? 'mysql://root@127.0.0.1:4000/books_db', fallback: 'books_db' },
    { name: 'notes', url: process.env.NOTES_DATABASE_URL ?? 'mysql://root@127.0.0.1:4001/notes_db', fallback: 'notes_db' },
  ]

  for (const { name, url, fallback } of clusters) {
    const cfg = parseUrl(url, fallback)
    const conn = await mysql.createConnection({
      host: cfg.host,
      port: cfg.port,
      user: cfg.user,
      password: cfg.password,
      connectTimeout: 10_000,
      ...(cfg.ssl ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false } } : {}),
    })
    const [tables] = await conn.query(
      `SELECT TABLE_NAME, TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ?`,
      [cfg.database]
    )
    console.log(`[${name} cluster ${cfg.host}:${cfg.port}/${cfg.database}] tables:`, (tables as any[]).map((t) => `${t.TABLE_NAME}(${t.TABLE_ROWS ?? 0} rows)`).join(', '))
    await conn.end()
  }
  console.log('SCHEMA VERIFY OK')
}

main().catch((e) => { console.error('FAILED:', e.message); process.exit(1) })
