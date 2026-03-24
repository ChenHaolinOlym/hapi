import { describe, expect, it } from 'bun:test'

import { AGENT_MESSAGE_PAYLOAD_TYPE, type DecryptedMessage, type Session, type SyncEvent } from '@hapi/protocol/types'

import { Store } from '../store'
import type { SyncEngine, SyncEventListener } from '../sync/syncEngine'
import { FeishuBridgeRuntime } from './runtime'

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class FakeSyncEngine {
    private readonly listeners: Set<SyncEventListener> = new Set()
    private readonly sessions: Map<string, Session> = new Map()
    private readonly messages: Map<string, DecryptedMessage[]> = new Map()

    subscribe(listener: SyncEventListener): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    getSession(sessionId: string): Session | undefined {
        return this.sessions.get(sessionId)
    }

    getMessagesAfter(sessionId: string, options: { afterSeq: number; limit: number }): DecryptedMessage[] {
        return (this.messages.get(sessionId) ?? [])
            .filter((message) => typeof message.seq === 'number' && message.seq > options.afterSeq)
            .slice(0, options.limit)
    }

    setSession(session: Session): void {
        this.sessions.set(session.id, session)
    }

    emit(event: SyncEvent): void {
        for (const listener of this.listeners) {
            listener(event)
        }
    }

    pushMessage(sessionId: string, message: DecryptedMessage): void {
        const existing = this.messages.get(sessionId) ?? []
        existing.push(message)
        this.messages.set(sessionId, existing)
        this.emit({
            type: 'message-received',
            sessionId,
            message
        })
    }
}

function createSession(overrides?: Partial<Session>): Session {
    return {
        id: 'session-1',
        namespace: 'default',
        seq: 1,
        createdAt: 1,
        updatedAt: 1,
        active: true,
        activeAt: 1,
        metadata: {
            path: '/tmp/repo',
            host: 'localhost',
            machineId: 'machine-1',
            name: 'Bridge Session',
            flavor: 'codex'
        },
        metadataVersion: 1,
        agentState: {
            requests: {},
            completedRequests: {}
        },
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        permissionMode: 'default',
        collaborationMode: 'default',
        ...overrides
    }
}

function createAgentTextMessage(seq: number, text: string): DecryptedMessage {
    return {
        id: `message-${seq}`,
        seq,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: {
                    type: 'message',
                    message: text
                }
            },
            meta: {
                sentFrom: 'cli'
            }
        }
    }
}

function createEventMessage(
    seq: number,
    event: Record<string, unknown>
): DecryptedMessage {
    return {
        id: `event-${seq}`,
        seq,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                id: `event-${seq}`,
                type: 'event',
                data: event
            }
        }
    }
}

function createHarness() {
    const store = new Store(':memory:')
    const syncEngine = new FakeSyncEngine()
    const replies: Array<{ messageId: string; text: string }> = []
    let nextReplyId = 1

    const client = {
        replyMessage: async (args: {
            messageId: string
            msgType: string
            content: Record<string, unknown>
        }) => {
            replies.push({
                messageId: args.messageId,
                text: String(args.content.text ?? '')
            })
            const messageId = `om_reply_${nextReplyId}`
            nextReplyId += 1
            return {
                messageId,
                rootId: args.messageId,
                parentId: args.messageId
            }
        }
    }

    const runtime = new FeishuBridgeRuntime({
        namespace: 'default',
        store,
        syncEngine: syncEngine as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
        client: client as never
    })

    return {
        store,
        syncEngine,
        runtime,
        replies
    }
}

