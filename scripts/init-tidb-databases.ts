/**
 * Initialize the databases on the two TiDB clusters, reading the connection
 * details straight from .env (BOOKS_DATABASE_URL / NOTES_DATABASE_URL):
 *   - Cluster A (books): database `books_db`
 *   - Cluster B (notes): database `notes_db`
 * Also verifies connectivity to both clusters. Works with local tiup
 * clusters and TiDB Cloud (TLS auto-enabled when the URL asks for it).
 *
 *   npm run db:init
 */
import mysql from 'mysql2/promise'

if (typeof process.loadEnvFile === 'function') {
  try {
    process.loadEnvFile()
  } catch {}
}

interface ParsedUrl {
  host: string
  port: number
  user: string
  password: string
  database: string
  ssl: boolean
}

function parseUrl(raw: string, fallbackDb: string): ParsedUrl {
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

const BOOKS_URL = process.env.BOOKS_DATABASE_URL ?? 'mysql://root@127.0.0.1:4000/books_db'
const NOTES_URL = process.env.NOTES_DATABASE_URL ?? 'mysql://root@127.0.0.1:4001/notes_db'

async function initCluster(label: string, raw: string, fallbackDb: string) {
  const cfg = parseUrl(raw, fallbackDb)
  const conn = await mysql.createConnection({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    connectTimeout: 10_000,
    ...(cfg.ssl ? { ssl: { minVersion: 'TLSv1.2', rejectUnauthorized: false } } : {}),
  })
  await conn.query(
    `CREATE DATABASE IF NOT EXISTS \`${cfg.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`
  )
  const [version] = await conn.query('SELECT VERSION() AS v')
  const [dbs] = await conn.query('SHOW DATABASES')
  const dbNames = (dbs as Record<string, unknown>[]).map((d) => Object.values(d)[0])
  const visible = dbNames.filter(
    (n) => !['mysql', 'INFORMATION_SCHEMA', 'PERFORMANCE_SCHEMA', 'METRICS_SCHEMA', 'sys'].includes(String(n))
  )
  console.log(
    `[${label}] TiDB ${(version as Record<string, unknown>[])[0].v} at ${cfg.host}:${cfg.port} -> databases: ${visible.join(', ')}${cfg.ssl ? ' (TLS)' : ''}`
  )
  await conn.end()
}

async function main() {
  await initCluster('books', BOOKS_URL, 'books_db')
  await initCluster('notes', NOTES_URL, 'notes_db')
  console.log('BOTH CLUSTERS READY')
}

main()
  .catch((e) => {
    console.error('INIT FAILED:', e instanceof Error ? e.message : e)
    process.exit(1)
  })
  .finally(() => {})
