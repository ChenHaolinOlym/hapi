import { Database } from 'bun:sqlite'
import { chmodSync, closeSync, existsSync, mkdirSync, openSync } from 'node:fs'
import { dirname } from 'node:path'

import { FeishuEventStore } from './feishuEventStore'
import { FeishuItemStore } from './feishuItemStore'
import { FeishuRequestStore } from './feishuRequestStore'
import { FeishuThreadStore } from './feishuThreadStore'
import { MachineStore } from './machineStore'
import { MessageStore } from './messageStore'
import { PushStore } from './pushStore'
import { SessionStore } from './sessionStore'
import { UserStore } from './userStore'

export type {
    FeishuItemUpsertInput,
    StoredFeishuItem,
    StoredFeishuRequest,
    StoredFeishuSeenEvent,
    StoredFeishuThread,
    StoredMachine,
    StoredMessage,
    StoredPushSubscription,
    StoredSession,
    StoredUser,
    VersionedUpdateResult
} from './types'
export { FeishuEventStore } from './feishuEventStore'
export { FeishuItemStore } from './feishuItemStore'
export { FeishuRequestStore } from './feishuRequestStore'
export { FeishuThreadStore } from './feishuThreadStore'
export { MachineStore } from './machineStore'
export { MessageStore } from './messageStore'
export { PushStore } from './pushStore'
export { SessionStore } from './sessionStore'
export { UserStore } from './userStore'

const SCHEMA_VERSION: number = 11
const REQUIRED_TABLES = [
    'sessions',
    'machines',
    'messages',
    'users',
    'push_subscriptions',
    'feishu_items',
    'feishu_threads',
    'feishu_requests',
    'feishu_seen_events'
] as const

export class Store {
    private db: Database
    private readonly dbPath: string

    readonly sessions: SessionStore
    readonly machines: MachineStore
    readonly messages: MessageStore
    readonly users: UserStore
    readonly push: PushStore
    readonly feishuItems: FeishuItemStore
    readonly feishuThreads: FeishuThreadStore
    readonly feishuRequests: FeishuRequestStore
    readonly feishuEvents: FeishuEventStore

    constructor(dbPath: string) {
        this.dbPath = dbPath
        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            const dir = dirname(dbPath)
            mkdirSync(dir, { recursive: true, mode: 0o700 })
            try {
                chmodSync(dir, 0o700)
            } catch {
            }

            if (!existsSync(dbPath)) {
                try {
                    const fd = openSync(dbPath, 'a', 0o600)
                    closeSync(fd)
                } catch {
                }
            }
        }

        this.db = new Database(dbPath, { create: true, readwrite: true, strict: true })
        this.db.exec('PRAGMA journal_mode = WAL')
        this.db.exec('PRAGMA synchronous = NORMAL')
        this.db.exec('PRAGMA foreign_keys = ON')
        this.db.exec('PRAGMA busy_timeout = 5000')
        this.initSchema()

        if (dbPath !== ':memory:' && !dbPath.startsWith('file::memory:')) {
            for (const path of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
                try {
                    chmodSync(path, 0o600)
                } catch {
                }
            }
        }

