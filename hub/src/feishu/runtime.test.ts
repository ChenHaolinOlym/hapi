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

function createCodexPayloadMessage(seq: number, payload: Record<string, unknown>): DecryptedMessage {
    return {
        id: `codex-${seq}`,
        seq,
        localId: null,
        createdAt: seq,
        content: {
            role: 'agent',
            content: {
                type: AGENT_MESSAGE_PAYLOAD_TYPE,
                data: payload
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
    const cardReplies: Array<{ messageId: string; card: Record<string, unknown> }> = []
    const cardPatches: Array<{ messageId: string; card: Record<string, unknown> }> = []
    let nextReplyId = 1
    let nextCardId = 1

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
        },
        replyCardMessage: async (args: {
            messageId: string
            card: Record<string, unknown>
        }) => {
            cardReplies.push({
                messageId: args.messageId,
                card: args.card
            })
            const messageId = `om_card_${nextCardId}`
            nextCardId += 1
            return {
                messageId,
                rootId: args.messageId,
                parentId: args.messageId
            }
        },
        patchMessageCard: async (args: {
            messageId: string
            card: Record<string, unknown>
        }) => {
            cardPatches.push({
                messageId: args.messageId,
                card: args.card
            })
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
        replies,
        cardReplies,
        cardPatches
    }
}

function summarizeFeishuItems(store: Store, rootMessageId: string) {
    return store.feishuItems
        .listItemsForRootMessage('default', rootMessageId)
        .map((item) => ({
            itemKey: item.itemKey,
            itemType: item.itemType,
            status: item.status
        }))
}

function cardText(card: Record<string, unknown>): string {
    const parts: string[] = []
    const header = (((card.header as Record<string, unknown> | undefined)?.title as Record<string, unknown> | undefined)?.content)
    if (typeof header === 'string') {
        parts.push(header)
    }

    const elements = Array.isArray(card.elements) ? card.elements : []
    for (const element of elements) {
        if (!element || typeof element !== 'object') {
            continue
        }

        const text = (element as { text?: { content?: unknown } }).text
        if (typeof text?.content === 'string') {
            parts.push(text.content)
        }

        const fields = Array.isArray((element as { fields?: Array<{ text?: { content?: unknown } }> }).fields)
            ? (element as { fields: Array<{ text?: { content?: unknown } }> }).fields
            : []
        for (const field of fields) {
            if (typeof field?.text?.content === 'string') {
                parts.push(field.text.content)
            }
        }
    }

    return parts.join('\n')
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

    it('forwards assistant output as a response card while the thread is in foreground and advances the forwarded cursor', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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

        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Foreground reply')
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 1
        })

        runtime.stop()
    })

    it('suppresses known low-signal assistant preambles while still advancing the forwarded cursor', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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

        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Done.')
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 3
        })

        runtime.stop()
    })

    it('flushes background backlog and forces foreground return when a ready event arrives', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
            reasoningSummary: 'none',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 0,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createAgentTextMessage(1, 'Background result'))
        await sleep(5)
        expect(replies).toEqual([])
        expect(cardReplies).toEqual([])

        syncEngine.pushMessage('session-1', createEventMessage(2, { type: 'ready' }))
        await sleep(5)

        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Background result')
        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Session ready for input.'
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            deliveryMode: 'foreground',
            attention: 'completion',
            lastForwardedSeq: 2,
            activeTurnSeq: null,
            reasoningSummary: 'none',
            toolVisibility: 'all'
        })

        runtime.stop()
    })

    it('flushes background assistant output and foregrounds the thread when a failed turn event arrives', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
        expect(cardReplies).toEqual([])

        syncEngine.pushMessage('session-1', createEventMessage(2, {
            type: 'turn-failed',
            error: 'Codex exploded'
        }))
        await sleep(5)

        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Background result')
        expect(replies).toEqual([
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
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
        expect(cardReplies).toHaveLength(0)

        syncEngine.pushMessage('session-1', createEventMessage(206, { type: 'ready' }))
        await sleep(20)

        expect(cardReplies).toHaveLength(205)
        expect(cardText(cardReplies[0]!.card)).toContain('Background result 1')
        expect(cardText(cardReplies[204]!.card)).toContain('Background result 205')
        expect(replies).toEqual([
            {
                messageId: 'root-1',
                text: 'Session ready for input.'
            }
        ])
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            lastForwardedSeq: 206
        })

        runtime.stop()
    })

    it('sends exactly one interactive prompt card per new open question and records the prompt message id', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(1)
        expect(cardReplies[0]?.messageId).toBe('root-1')
        expect(cardText(cardReplies[0]!.card)).toContain('Question needed')
        expect(cardText(cardReplies[0]!.card)).toContain('Pick one')
        expect(cardText(cardReplies[0]!.card)).toContain(String(request?.shortToken ?? ''))
        expect(cardText(cardReplies[0]!.card)).toContain('A. A')
        expect(request).toMatchObject({
            status: 'open',
            feishuMessageId: 'om_card_1'
        })

        syncEngine.emit({
            type: 'session-updated',
            sessionId: 'session-1'
        })
        await sleep(5)

        expect(cardReplies).toHaveLength(1)

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
                return {
                    messageId: 'om_unused_text',
                    rootId: 'root-1',
                    parentId: 'root-1'
                }
            },
            replyCardMessage: async (_args: {
                messageId: string
                card: Record<string, unknown>
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
            },
            patchMessageCard: async (_args: {
                messageId: string
                card: Record<string, unknown>
            }) => {
                replyCount += 1
                activeReplies += 1
                maxActiveReplies = Math.max(maxActiveReplies, activeReplies)
                if (replyCount === 1) {
                    await firstReplyBlocked
                }
                activeReplies -= 1
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

    it('records ordered reasoning tool and response items without coalescing adjacent response blocks', async () => {
        const { store, syncEngine, replies, cardReplies, cardPatches, runtime } = createHarness()
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan '
        }))
        await sleep(5)
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'active' }
        ])

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'reasoning-delta',
            delta: 'step'
        }))
        await sleep(5)
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'active' }
        ])

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(3, {
            type: 'reasoning',
            message: 'Plan step',
            id: 'reasoning-complete'
        }))
        await sleep(5)
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' }
        ])

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(4, {
            type: 'tool-call',
            name: 'bash',
            callId: 'call-1',
            input: {
                command: 'ls'
            },
            id: 'tool-start'
        }))
        await sleep(5)
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'active' }
        ])

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(5, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }))
        await sleep(5)
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' }
        ])

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(6, {
            type: 'message',
            message: 'First response block',
            id: 'response-1'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(7, {
            type: 'message',
            message: 'Second response block',
            id: 'response-2'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' },
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed' },
            { itemKey: 'turn1:response:4', itemType: 'response', status: 'completed' }
        ])
        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(4)
        expect(cardPatches).toHaveLength(3)
        expect(cardText(cardReplies[2]!.card)).toContain('First response block')
        expect(cardText(cardReplies[3]!.card)).toContain('Second response block')

        runtime.stop()
    })

    it('replies with response cards and stores the Feishu message id on the item row', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'message',
            message: 'Card response block',
            id: 'response-1'
        }))
        await sleep(10)

        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Card response block')
        expect(store.feishuItems.getItem('default', 'root-1', 'turn1:response:1')).toMatchObject({
            feishuMessageId: 'om_card_1'
        })

        runtime.stop()
    })

    it('patches an existing active card when a reasoning item completes', async () => {
        const { store, syncEngine, cardReplies, cardPatches, runtime } = createHarness()
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
            reasoningSummary: 'detailed',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan '
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'reasoning',
            message: 'Plan complete',
            id: 'reasoning-complete'
        }))
        await sleep(10)

        expect(cardReplies).toHaveLength(1)
        expect(cardPatches).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Plan')
        expect(cardText(cardPatches[0]!.card)).toContain('Plan complete')
        expect(cardPatches[0]!.messageId).toBe('om_card_1')

        runtime.stop()
    })

    it('applies thread reasoning and tool visibility settings before recording Feishu items', async () => {
        const { store, syncEngine, replies, cardReplies, runtime } = createHarness()
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
            reasoningSummary: 'none',
            toolVisibility: 'off',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'reasoning',
            message: 'Plan done',
            id: 'reasoning-complete'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(3, {
            type: 'tool-call',
            name: 'bash',
            callId: 'call-1',
            input: {
                command: 'ls'
            },
            id: 'tool-start'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(4, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(5, {
            type: 'message',
            message: 'Visible response block',
            id: 'response-1'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:response:1', itemType: 'response', status: 'completed' }
        ])
        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(1)
        expect(cardText(cardReplies[0]!.card)).toContain('Visible response block')

        runtime.stop()
    })

    it('hydrates persisted item-stream state before processing new messages', async () => {
        const store = new Store(':memory:')
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 2,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'turn1:reasoning:1',
            itemType: 'reasoning',
            status: 'completed',
            feishuMessageId: null,
            renderVersion: 1
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'active',
            sourceId: 'call-1',
            feishuMessageId: null,
            renderVersion: 2
        })

        const syncEngine = new FakeSyncEngine()
        syncEngine.setSession(createSession())
        const replies: Array<{ messageId: string; text: string }> = []
        const cardReplies: Array<{ messageId: string; card: Record<string, unknown> }> = []
        let nextReplyId = 1
        let nextCardId = 1
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
            },
            replyCardMessage: async (args: {
                messageId: string
                card: Record<string, unknown>
            }) => {
                cardReplies.push({
                    messageId: args.messageId,
                    card: args.card
                })
                const messageId = `om_card_${nextCardId}`
                nextCardId += 1
                return {
                    messageId,
                    rootId: args.messageId,
                    parentId: args.messageId
                }
            },
            patchMessageCard: async (_args: {
                messageId: string
                card: Record<string, unknown>
            }) => {
            }
        }

        const runtime = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: client as never
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(3, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }))
        syncEngine.pushMessage('session-1', createCodexPayloadMessage(4, {
            type: 'message',
            message: 'Recovered response block',
            id: 'response-1'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' },
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed' }
        ])
        expect(replies).toEqual([])
        expect(cardReplies).toHaveLength(2)
        expect(cardText(cardReplies[1]!.card)).toContain('Recovered response block')

        runtime.stop()
    })

    it('hydrates persisted tool call ownership for multiple active tools before processing results', async () => {
        const store = new Store(':memory:')
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 2,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'turn1:tool:1',
            itemType: 'tool',
            status: 'active',
            sourceId: 'call-a',
            feishuMessageId: null,
            renderVersion: 1
        })
        store.feishuItems.upsertItem({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'active',
            sourceId: 'call-b',
            feishuMessageId: null,
            renderVersion: 2
        })

        const syncEngine = new FakeSyncEngine()
        syncEngine.setSession(createSession())
        const runtime = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: `om_card_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (_args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                }
            } as never
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(3, {
            type: 'tool-call-result',
            callId: 'call-b',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result-b'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:tool:1', itemType: 'tool', status: 'active' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' }
        ])

        runtime.stop()
    })

    it('reuses persisted item keys when completed messages replay after restart', async () => {
        const store = new Store(':memory:')
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 1,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        const syncEngine1 = new FakeSyncEngine()
        syncEngine1.setSession(createSession())
        const runtime1 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine1 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: `om_card_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (_args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                }
            } as never
        })

        const replayMessages = [
            createCodexPayloadMessage(1, {
                type: 'reasoning-delta',
                delta: 'Plan'
            }),
            createCodexPayloadMessage(2, {
                type: 'reasoning',
                message: 'Plan complete',
                id: 'reasoning-complete'
            }),
            createCodexPayloadMessage(3, {
                type: 'tool-call',
                callId: 'call-1',
                name: 'bash',
                input: {
                    command: 'pwd'
                },
                id: 'tool-start'
            }),
            createCodexPayloadMessage(4, {
                type: 'tool-call-result',
                callId: 'call-1',
                output: {
                    stdout: 'ok'
                },
                id: 'tool-result'
            }),
            createCodexPayloadMessage(5, {
                type: 'message',
                message: 'Recovered response block',
                id: 'response-1'
            })
        ]

        for (const message of replayMessages) {
            syncEngine1.pushMessage('session-1', message)
        }
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' },
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed' }
        ])

        runtime1.stop()

        const persistedThread = store.feishuThreads.getThread('default', 'chat-1', 'root-1')
        expect(persistedThread).not.toBeNull()
        store.feishuThreads.upsertThread({
            ...persistedThread!,
            lastForwardedSeq: 0
        })

        const syncEngine2 = new FakeSyncEngine()
        syncEngine2.setSession(createSession())
        const runtime2 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine2 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: `om_card_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (_args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                }
            } as never
        })

        for (const message of replayMessages) {
            syncEngine2.pushMessage('session-1', message)
        }
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' },
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed' },
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed' }
        ])

        runtime2.stop()
    })

    it('restarts item numbering from persisted state when a root thread is deleted and reused in-process', async () => {
        const { store, syncEngine, runtime } = createHarness()
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'message',
            message: 'First response block',
            id: 'response-1'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:response:1', itemType: 'response', status: 'completed' }
        ])

        store.feishuThreads.deleteThread('default', 'chat-1', 'root-1')
        expect(summarizeFeishuItems(store, 'root-1')).toEqual([])

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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: 1,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        syncEngine.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'message',
            message: 'Second response block',
            id: 'response-2'
        }))
        await sleep(10)

        expect(summarizeFeishuItems(store, 'root-1')).toEqual([
            { itemKey: 'turn1:response:1', itemType: 'response', status: 'completed' }
        ])

        runtime.stop()
    })

    it('keeps a completed card frozen when an older active update replays after restart', async () => {
        const store = new Store(':memory:')
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
            reasoningSummary: 'detailed',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        const syncEngine1 = new FakeSyncEngine()
        syncEngine1.setSession(createSession())
        const runtime1 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine1 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: 'om_card_1',
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (_args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                }
            } as never
        })

        syncEngine1.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan '
        }))
        syncEngine1.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'reasoning',
            message: 'Plan complete',
            id: 'reasoning-complete'
        }))
        await sleep(10)
        runtime1.stop()

        const thread = store.feishuThreads.getThread('default', 'chat-1', 'root-1')
        expect(thread).not.toBeNull()
        store.feishuThreads.upsertThread({
            ...thread!,
            lastForwardedSeq: 0
        })

        const replayPatches: Array<{ messageId: string; card: Record<string, unknown> }> = []
        const syncEngine2 = new FakeSyncEngine()
        syncEngine2.setSession(createSession())
        const runtime2 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine2 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: 'om_card_unused',
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                    replayPatches.push({
                        messageId: args.messageId,
                        card: args.card
                    })
                }
            } as never
        })

        syncEngine2.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan '
        }))
        await sleep(10)

        expect(replayPatches).toEqual([])

        runtime2.stop()
    })

    it('preserves tool card details when patching after restart', async () => {
        const store = new Store(':memory:')
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
            reasoningSummary: 'brief',
            toolVisibility: 'all',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: 1,
            lastSeenReadyAt: null
        })

        const syncEngine1 = new FakeSyncEngine()
        syncEngine1.setSession(createSession())
        const runtime1 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine1 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: 'om_card_1',
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (_args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                }
            } as never
        })

        syncEngine1.pushMessage('session-1', createCodexPayloadMessage(1, {
            type: 'tool-call',
            callId: 'call-1',
            name: 'bash',
            input: {
                command: 'pwd'
            },
            id: 'tool-start'
        }))
        await sleep(10)
        runtime1.stop()

        const patchCards: Array<{ messageId: string; card: Record<string, unknown> }> = []
        const syncEngine2 = new FakeSyncEngine()
        syncEngine2.setSession(createSession())
        const runtime2 = new FeishuBridgeRuntime({
            namespace: 'default',
            store,
            syncEngine: syncEngine2 as unknown as Pick<SyncEngine, 'subscribe' | 'getSession' | 'getMessagesAfter'>,
            client: {
                replyMessage: async (args: {
                    messageId: string
                    msgType: string
                    content: Record<string, unknown>
                }) => ({
                    messageId: `om_reply_${args.messageId}`,
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                replyCardMessage: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => ({
                    messageId: 'om_card_unused',
                    rootId: args.messageId,
                    parentId: args.messageId
                }),
                patchMessageCard: async (args: {
                    messageId: string
                    card: Record<string, unknown>
                }) => {
                    patchCards.push({
                        messageId: args.messageId,
                        card: args.card
                    })
                }
            } as never
        })

        syncEngine2.pushMessage('session-1', createCodexPayloadMessage(2, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }))
        await sleep(10)

        expect(patchCards).toHaveLength(1)
        expect(cardText(patchCards[0]!.card)).toContain('bash')
        expect(cardText(patchCards[0]!.card)).toContain('command')
        expect(cardText(patchCards[0]!.card)).toContain('pwd')

        runtime2.stop()
    })
})
