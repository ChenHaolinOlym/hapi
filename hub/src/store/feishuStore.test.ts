import { Database } from 'bun:sqlite'
import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { Store } from './index'

describe('Feishu bridge store', () => {
    it('migrates an existing v5 store to v6 and creates Feishu tables', () => {
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
                WHERE type = 'table' AND name IN ('feishu_threads', 'feishu_requests', 'feishu_seen_events')
                ORDER BY name
            `).all() as Array<{ name: string }>
            migrated.close()

            expect(userVersion.user_version).toBe(7)
            expect(tables.map((table) => table.name)).toEqual([
                'feishu_requests',
                'feishu_seen_events',
                'feishu_threads'
            ])
            expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
                sessionId: 'session-1'
            })
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
            attention: 'none'
        })
        expect(store.feishuThreads.getThread('ops', 'chat-1', 'root-1')).toMatchObject({
            sessionId: 'session-2',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'approval'
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

        expect(store.feishuThreads.deleteThread('default', 'chat-1', 'root-1')).toBe(1)
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toBeNull()

        expect(store.feishuThreads.deleteThreadsBySessionId('ops', 'session-2')).toBe(1)
        expect(store.feishuThreads.getThread('ops', 'chat-2', 'root-2')).toBeNull()
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