describe('FeishuBridgeRuntime', () => {
    it('does not forward assistant text into an idle thread after the last Feishu-owned turn completed', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 52,
            activeTurnSeq: null,
            lastSeenReadyAt: 52
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(53, 'Foreign output should stay out of Feishu'))
        await sleep(5)

        expect(replies).toEqual([])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 52
        })

        runtime.stop()
    })

    it('does not prompt for newly-opened requests in an idle thread with no active Feishu-owned turn', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession({
            collaborationMode: 'plan',
            agentState: {
                requests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            questions: [
                                {
                                    id: 'choice',
                                    question: 'Pick one',
                                    options: ['A', 'B', 'C']
                                }
                            ]
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 52,
            activeTurnSeq: null,
            lastSeenReadyAt: 52
        })

        syncEngine.emit({
            type: 'session-updated',
            sessionId: 'session-1'
        })
        await sleep(5)

        expect(replies).toEqual([])
        expect(store.feishuRequests.getRequest('default', 'session-1', 'question-1')).toBeNull()

        runtime.stop()
    })

    it('forwards assistant text while the thread is in foreground and advances the forwarded cursor', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(1, 'Foreground reply'))
        await sleep(5)

        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Foreground reply'
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 1
        })

        runtime.stop()
    })

    it('suppresses known low-signal assistant preambles while still advancing the forwarded cursor', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(
            1,
            'Using skill: using-superpowers, because startup instructions require skill loading before any normal reply.'
        ))
        syncEngine.pushMessage('session-1', createAgentTextMessage(
            2,
            'Using direct command execution as requested.'
        ))
        syncEngine.pushMessage('session-1', createAgentTextMessage(3, 'Done.'))
        await sleep(5)

        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Done.'
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 3
        })

        runtime.stop()
    })

    it('flushes background backlog and forces foreground return when a ready event arrives', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(1, 'Background result'))
        await sleep(5)
        expect(replies).toEqual([])

        syncEngine.pushMessage('session-1', createEventMessage(2, { type: 'ready' }))
        await sleep(5)

        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Background result'
            },
            {
                messageId: 'root-1',
                text: expect.stringContaining('ready')
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            deliveryMode: 'foreground',
            attention: 'completion',
            lastForwardedSeq: 2,
            activeTurnSeq: null
        })

        runtime.stop()
    })

    it('flushes background assistant output and foregrounds the thread when a failed turn event arrives', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(1, 'Background result'))
        await sleep(5)
        expect(replies).toEqual([])

        syncEngine.pushMessage('session-1', createEventMessage(2, {
            type: 'turn-failed',
            error: 'Codex exploded'
        }))
        await sleep(5)

        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Background result'
            },
            {
                messageId: 'root-1',
                text: 'Task failed: Codex exploded'
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            deliveryMode: 'foreground',
            attention: 'failure',
            lastForwardedSeq: 2,
            activeTurnSeq: null
        })

        runtime.stop()
    })

    it('drains background backlog across multiple pages before advancing the forwarded cursor', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession())
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        for (let index = 1; index <= 205; index += 1) {
            syncEngine.pushMessage('session-1', createAgentTextMessage(index, `Background result ${index}`))
        }
        await sleep(10)
        expect(replies).toHaveLength(0)

        syncEngine.pushMessage('session-1', createEventMessage(206, { type: 'ready' }))
        await sleep(20)

        expect(replies).toHaveLength(206)
        expect(replies[0]?.text).toBe('Background result 1')
        expect(replies[204]?.text).toBe('Background result 205')
        expect(String(replies[205]?.text ?? '')).toContain('ready')
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 206
        })

        runtime.stop()
    })

    it('sends exactly one prompt per new open question and records the prompt message id', async () => {
        const { store, syncEngine, replies, runtime } = createHarness()
        syncEngine.setSession(createSession({
            collaborationMode: 'plan',
            agentState: {
                requests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            questions: [
                                {
                                    id: 'choice',
                                    question: 'Pick one',
                                    options: ['A', 'B', 'C']
                                }
                            ]
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.emit({
            type: 'session-updated',
            sessionId: 'session-1'
        })
        await sleep(5)

        const request = store.feishuRequests.getRequest('default', 'session-1', 'question-1')
        expect(request).not.toBeNull()
        expect(replies).toHaveLength(1)
        expect(replies[0]?.messageId).toBe('root-1')
        expect(String(replies[0]?.text ?? '')).toContain('Pick one')
        expect(String(replies[0]?.text ?? '')).toContain(String(request?.shortToken ?? ''))
        expect(String(replies[0]?.text ?? '')).toContain('/choose')
        expect(request).toMatchObject({
            status: 'open',
            feishuMessageId: 'om_reply_1'
        })

        syncEngine.emit({
            type: 'session-updated',
            sessionId: 'session-1'
        })
        await sleep(5)

        expect(replies).toHaveLength(1)

        runtime.stop()
    })

    it('serializes one Feishu thread even if the canonical session id changes mid-flight', async () => {
        const store = new Store(':memory:')
        const syncEngine = new FakeSyncEngine()
        syncEngine.setSession(createSession({ id: 'session-1' }))
        syncEngine.setSession(createSession({ id: 'session-2' }))

        let replyCount = 0
        let activeReplies = 0
        let maxActiveReplies = 0
        let releaseFirstReply: (() => void) | undefined
        const firstReplyBlocked = new Promise<void>((resolve) => {
            releaseFirstReply = resolve
        })

        const client = {
            replyMessage: async (_args: {
                messageId: string
                msgType: string
                content: Record<string, unknown>
            }) => {
                replyCount += 1
                activeReplies += 1
                maxActiveReplies = Math.max(maxActiveReplies, activeReplies)
                if (replyCount === 1) {
                    await firstReplyBlocked
                }
                activeReplies -= 1
                return {
                    messageId: `om_reply_${replyCount}`,
                    rootId: 'root-1',
                    parentId: 'root-1'
                }
            }
        }

        const runtime = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: client as never
        })

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(1, 'first session output'))
        await sleep(5)

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })
        syncEngine.pushMessage('session-2', createAgentTextMessage(1, 'second session output'))
        await sleep(5)

        expect(maxActiveReplies).toBe(1)

        if (releaseFirstReply) {
            releaseFirstReply()
        }
        await sleep(10)

        runtime.stop()
    })
})
