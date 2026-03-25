import { describe, expect, it } from 'bun:test'
import { toSessionSummary } from '@hapi/protocol'
import type { SyncEvent } from '@hapi/protocol/types'
import { Store } from '../store'
import { RpcRegistry } from '../socket/rpcRegistry'
import type { EventPublisher } from './eventPublisher'
import { SessionCache } from './sessionCache'
import { SyncEngine } from './syncEngine'

function createPublisher(events: SyncEvent[]): EventPublisher {
    return {
        emit: (event: SyncEvent) => {
            events.push(event)
        }
    } as unknown as EventPublisher
}

describe('session model', () => {
    it('includes explicit model in session summaries', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-summary',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        expect(session.model).toBe('gpt-5.4')
        expect(toSessionSummary(session).model).toBe('gpt-5.4')
    })

    it('preserves model from old session when merging into resumed session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-model-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-model-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default'
        )

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        const merged = cache.getSession(newSession.id)
        expect(merged?.model).toBe('gpt-5.4')
    })

    it('persists applied session model updates, including clear-to-auto', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-config',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.applySessionConfig(session.id, { model: 'opus[1m]' })
        expect(cache.getSession(session.id)?.model).toBe('opus[1m]')
        expect(store.sessions.getSession(session.id)?.model).toBe('opus[1m]')

        cache.applySessionConfig(session.id, { model: null })
        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('persists keepalive model changes, including clearing the model', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-model-heartbeat',
            { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
            null,
            'default',
            'sonnet'
        )

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            model: null
        })

        expect(cache.getSession(session.id)?.model).toBeNull()
        expect(store.sessions.getSession(session.id)?.model).toBeNull()
    })

    it('tracks collaboration mode updates in memory from config and keepalive', () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-collaboration-mode',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        cache.applySessionConfig(session.id, { collaborationMode: 'plan' })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('plan')

        cache.handleSessionAlive({
            sid: session.id,
            time: Date.now(),
            thinking: false,
            collaborationMode: 'default'
        })
        expect(cache.getSession(session.id)?.collaborationMode).toBe('default')
    })

    it('deletes feishu bindings and item rows when deleting a session', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const session = cache.getOrCreateSession(
            'session-feishu-delete',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: session.id,
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/project',
            sessionName: 'Bridge Session',
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
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: session.id,
            itemKey: 'turn-1:response-1',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })
        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: session.id,
            requestId: 'perm-1',
            shortToken: 'REQ1',
            kind: 'permission',
            decisionScope: 'request',
            answerShape: 'flat',
            feishuMessageId: 'om_request',
            requestJson: '{"tool":"CodexBash"}',
            status: 'open'
        })

        await cache.deleteSession(session.id)

        expect(store.sessions.getSession(session.id)).toBeNull()
        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toBeNull()
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:response-1')).toBeNull()
        expect(store.feishuRequests.getRequest('default', session.id, 'perm-1')).toMatchObject({
            status: 'stale',
            shortToken: 'REQ1',
            feishuMessageId: 'om_request'
        })
    })

    it('moves feishu bindings and item rows to the resumed session during merge', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-feishu-merge-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-feishu-merge-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: oldSession.id,
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/project',
            sessionName: 'Bridge Session',
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
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: oldSession.id,
            itemKey: 'turn-1:response-1',
            itemType: 'response',
            status: 'completed',
            feishuMessageId: 'om_card',
            renderVersion: 1
        })
        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: oldSession.id,
            requestId: 'question-1',
            shortToken: 'ASK1',
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'nested',
            feishuMessageId: 'om_request',
            requestJson: '{"tool":"request_user_input"}',
            status: 'open'
        })

        await cache.mergeSessions(oldSession.id, newSession.id, 'default')

        expect(store.sessions.getSession(oldSession.id)).toBeNull()
        expect(store.feishuThreads.getThreadBySessionId('default', oldSession.id)).toBeNull()
        expect(store.feishuThreads.getThreadBySessionId('default', newSession.id)).toMatchObject({
            rootMessageId: 'om_root',
            sessionId: newSession.id
        })
        expect(store.feishuItems.getItem('default', 'om_root', 'turn-1:response-1')).toMatchObject({
            sessionId: newSession.id,
            feishuMessageId: 'om_card'
        })
        expect(store.feishuRequests.getRequest('default', oldSession.id, 'question-1')).toMatchObject({
            status: 'stale',
            shortToken: 'ASK1'
        })
        expect(store.feishuRequests.getRequest('default', newSession.id, 'question-1')).toMatchObject({
            status: 'open',
            shortToken: 'ASK1',
            feishuMessageId: 'om_request'
        })
    })

    it('fails merge before moving messages when the target session already owns a feishu binding', async () => {
        const store = new Store(':memory:')
        const events: SyncEvent[] = []
        const cache = new SessionCache(store, createPublisher(events))

        const oldSession = cache.getOrCreateSession(
            'session-feishu-merge-conflict-old',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )
        const newSession = cache.getOrCreateSession(
            'session-feishu-merge-conflict-new',
            { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
            null,
            'default',
            'gpt-5.4'
        )

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat_old',
            rootMessageId: 'om_root_old',
            sessionId: oldSession.id,
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/project',
            sessionName: 'Old Bridge Session',
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
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat_new',
            rootMessageId: 'om_root_new',
            sessionId: newSession.id,
            operatorOpenId: 'ou_456',
            machineId: 'machine-2',
            repoPath: '/tmp/project',
            sessionName: 'New Bridge Session',
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
        store.messages.addMessage(oldSession.id, {
            role: 'assistant',
            content: {
                type: 'text',
                text: 'old session message'
            }
        })

        await expect(cache.mergeSessions(oldSession.id, newSession.id, 'default')).rejects.toThrow(
            /binding already exists/
        )

        expect(store.messages.getMessages(oldSession.id, 10)).toHaveLength(1)
        expect(store.messages.getMessages(newSession.id, 10)).toHaveLength(0)
        expect(store.feishuThreads.getThreadBySessionId('default', oldSession.id)).toMatchObject({
            rootMessageId: 'om_root_old',
            sessionId: oldSession.id
        })
        expect(store.feishuThreads.getThreadBySessionId('default', newSession.id)).toMatchObject({
            rootMessageId: 'om_root_new',
            sessionId: newSession.id
        })
    })

    it('passes the stored model when respawning a resumed session', async () => {
        const store = new Store(':memory:')
        const engine = new SyncEngine(
            store,
            {} as never,
            new RpcRegistry(),
            { broadcast() {} } as never
        )

        try {
            const session = engine.getOrCreateSession(
                'session-model-resume',
                {
                    path: '/tmp/project',
                    host: 'localhost',
                    machineId: 'machine-1',
                    flavor: 'codex',
                    codexSessionId: 'codex-thread-1'
                },
                null,
                'default',
                'gpt-5.4'
            )
            engine.getOrCreateMachine(
                'machine-1',
                { host: 'localhost', platform: 'linux', happyCliVersion: '0.1.0' },
                null,
                'default'
            )
            engine.handleMachineAlive({ machineId: 'machine-1', time: Date.now() })

            let capturedModel: string | undefined
            ;(engine as any).rpcGateway.spawnSession = async (
                _machineId: string,
                _directory: string,
                _agent: string,
                model?: string
            ) => {
                capturedModel = model
                return { type: 'success', sessionId: session.id }
            }
            ;(engine as any).waitForSessionActive = async () => true

            const result = await engine.resumeSession(session.id, 'default')

            expect(result).toEqual({ type: 'success', sessionId: session.id })
            expect(capturedModel).toBe('gpt-5.4')
        } finally {
            engine.stop()
        }
    })
})