        this.sessions = new SessionStore(this.db)
        this.machines = new MachineStore(this.db)
        this.messages = new MessageStore(this.db)
        this.users = new UserStore(this.db)
        this.push = new PushStore(this.db)
        this.feishuItems = new FeishuItemStore(this.db)
        this.feishuThreads = new FeishuThreadStore(this.db)
        this.feishuRequests = new FeishuRequestStore(this.db)
        this.feishuEvents = new FeishuEventStore(this.db)
    }

    private initSchema(): void {
        const currentVersion = this.getUserVersion()
        if (currentVersion === 0) {
            if (this.hasAnyUserTables()) {
                this.migrateLegacySchemaIfNeeded()
                this.createSchema()
                this.setUserVersion(SCHEMA_VERSION)
                return
            }

            this.createSchema()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 1 && SCHEMA_VERSION === 2) {
            this.migrateFromV1ToV2()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 2 && SCHEMA_VERSION === 3) {
            this.migrateFromV2ToV3()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 3 && SCHEMA_VERSION === 4) {
            this.migrateFromV3ToV4()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 4 && SCHEMA_VERSION === 5) {
            this.migrateFromV4ToV5()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 6) {
            this.migrateFromV5ToV6()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 7) {
            this.migrateFromV5ToV6()
            this.migrateFromV6ToV7()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 6 && SCHEMA_VERSION === 7) {
            this.migrateFromV6ToV7()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 8) {
            this.migrateFromV5ToV6()
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 6 && SCHEMA_VERSION === 8) {
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 7 && SCHEMA_VERSION === 8) {
            this.migrateFromV7ToV8()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 9) {
            this.migrateFromV5ToV6()
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 6 && SCHEMA_VERSION === 9) {
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 7 && SCHEMA_VERSION === 9) {
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 8 && SCHEMA_VERSION === 9) {
            this.migrateFromV8ToV9()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 10) {
            this.migrateFromV5ToV6()
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 6 && SCHEMA_VERSION === 10) {
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 7 && SCHEMA_VERSION === 10) {
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 8 && SCHEMA_VERSION === 10) {
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 9 && SCHEMA_VERSION === 10) {
            this.migrateFromV9ToV10()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 5 && SCHEMA_VERSION === 11) {
            this.migrateFromV5ToV6()
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 6 && SCHEMA_VERSION === 11) {
            this.migrateFromV6ToV7()
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 7 && SCHEMA_VERSION === 11) {
            this.migrateFromV7ToV8()
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 8 && SCHEMA_VERSION === 11) {
            this.migrateFromV8ToV9()
            this.migrateFromV9ToV10()
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 9 && SCHEMA_VERSION === 11) {
            this.migrateFromV9ToV10()
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion === 10 && SCHEMA_VERSION === 11) {
            this.migrateFromV10ToV11()
            this.setUserVersion(SCHEMA_VERSION)
            return
        }

        if (currentVersion !== SCHEMA_VERSION) {
            throw this.buildSchemaMismatchError(currentVersion)
        }

        this.assertRequiredTablesPresent()
    }

    private createSchema(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                tag TEXT,
                namespace TEXT NOT NULL DEFAULT 'default',
                machine_id TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                agent_state TEXT,
                agent_state_version INTEGER DEFAULT 1,
                model TEXT,
                todos TEXT,
                todos_updated_at INTEGER,
                team_state TEXT,
                team_state_updated_at INTEGER,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_sessions_tag ON sessions(tag);
            CREATE INDEX IF NOT EXISTS idx_sessions_tag_namespace ON sessions(tag, namespace);

            CREATE TABLE IF NOT EXISTS machines (
                id TEXT PRIMARY KEY,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                metadata TEXT,
                metadata_version INTEGER DEFAULT 1,
                runner_state TEXT,
                runner_state_version INTEGER DEFAULT 1,
                active INTEGER DEFAULT 0,
                active_at INTEGER,
                seq INTEGER DEFAULT 0
            );
            CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace);

            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                session_id TEXT NOT NULL,
                content TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                seq INTEGER NOT NULL,
                local_id TEXT,
                FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
            );
            CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;

            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                platform TEXT NOT NULL,
                platform_user_id TEXT NOT NULL,
                namespace TEXT NOT NULL DEFAULT 'default',
                created_at INTEGER NOT NULL,
                UNIQUE(platform, platform_user_id)
            );
            CREATE INDEX IF NOT EXISTS idx_users_platform ON users(platform);
            CREATE INDEX IF NOT EXISTS idx_users_platform_namespace ON users(platform, namespace);

            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                namespace TEXT NOT NULL,
                endpoint TEXT NOT NULL,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                UNIQUE(namespace, endpoint)
            );
            CREATE INDEX IF NOT EXISTS idx_push_subscriptions_namespace ON push_subscriptions(namespace);

            CREATE TABLE IF NOT EXISTS feishu_items (
                namespace TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                item_key TEXT NOT NULL,
                item_type TEXT NOT NULL,
                status TEXT NOT NULL,
                source_id TEXT,
                feishu_message_id TEXT,
                render_state_json TEXT,
                render_version INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, root_message_id, item_key)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_items_session ON feishu_items(namespace, session_id, updated_at);

            CREATE TABLE IF NOT EXISTS feishu_threads (
                namespace TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                operator_open_id TEXT NOT NULL,
                machine_id TEXT,
                repo_path TEXT NOT NULL,
                session_name TEXT,
                model TEXT,
                permission_mode TEXT NOT NULL,
                collaboration_mode TEXT NOT NULL,
                delivery_mode TEXT NOT NULL,
                reasoning_summary TEXT NOT NULL DEFAULT 'auto',
                tool_visibility TEXT NOT NULL DEFAULT 'important',
                phase TEXT NOT NULL,
                attention TEXT NOT NULL,
                last_forwarded_seq INTEGER,
                active_turn_seq INTEGER,
                last_seen_ready_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, chat_id, root_message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_threads_session ON feishu_threads(namespace, session_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_threads_unique_session ON feishu_threads(namespace, session_id);

            CREATE TABLE IF NOT EXISTS feishu_requests (
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                short_token TEXT NOT NULL,
                kind TEXT NOT NULL,
                decision_scope TEXT NOT NULL,
                answer_shape TEXT NOT NULL,
                feishu_message_id TEXT,
                request_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER,
                PRIMARY KEY (namespace, session_id, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_requests_open ON feishu_requests(namespace, session_id, status, created_at);

            CREATE TABLE IF NOT EXISTS feishu_seen_events (
                source TEXT NOT NULL,
                external_event_id TEXT NOT NULL,
                seen_at INTEGER NOT NULL,
                PRIMARY KEY (source, external_event_id)
            );
        `)
    }

    private migrateLegacySchemaIfNeeded(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            return
        }

        const hasDaemon = columns.has('daemon_state') || columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') || columns.has('runner_state_version')

        if (hasDaemon && hasRunner) {
            throw new Error('SQLite schema has both daemon_state and runner_state columns in machines; manual cleanup required.')
        }

        if (hasDaemon && !hasRunner) {
            this.migrateFromV1ToV2()
        }
    }

    private migrateFromV1ToV2(): void {
        const columns = this.getMachineColumnNames()
        if (columns.size === 0) {
            throw new Error('SQLite schema missing machines table for v1 to v2 migration.')
        }

        const hasDaemon = columns.has('daemon_state') && columns.has('daemon_state_version')
        const hasRunner = columns.has('runner_state') && columns.has('runner_state_version')

        if (hasRunner && !hasDaemon) {
            return
        }

        if (!hasDaemon) {
            throw new Error('SQLite schema missing daemon_state columns for v1 to v2 migration.')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state TO runner_state')
            this.db.exec('ALTER TABLE machines RENAME COLUMN daemon_state_version TO runner_state_version')
            this.db.exec('COMMIT')
            return
        } catch (error) {
            this.db.exec('ROLLBACK')
        }

        try {
            this.db.exec('BEGIN')
            this.db.exec(`
                CREATE TABLE machines_new (
                    id TEXT PRIMARY KEY,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    metadata TEXT,
                    metadata_version INTEGER DEFAULT 1,
                    runner_state TEXT,
                    runner_state_version INTEGER DEFAULT 1,
                    active INTEGER DEFAULT 0,
                    active_at INTEGER,
                    seq INTEGER DEFAULT 0
                );
            `)
            this.db.exec(`
                INSERT INTO machines_new (
                    id, namespace, created_at, updated_at,
                    metadata, metadata_version,
                    runner_state, runner_state_version,
                    active, active_at, seq
                )
                SELECT id, namespace, created_at, updated_at,
                       metadata, metadata_version,
                       daemon_state, daemon_state_version,
                       active, active_at, seq
                FROM machines;
            `)
            this.db.exec('DROP TABLE machines')
            this.db.exec('ALTER TABLE machines_new RENAME TO machines')
            this.db.exec('CREATE INDEX IF NOT EXISTS idx_machines_namespace ON machines(namespace)')
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`SQLite schema migration v1->v2 failed: ${message}`)
        }
    }

    private migrateFromV2ToV3(): void {
        return
    }

    private migrateFromV3ToV4(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('team_state')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state TEXT')
        }
        if (!columns.has('team_state_updated_at')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN team_state_updated_at INTEGER')
        }
    }

    private migrateFromV4ToV5(): void {
        const columns = this.getSessionColumnNames()
        if (!columns.has('model')) {
            this.db.exec('ALTER TABLE sessions ADD COLUMN model TEXT')
        }
    }

    private migrateFromV5ToV6(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS feishu_threads (
                namespace TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                operator_open_id TEXT NOT NULL,
                machine_id TEXT,
                repo_path TEXT NOT NULL,
                session_name TEXT,
                model TEXT,
                permission_mode TEXT NOT NULL,
                collaboration_mode TEXT NOT NULL,
                delivery_mode TEXT NOT NULL,
                phase TEXT NOT NULL,
                attention TEXT NOT NULL,
                last_forwarded_seq INTEGER,
                active_turn_seq INTEGER,
                last_seen_ready_at INTEGER,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, chat_id, root_message_id)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_threads_session ON feishu_threads(namespace, session_id);
            CREATE UNIQUE INDEX IF NOT EXISTS idx_feishu_threads_unique_session ON feishu_threads(namespace, session_id);

            CREATE TABLE IF NOT EXISTS feishu_requests (
                namespace TEXT NOT NULL,
                session_id TEXT NOT NULL,
                request_id TEXT NOT NULL,
                short_token TEXT NOT NULL,
                kind TEXT NOT NULL,
                decision_scope TEXT NOT NULL,
                answer_shape TEXT NOT NULL,
                feishu_message_id TEXT,
                request_json TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                resolved_at INTEGER,
                PRIMARY KEY (namespace, session_id, request_id)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_requests_open ON feishu_requests(namespace, session_id, status, created_at);

            CREATE TABLE IF NOT EXISTS feishu_seen_events (
                source TEXT NOT NULL,
                external_event_id TEXT NOT NULL,
                seen_at INTEGER NOT NULL,
                PRIMARY KEY (source, external_event_id)
            );
        `)
    }

    private migrateFromV6ToV7(): void {
        const columns = this.getFeishuThreadColumnNames()
        if (!columns.has('active_turn_seq')) {
            this.db.exec('ALTER TABLE feishu_threads ADD COLUMN active_turn_seq INTEGER')
        }
    }

    private migrateFromV7ToV8(): void {
        const columns = this.getFeishuThreadColumnNames()
        if (!columns.has('reasoning_summary')) {
            this.db.exec("ALTER TABLE feishu_threads ADD COLUMN reasoning_summary TEXT NOT NULL DEFAULT 'auto'")
        }
        if (!columns.has('tool_visibility')) {
            this.db.exec("ALTER TABLE feishu_threads ADD COLUMN tool_visibility TEXT NOT NULL DEFAULT 'important'")
        }
    }

    private migrateFromV8ToV9(): void {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS feishu_items (
                namespace TEXT NOT NULL,
                chat_id TEXT NOT NULL,
                root_message_id TEXT NOT NULL,
                session_id TEXT NOT NULL,
                item_key TEXT NOT NULL,
                item_type TEXT NOT NULL,
                status TEXT NOT NULL,
                source_id TEXT,
                feishu_message_id TEXT,
                render_state_json TEXT,
                render_version INTEGER NOT NULL,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                PRIMARY KEY (namespace, root_message_id, item_key)
            );
            CREATE INDEX IF NOT EXISTS idx_feishu_items_session ON feishu_items(namespace, session_id, updated_at);
        `)
    }

    private migrateFromV9ToV10(): void {
        const rows = this.db.prepare('PRAGMA table_info(feishu_items)').all() as Array<{ name: string }>
        const columns = new Set(rows.map((row) => row.name))
        if (!columns.has('source_id')) {
            this.db.exec('ALTER TABLE feishu_items ADD COLUMN source_id TEXT')
        }
        this.normalizeLegacyFeishuItemCreatedAt()
    }

    private migrateFromV10ToV11(): void {
        const rows = this.db.prepare('PRAGMA table_info(feishu_items)').all() as Array<{ name: string }>
        const columns = new Set(rows.map((row) => row.name))
        if (!columns.has('render_state_json')) {
            this.db.exec('ALTER TABLE feishu_items ADD COLUMN render_state_json TEXT')
        }
    }

    private normalizeLegacyFeishuItemCreatedAt(): void {
        const rows = this.db.prepare(`
            SELECT rowid, namespace, root_message_id, created_at
            FROM feishu_items
            ORDER BY namespace ASC, root_message_id ASC, created_at ASC, rowid ASC
        `).all() as Array<{
            rowid: number
            namespace: string
            root_message_id: string
            created_at: number
        }>

        if (rows.length === 0) {
            return
        }

        const updateCreatedAt = this.db.prepare(`
            UPDATE feishu_items
            SET created_at = @created_at
            WHERE rowid = @rowid
        `)

        let currentGroupKey: string | null = null
        let lastCreatedAt: number | null = null

        this.db.exec('BEGIN')
        try {
            for (const row of rows) {
                const groupKey = `${row.namespace}\u0000${row.root_message_id}`
                if (groupKey !== currentGroupKey) {
                    currentGroupKey = groupKey
                    lastCreatedAt = null
                }

                const normalizedCreatedAt: number = lastCreatedAt === null
                    ? row.created_at
                    : Math.max(row.created_at, lastCreatedAt + 1)

                if (normalizedCreatedAt !== row.created_at) {
                    updateCreatedAt.run({
                        rowid: row.rowid,
                        created_at: normalizedCreatedAt
                    })
                }

                lastCreatedAt = normalizedCreatedAt
            }
            this.db.exec('COMMIT')
        } catch (error) {
            this.db.exec('ROLLBACK')
            throw error
        }
    }

    private getSessionColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getMachineColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(machines)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getFeishuThreadColumnNames(): Set<string> {
        const rows = this.db.prepare('PRAGMA table_info(feishu_threads)').all() as Array<{ name: string }>
        return new Set(rows.map((row) => row.name))
    }

    private getUserVersion(): number {
        const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number } | undefined
        return row?.user_version ?? 0
    }

    private setUserVersion(version: number): void {
        this.db.exec(`PRAGMA user_version = ${version}`)
    }

    private hasAnyUserTables(): boolean {
        const row = this.db.prepare(
            "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' LIMIT 1"
        ).get() as { name?: string } | undefined
        return Boolean(row?.name)
    }

    private assertRequiredTablesPresent(): void {
        const placeholders = REQUIRED_TABLES.map(() => '?').join(', ')
        const rows = this.db.prepare(
            `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
        ).all(...REQUIRED_TABLES) as Array<{ name: string }>
        const existing = new Set(rows.map((row) => row.name))
        const missing = REQUIRED_TABLES.filter((table) => !existing.has(table))

        if (missing.length > 0) {
            throw new Error(
                `SQLite schema is missing required tables (${missing.join(', ')}). ` +
                'Back up and rebuild the database, or run an offline migration to the expected schema version.'
            )
        }
    }

    private buildSchemaMismatchError(currentVersion: number): Error {
        const location = (this.dbPath === ':memory:' || this.dbPath.startsWith('file::memory:'))
            ? 'in-memory database'
            : this.dbPath
        return new Error(
            `SQLite schema version mismatch for ${location}. ` +
            `Expected ${SCHEMA_VERSION}, found ${currentVersion}. ` +
            'This build does not run compatibility migrations. ' +
            'Back up and rebuild the database, or run an offline migration to the expected schema version.'
        )
    }
}
