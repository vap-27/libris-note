# Libris — 3D Book Notes

A premium, interactive 3D book and tactile felt-board workspace you can write inside. Open a realistic saddle-brown leather volume, write on its ruled pages, add and renumber pages in real time, consult a live index, search every phrase cross-cluster, keep margin notes, and pin thoughts to an expansive sticky-note board.

Every byte is engineered for enterprise-grade durability across **two independent TiDB Cloud clusters** (Cluster A for books and pages, Cluster B for margin and board notes), backed by a **CockroachDB backup engine** (dynamic fallback and overflow store) plus a separate lightweight identity/presence store.

![stack](https://img.shields.io/badge/Next.js-16-black) ![ts](https://img.shields.io/badge/TypeScript-5-blue) ![db](https://img.shields.io/badge/TiDB-2%20clusters-red) ![backup](https://img.shields.io/badge/CockroachDB-backup%20engine-6933FF)

---

## Architecture & Storage Engine

```
                               ┌────────────────────────────────────────────────┐
                               │               Libris Application               │
                               │          (Next.js 16 + React 19 + App Router)  │
                               └──────────────────────┬─────────────────────────┘
                                                      │
                       ┌──────────────────────────────┴──────────────────────────────┐
                       │                                                            │
                       ▼                                                            ▼
         ┌───────────────────────────┐                                ┌───────────────────────────┐
         │       TiDB Cluster A      │                                │       TiDB Cluster B      │
         │          books_db         │                                │          notes_db         │
         ├───────────────────────────┤                                ├───────────────────────────┤
         │ • Books & Metadata        │                                │ • Margin Notes            │
         │ • Ruled Pages & Titles    │                                │ • Sticky & Card Notes     │
         │ • Reading Position        │                                │ • Coordinate Grid & Pins  │
         │ • Page Order & Renumbering│                                │ • Soft-Delete Trash       │
         └─────────────┬─────────────┘                                └─────────────┬─────────────┘
                       │                                                            │
                       │           Dynamic Shift Engine (< 10MB Remaining)          │
                       └──────────────────────────────┬─────────────────────────────┘
                                                      │
                                                      ▼
                                       ┌─────────────────────────────┐
                                       │  CockroachDB Backup Engine  │
                                       │   (snapshot + overflow)     │
                                       ├─────────────────────────────┤
                                       │ • Automatic Overflow Shift  │
                                       │ • One-Click Snapshot Backup │
                                       │ • Persistent Activity Logs  │
                                       │ • High-Availability Standby │
                                       └─────────────────────────────┘

                     ┌─────────────────────────────────────┐
                     │  UsrInfo Store (usernames, PINs,    │
                     │  presence heartbeats, page leases)  │
                     └─────────────────────────────────────┘
```

### Dynamic Storage Shift & Fallback Policy

Libris pairs TiDB Cloud Serverless clusters with a CockroachDB backup engine to guarantee zero data loss and uninterrupted service:

1. **Primary Operation (> 10MB Available)**:
   - All books, chapters, and pages are authored to **TiDB Cluster A**.
   - All margin notes, board cards, and stickies are authored to **TiDB Cluster B**.
   - CockroachDB remains in continuous armed standby ready to ingest overflow.
2. **Dynamic Shift Active (< 10MB Remaining)**:
   - If either TiDB cluster's free capacity drops below **10 MB**, the dynamic storage shift engine activates.
   - Newly created pages and notes are seamlessly routed directly to the CockroachDB backup engine without user interruption or downtime.
3. **Critical Peak Storage Protection (< 1MB Remaining)**:
   - When remaining storage drops below **1 MB**, emergency peak protection activates.
   - All incoming write operations are instantly diverted to CockroachDB to safeguard against database disk rejection.
4. **Dual-Cluster Snapshot Replication (`/storage`)**:
   - One-click and automated snapshot synchronization creates full backups of both TiDB clusters into CockroachDB tables (`books`, `pages`, `page_notes`, `board_notes`).

---

## What's Inside

| Feature | Details |
|---|---|
| **3D Leather Volume** | Handcrafted saddle-brown leather cover with yellow-gold foil embossing, banded spine, gilded fore-edge, and physical curvature shading. Opens with a smooth `requestAnimationFrame` loop. Dual-page spread on desktop, single-page responsive under 900px. |
| **Writable Ruled Pages** | Every page is authentic ruled paper: click and write — typography sits precisely ON the rules. Titles sit in the header. Edits autosave to TiDB with debounced persistence and flush instantly on turn away. |
| **Page Lifecycle & Renumbering** | Add fresh pages after your current reading position (toolbar, index, or the trailing blank sheet; keyboard shortcut `N`). Rapid clicks mint exactly one page. Empty pages are automatically pruned; any character keeps a page forever. Deleting a page renumbers all subsequent sheets and smoothly shifts margin notes. |
| **Live Database Index** | The index drawer (`I`) displays every page with live word count, pin status, and margin note markers. Selecting a row riffles directly to that page. |
| **Realistic Page Turns** | Drag corners with physical curl algorithms (lift ~10% with corner tilt and cast shading), click outer margins, or use arrow keys. Multi-page jumps riffle smoothly without flashing. |
| **Cross-Cluster Search** | Toolbar search box indexes pages, headings, written text, AND personal margin notes across both TiDB clusters simultaneously with highlighted preview snippets. |
| **Reading Zoom** | Magnifies the book 1.45x (`Z`) for focused reading with smooth click-and-drag panning. In zoom mode, pages switch to read-only to prevent accidental edits. |
| **Margin Notes Panel** | Opens alongside the book: create, recolor, edit, delete, and restore page-anchored notes. Saved to TiDB Notes cluster the moment you confirm. |
| **Tactile Felt Board** | Sticky notes and ruled note cards on an infinite felt canvas. Drag notes anywhere from their paper surface, write freely, change colors, or soft-delete to trash. |
| **Pins & Timeline Slider** | Pin notes to lock their canvas coordinates; pin pages to prevent automatic pruning. A draggable day-by-day slider at the bottom filters notes chronologically (oldest → newest) with smooth glide animation. |
| **Book-to-Board Integration** | The book-plus action on any board note duplicates its content directly into the book as a fresh numbered page while keeping the note on the board. |
| **Health Dashboard (`/health`)** | Full-featured observability suite: live status of TiDB Books, TiDB Notes, and the CockroachDB backup engine, cluster latencies, capacity indicators, on-demand manual diagnostics, configurable check intervals (Manual, 60s, 600s), and a real-time activity log stream. |
| **Storage Center (`/storage`)** | Deep database telemetry: live disk bytes, table rows, snapshot backup controls, and recovery tools. |
| **Real Activity Logs** | 100% genuine database activity logging persisted in CockroachDB (`system_logs`) tracking creates, edits, deletions, restores, backups, and storage shifts. No mock or fake entries. |
| **Action Notifications** | Subtle, non-intrusive toasts for autosave database syncs, page additions/removals, note lifecycle, and online/offline network detection. |
| **Plaintext Export** | One-click export compiles the entire manuscript into `libris.txt` exactly as stored in the database. |

---

## Tech Stack

- **Framework**: Next.js 16 (App Router) & React 19
- **Languages**: TypeScript 5
- **Styling**: Tailwind CSS 4 & Vanilla CSS Design System (*"Ink & Saddle"*)
- **Primary Databases**: TiDB Cloud Serverless (Dual Clusters via Prisma ORM)
- **Backup Engine**: CockroachDB (snapshots, overflow, activity logs via Prisma)
- **Identity & Presence Store**: third TiDB cluster (`users_db` via Prisma)
- **Typography**: EB Garamond (classic literary voice) & Geist (interface chrome)
- **UI & Motion**: Radix UI, Lucide Icons, dnd-kit

---

## Database Schema & API Surface

### Schema Split
- **TiDB Cluster A (`prisma/schema.prisma`)**:
  - `Book`: Book title, created timestamp, reading progress, active pages.
  - `Page`: Page number, title, body content, pinned status, book relation.
- **TiDB Cluster B (`prisma/schema-notes.prisma`)**:
  - `PageNote`: Note text, page number, color, soft-delete timestamp.
  - `BoardNote`: Note text, canvas (x, y, z), type (`sticky` / `card`), color, pin status, soft-delete timestamp.
- **CockroachDB backup engine (`prisma/schema-backup.prisma`, `src/lib/turso.ts` front)**:
  - `system_logs`: Real-time persistent activity logs.
  - `books`, `pages`, `page_notes`, `board_notes`: Snapshot backups & dynamic overflow storage.
- **UsrInfo store (`src/lib/usrinfo.ts`)**: usernames, PIN claims, presence heartbeats, page leases.

### API Routes

| Endpoint | Method | Purpose | Engine Target |
|---|---|---|---|
| `/api/health` | `GET` | Cluster liveness, storage metrics, shift state, and real-time activity logs | TiDB A + B, CockroachDB |
| `/api/health` | `DELETE` | Clears activity log stream from database | CockroachDB |
| `/api/storage` | `GET` | Database storage telemetry, table rows, and usage metrics | TiDB A + B, CockroachDB |
| `/api/backup` | `POST` | Executes full snapshot synchronization from TiDB to CockroachDB | TiDB → CockroachDB |
| `/api/backup?action=restore&confirm=RESTORE` | `POST` | Restores snapshot data from CockroachDB into TiDB (last-write-wins) | CockroachDB → TiDB |
| `/api/book` | `GET` | Retrieves active book and ordered page list | TiDB Cluster A |
| `/api/book/progress` | `PATCH` | Saves and restores user reading position | TiDB Cluster A |
| `/api/pages` | `POST` | Creates a new page after a specified index | TiDB Cluster A / CockroachDB |
| `/api/pages/[pageId]` | `PATCH`, `DELETE` | Updates page content/pin or deletes page (renumbering subsequent sheets) | TiDB Cluster A / CockroachDB |
| `/api/pages/[pageId]/notes` | `GET`, `POST` | Fetches or creates margin notes for a specific page | TiDB Cluster B / CockroachDB |
| `/api/notes/[noteId]` | `PATCH`, `DELETE` | Edits or soft-deletes a margin note | TiDB Cluster B / CockroachDB |
| `/api/notes/[noteId]/restore`| `POST` | Restores a soft-deleted margin note | TiDB Cluster B / CockroachDB |
| `/api/board` | `GET`, `POST` | Lists active board notes or creates a new sticky/card | TiDB Cluster B / CockroachDB |
| `/api/board/[noteId]` | `PATCH`, `DELETE` | Updates note content/position/pin or moves to trash | TiDB Cluster B / CockroachDB |
| `/api/board/[noteId]/restore`| `POST` | Restores a note from the trash back onto the board | TiDB Cluster B / CockroachDB |
| `/api/presence` | `GET`, `POST` | Live users, page leases, heartbeat + lock ops | UsrInfo store |
| `/api/identity` | `POST` | Guest bootstrap, name claim + PIN verify | UsrInfo store |

---

## Setup & Getting Started

### 1. Clone & Install Dependencies

```bash
git clone https://github.com/your-username/libris.git
cd libris
npm install
```

### 2. Configure Environment Variables

Copy the example environment configuration:

```bash
cp .env.example .env
```

Edit `.env` with your database credentials:

```bash
# TiDB Cluster A (Books & Pages)
BOOKS_DATABASE_URL="mysql://<user>:<password>@<host-a>:4000/books_db?sslaccept=strict"

# TiDB Cluster B (Notes & Board)
NOTES_DATABASE_URL="mysql://<user>:<password>@<host-b>:4000/notes_db?sslaccept=strict"

# CockroachDB backup engine (snapshots, overflow, activity logs)
BACKUP_DATABASE_URL="postgresql://<user>:<password>@<host>:26257/defaultdb?sslmode=verify-full"

# Users store — display names, PINs, presence, page leases (third TiDB cluster)
USERS_DATABASE_URL="mysql://<user>:<password>@<host-c>:4000/users_db?sslaccept=strict"
```

### 3. Initialize Databases & Seed

```bash
# Push schemas to both TiDB clusters and generate Prisma clients
npm run db:push

# Push the CockroachDB backup schema + generate its client
npm run db:push:backup

# Seed initial volume and introductory notes
npm run seed

# Verify connectivity and table schemas
npm run db:verify
```

### 4. Run the Development Server

```bash
npm run dev
```

Visit **`http://localhost:3000`** in your browser to open the book.

---

## Available Scripts

| Command | Description |
|---|---|
| `npm run dev` | Starts Next.js development server on port 3000 |
| `npm run build` | Compiles production Next.js application bundle |
| `npm run start` | Launches production server |
| `npm run test` | Runs the vitest unit suite (DB-free: sanitizer, limiter, failover rules, CSRF) |
| `npm run lint` | Runs Next.js ESLint static analysis (note: `scripts/*` are manual live-DB probes, not CI tests) |
| `npm run db:push` | Pushes Prisma schemas to both TiDB clusters and regenerates clients |
| `npm run db:push:backup` | Pushes the CockroachDB backup schema and regenerates its client |
| `npm run db:generate` | Regenerates all three Prisma client SDKs without schema push |
| `npm run db:verify` | Verifies schemas, tables, and row counts across both TiDB clusters |
| `npm run seed` | Seeds default book and sample board notes |
| `npm run demo:restore` | Resets demo state and restores clean notes |

---

## Performance & Design Details

- **Zero-Layout Thrashing**: Book opening, page curls, riffles, and panning run in a unified `requestAnimationFrame` loop that ceases style writes when values converge.
- **Transform-Based Navigation**: Drag-to-pan in book and board zoom views operates strictly via CSS 3D matrix transforms without triggering DOM reflows.
- **Accessibility**: Comprehensive ARIA labels, tab index management, and native `prefers-reduced-motion` support across all page curls and board animations.
- **Curated Palette**: Warm paper grain, ink-black text, saddle leather (`#3b2219`), yellow gold foil stamping (`#d4af37`), and forest green board accents.

---

## License

MIT © Libris Contributors. Open source and free for personal and commercial use.
