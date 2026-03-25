import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from './index'

describe('Feishu bridge store', () => {
    it('migrates an existing v5 store to v11 and creates Feishu tables', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-feishu-store-'))
        const dbPath = join(dir, 'store.sqlite')

        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE sessions (
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
                CREATE TABLE machines (
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
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    local_id TEXT
                );
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    platform_user_id TEXT NOT NULL,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    UNIQUE(platform, platform_user_id)
                );
                CREATE TABLE push_subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    namespace TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(namespace, endpoint)
                );
                CREATE INDEX idx_sessions_tag ON sessions(tag);
                CREATE INDEX idx_sessions_tag_namespace ON sessions(tag, namespace);
                CREATE INDEX idx_machines_namespace ON machines(namespace);
                CREATE INDEX idx_messages_session ON messages(session_id, seq);
                CREATE UNIQUE INDEX idx_messages_local_id ON messages(session_id, local_id) WHERE local_id IS NOT NULL;
                CREATE INDEX idx_users_platform ON users(platform);
                CREATE INDEX idx_users_platform_namespace ON users(platform, namespace);
                CREATE INDEX idx_push_subscriptions_namespace ON push_subscriptions(namespace);
                PRAGMA user_version = 5;
            `)
            db.close()

            const store = new Store(dbPath)
            store.feishuThreads.upsertThread({
                namespace: 'default',
                chatId: 'chat-1',
                rootMessageId: 'root-1',
                sessionId: 'session-1',
                operatorOpenId: 'ou_123',
                machineId: null,
                repoPath: '/tmp/repo',
                sessionName: null,
                model: 'gpt-5.4',
                permissionMode: 'default',
                collaborationMode: 'plan',
                deliveryMode: 'foreground',
                reasoningSummary: 'auto',
                toolVisibility: 'important',
                phase: 'planning',
                attention: 'none',
                lastForwardedSeq: null,
                activeTurnSeq: null,
                lastSeenReadyAt: null
            })
            expect(() => store.feishuThreads.upsertThread({
                namespace: 'default',
                chatId: 'chat-2',
                rootMessageId: 'root-2',
                sessionId: 'session-1',
                operatorOpenId: 'ou_123',
                machineId: null,
                repoPath: '/tmp/repo',
                sessionName: null,
                model: 'gpt-5.4',
                permissionMode: 'default',
                collaborationMode: 'plan',
                deliveryMode: 'foreground',
                reasoningSummary: 'brief',
                toolVisibility: 'all',
                phase: 'planning',
                attention: 'none',
                lastForwardedSeq: null,
                activeTurnSeq: null,
                lastSeenReadyAt: null
            })).toThrow()

            const migrated = new Database(dbPath, { create: false, readwrite: true, strict: true })
            const userVersion = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
            const tables = migrated.prepare(`
                SELECT name FROM sqlite_master
                WHERE type = 'table' AND name IN ('feishu_items', 'feishu_threads', 'feishu_requests', 'feishu_seen_events')
                ORDER BY name
            `).all() as Array<{ name: string }>
            const threadColumns = migrated.prepare('PRAGMA table_info(feishu_threads)').all() as Array<{ name: string }>
            const itemColumns = migrated.prepare('PRAGMA table_info(feishu_items)').all() as Array<{ name: string }>
            migrated.close()

            expect(userVersion.user_version).toBe(11)
            expect(tables.map((table) => table.name)).toEqual([
                'feishu_items',
                'feishu_requests',
                'feishu_seen_events',
                'feishu_threads'
            ])
            expect(threadColumns.map((column) => column.name)).toContain('reasoning_summary')
            expect(threadColumns.map((column) => column.name)).toContain('tool_visibility')
            expect(itemColumns.map((column) => column.name)).toContain('source_id')
            expect(itemColumns.map((column) => column.name)).toContain('render_state_json')
            expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
                sessionId: 'session-1',
                reasoningSummary: 'auto',
                toolVisibility: 'important'
            })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrates an existing v7 thread row to v11 and backfills display settings', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-feishu-store-v7-'))
        const dbPath = join(dir, 'store.sqlite')

        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE sessions (
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
                CREATE TABLE machines (
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
                CREATE TABLE messages (
                    id TEXT PRIMARY KEY,
                    session_id TEXT NOT NULL,
                    content TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    seq INTEGER NOT NULL,
                    local_id TEXT
                );
                CREATE TABLE users (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    platform TEXT NOT NULL,
                    platform_user_id TEXT NOT NULL,
                    namespace TEXT NOT NULL DEFAULT 'default',
                    created_at INTEGER NOT NULL,
                    UNIQUE(platform, platform_user_id)
                );
                CREATE TABLE push_subscriptions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    namespace TEXT NOT NULL,
                    endpoint TEXT NOT NULL,
                    p256dh TEXT NOT NULL,
                    auth TEXT NOT NULL,
                    created_at INTEGER NOT NULL,
                    UNIQUE(namespace, endpoint)
                );
                CREATE TABLE feishu_threads (
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
                CREATE TABLE feishu_requests (
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
                CREATE TABLE feishu_seen_events (
                    source TEXT NOT NULL,
                    external_event_id TEXT NOT NULL,
                    seen_at INTEGER NOT NULL,
                    PRIMARY KEY (source, external_event_id)
                );
                INSERT INTO feishu_threads (
                    namespace, chat_id, root_message_id, session_id, operator_open_id,
                    machine_id, repo_path, session_name, model, permission_mode,
                    collaboration_mode, delivery_mode, phase, attention,
                    last_forwarded_seq, active_turn_seq, last_seen_ready_at, created_at, updated_at
                ) VALUES (
                    'default', 'chat-1', 'root-1', 'session-1', 'ou_123',
                    'machine-1', '/tmp/repo', 'bridge test', 'gpt-5.4', 'default',
                    'plan', 'background', 'planning', 'approval',
                    42, 43, 44, 1000, 2000
                );
                PRAGMA user_version = 7;
            `)
            db.close()

            const store = new Store(dbPath)
            const migrated = new Database(dbPath, { create: false, readwrite: true, strict: true })
            const userVersion = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
            const row = migrated.prepare(`
                SELECT reasoning_summary, tool_visibility
                FROM feishu_threads
                WHERE namespace = 'default' AND chat_id = 'chat-1' AND root_message_id = 'root-1'
            `).get() as { reasoning_summary: string; tool_visibility: string } | undefined
            migrated.close()

            expect(userVersion.user_version).toBe(11)
            expect(row).toEqual({
                reasoning_summary: 'auto',
                tool_visibility: 'important'
            })
            expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
                reasoningSummary: 'auto',
                toolVisibility: 'important',
                deliveryMode: 'background',
                activeTurnSeq: 43
            })
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('migrates an existing v9 item table to v11 and normalizes tied created_at ordering', () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-feishu-store-v9-'))
        const dbPath = join(dir, 'store.sqlite')

        try {
            const db = new Database(dbPath, { create: true, readwrite: true, strict: true })
            db.exec(`
                CREATE TABLE feishu_items (
                    namespace TEXT NOT NULL,
                    chat_id TEXT NOT NULL,
                    root_message_id TEXT NOT NULL,
                    session_id TEXT NOT NULL,
                    item_key TEXT NOT NULL,
                    item_type TEXT NOT NULL,
                    status TEXT NOT NULL,
                    feishu_message_id TEXT,
                    render_version INTEGER NOT NULL,
                    created_at INTEGER NOT NULL,
                    updated_at INTEGER NOT NULL,
                    PRIMARY KEY (namespace, root_message_id, item_key)
                );
                CREATE INDEX idx_feishu_items_session ON feishu_items(namespace, session_id, updated_at);
                INSERT INTO feishu_items (
                    namespace, chat_id, root_message_id, session_id,
                    item_key, item_type, status, feishu_message_id,
                    render_version, created_at, updated_at
                ) VALUES
                    ('default', 'chat-1', 'root-1', 'session-1', 'turn12:response:1', 'response', 'completed', NULL, 120, 1000, 1000),
                    ('default', 'chat-1', 'root-1', 'session-2', 'turn1:response:2', 'response', 'completed', NULL, 5, 1000, 1000),
                    ('default', 'chat-1', 'root-1', 'session-2', 'turn1:response:10', 'response', 'completed', NULL, 13, 1000, 1000);
                PRAGMA user_version = 9;
            `)
            db.close()

            const store = new Store(dbPath)
            const migrated = new Database(dbPath, { create: false, readwrite: true, strict: true })
            const userVersion = migrated.prepare('PRAGMA user_version').get() as { user_version: number }
            const itemColumns = migrated.prepare('PRAGMA table_info(feishu_items)').all() as Array<{ name: string }>
            migrated.close()

            expect(userVersion.user_version).toBe(11)
            expect(itemColumns.map((column) => column.name)).toContain('source_id')
            expect(itemColumns.map((column) => column.name)).toContain('render_state_json')
            expect(store.feishuItems.listItemsForRootMessage('default', 'root-1').map((item) => item.itemKey)).toEqual([
                'turn12:response:1',
                'turn1:response:2',
                'turn1:response:10'
            ])
        } finally {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('persists thread bindings by namespace, chat, and root message', () => {
        const store = new Store(':memory:')
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'plan',
            deliveryMode: 'foreground',
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'planning',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuThreads.upsertThread({
            namespace: 'ops',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-2',
            operatorOpenId: 'ou_456',
            machineId: 'machine-2',
            repoPath: '/tmp/repo-ops',
            sessionName: 'bridge ops',
            model: 'gpt-5.4',
            permissionMode: 'read-only',
            collaborationMode: 'default',
            deliveryMode: 'background',
            reasoningSummary: 'none',
            toolVisibility: 'off',
            phase: 'executing',
            attention: 'approval',
            lastForwardedSeq: 17,
            activeTurnSeq: null,
            lastSeenReadyAt: 12345
        })

        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            sessionId: 'session-1',
            deliveryMode: 'foreground',
            phase: 'planning',
            attention: 'none',
            reasoningSummary: 'brief',
            toolVisibility: 'all'
        })
        expect(store.feishuThreads.getThread('ops', 'chat-1', 'root-1')).toMatchObject({
            sessionId: 'session-2',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'approval',
            reasoningSummary: 'none',
            toolVisibility: 'off'
        })
    })

    it('reassigns item rows when a thread root is rebound to a new session', () => {
        const store = new Store(':memory:')
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            sessionId: 'session-2'
        })
        expect(store.feishuItems.getItem('default', 'root-1', 'status-card')).toMatchObject({
            sessionId: 'session-2',
            feishuMessageId: 'om_card'
        })
    })

    it('rejects binding multiple root threads to the same session in one namespace', () => {
        const store = new Store(':memory:')
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'plan',
            deliveryMode: 'foreground',
            phase: 'planning',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        expect(() => store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-2',
            rootMessageId: 'root-2',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'plan',
            deliveryMode: 'foreground',
            phase: 'planning',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })).toThrow()
    })

    it('can delete the current thread binding or all bindings for a session', () => {
        const store = new Store(':memory:')
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'plan',
            deliveryMode: 'foreground',
            phase: 'planning',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'active',
            feishuMessageId: 'om_card_1',
            renderVersion: 1
        })
        store.feishuThreads.upsertThread({
            namespace: 'ops',
            chatId: 'chat-2',
            rootMessageId: 'root-2',
            sessionId: 'session-2',
            operatorOpenId: 'ou_456',
            machineId: 'machine-2',
            repoPath: '/tmp/repo-2',
            sessionName: 'bridge ops',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'ops',
            chatId: 'chat-2',
            rootMessageId: 'root-2',
            sessionId: 'session-2',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'active',
            feishuMessageId: 'om_card_2',
            renderVersion: 1
        })

        expect(store.feishuThreads.deleteThread('default', 'chat-1', 'root-1')).toBe(1)
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toBeNull()
        expect(store.feishuItems.getItem('default', 'root-1', 'status-card')).toBeNull()

        expect(store.feishuThreads.deleteThreadsBySessionId('ops', 'session-2')).toBe(1)
        expect(store.feishuThreads.getThread('ops', 'chat-2', 'root-2')).toBeNull()
        expect(store.feishuItems.getItem('ops', 'root-2', 'status-card')).toBeNull()
    })

    it('creates and retrieves Feishu item card state', () => {
        const store = new Store(':memory:')
        const created = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: null,
            renderStateJson: JSON.stringify({
                itemType: 'tool',
                toolName: 'bash'
            }),
            renderVersion: 1
        })

        expect(created).toMatchObject({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: null,
            renderStateJson: JSON.stringify({
                itemType: 'tool',
                toolName: 'bash'
            }),
            renderVersion: 1
        })
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toMatchObject({
            itemType: 'tool',
            status: 'active',
            renderStateJson: JSON.stringify({
                itemType: 'tool',
                toolName: 'bash'
            }),
            renderVersion: 1
        })
    })

    it('updates a Feishu item from active to completed', () => {
        const store = new Store(':memory:')
        const created = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: null,
            renderVersion: 1
        })
        const updated = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'completed',
            feishuMessageId: null,
            renderVersion: 2
        })

        expect(updated.status).toBe('completed')
        expect(updated.renderVersion).toBe(2)
        expect(updated.createdAt).toBe(created.createdAt)
        expect(updated.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toMatchObject({
            status: 'completed',
            renderVersion: 2
        })
    })

    it('stores and retrieves the Feishu message id for an item card', () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })

        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toMatchObject({
            feishuMessageId: 'om_card'
        })
    })

    it('deduplicates repeated item updates by namespace, root message, and item key', () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: null,
            renderVersion: 1
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 2
        })

        const items = store.feishuItems.listItemsForRootMessage('default', 'om_root')

        expect(items).toHaveLength(1)
        expect(items[0]).toMatchObject({
            itemKey: 'turn-1:tool-3',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 2
        })
    })

    it('ignores stale item updates with a lower render version', () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 2
        })

        const updated = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: 'om_card_old',
            renderVersion: 1
        })

        expect(updated).toMatchObject({
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 2
        })
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toMatchObject({
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 2
        })
    })

    it('deletes item rows by session even when no thread binding rows remain', () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-orphan',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 2
        })

        expect(store.feishuThreads.deleteThreadsBySessionId('default', 'session-orphan')).toBe(0)
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toBeNull()
    })

    it('preserves terminal item state across same-version replays', () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })

        const replayed = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn-1:tool-3',
            itemType: 'tool',
            status: 'active',
            feishuMessageId: null,
            renderVersion: 1
        })

        expect(replayed).toMatchObject({
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:tool-3')).toMatchObject({
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })
    })

    it('preserves rebound session ownership across same-version replays from the old session', () => {
        const store = new Store(':memory:')
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'bridge test',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-2',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 1
        })

        const replayed = store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'status-card',
            itemType: 'response',
            status: 'active',
            feishuMessageId: 'om_card_old',
            renderVersion: 1
        })

        expect(replayed).toMatchObject({
            sessionId: 'session-2',
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 1
        })
        expect(store.feishuItems.getItem('default', 'root-1', 'status-card')).toMatchObject({
            sessionId: 'session-2',
            status: 'completed',
            feishuMessageId: 'om_card_new',
            renderVersion: 1
        })
    })

    it('lists item rows in append order even when later turns reset their numeric suffixes', async () => {
        const store = new Store(':memory:')
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-1',
            itemKey: 'turn12:response:1',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: null,
            renderVersion: 120
        })

        await new Promise((resolve) => setTimeout(resolve, 2))

        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-2',
            itemKey: 'turn1:response:2',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: null,
            renderVersion: 5
        })

        expect(store.feishuItems.listItemsForRootMessage('default', 'om_root').map((item) => item.itemKey)).toEqual([
            'turn12:response:1',
            'turn1:response:2'
        ])
    })

    it('keeps append order stable for double-digit item indexes created in one burst', () => {
        const store = new Store(':memory:')

        for (let index = 1; index <= 10; index += 1) {
            store.feishuItems.upsertItem({
                namespace: 'default',
                chatId: 'oc_chat',
                rootMessageId: 'om_root',
                sessionId: 'session-1',
                itemKey: `turn1:response:${index}`,
                itemType: 'response',
                status: 'completed',
                feishuMessageId: null,
                renderVersion: index
            })
        }

        expect(store.feishuItems.listItemsForRootMessage('default', 'om_root').map((item) => item.itemKey)).toEqual([
            'turn1:response:1',
            'turn1:response:2',
            'turn1:response:3',
            'turn1:response:4',
            'turn1:response:5',
            'turn1:response:6',
            'turn1:response:7',
            'turn1:response:8',
            'turn1:response:9',
            'turn1:response:10'
        ])
    })

    it('tracks request state and resolution by session and request id', () => {
        const store = new Store(':memory:')
        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: 'req-1',
            shortToken: 'A1',
            kind: 'permission',
            decisionScope: 'request',
            answerShape: 'flat',
            feishuMessageId: 'msg-1',
            requestJson: '{"tool":"CodexPermission"}',
            status: 'open'
        })
        store.feishuRequests.upsertRequest({
            namespace: 'ops',
            sessionId: 'session-1',
            requestId: 'req-1',
            shortToken: 'B2',
            kind: 'question',
            decisionScope: 'session',
            answerShape: 'nested',
            feishuMessageId: 'msg-2',
            requestJson: '{"prompt":"Choose one"}',
            status: 'open'
        })

        expect(store.feishuRequests.listOpenRequestsForSession('default', 'session-1')).toEqual([
            expect.objectContaining({
                requestId: 'req-1',
                shortToken: 'A1',
                status: 'open'
            })
        ])
        expect(store.feishuRequests.listOpenRequestsForSession('ops', 'session-1')).toEqual([
            expect.objectContaining({
                requestId: 'req-1',
                shortToken: 'B2',
                status: 'open'
            })
        ])

        expect(store.feishuRequests.markResolved('default', 'session-1', 'req-1')).toBe(true)
        expect(store.feishuRequests.listOpenRequestsForSession('default', 'session-1')).toEqual([])
        expect(store.feishuRequests.listOpenRequestsForSession('ops', 'session-1')).toEqual([
            expect.objectContaining({
                requestId: 'req-1',
                shortToken: 'B2',
                status: 'open'
            })
        ])
    })

    it('deduplicates seen callback events', () => {
        const store = new Store(':memory:')

        expect(store.feishuEvents.hasSeen('callback', 'evt-1')).toBe(false)
        expect(store.feishuEvents.markSeen('callback', 'evt-1')).toBe(true)
        expect(store.feishuEvents.hasSeen('callback', 'evt-1')).toBe(true)
        expect(store.feishuEvents.markSeen('callback', 'evt-1')).toBe(false)
    })
})
