import { describe, expect, it } from 'bun:test'

import type { Session } from '@hapi/protocol/types'

import { Store } from '../store'
import { FeishuBridgeStateSynchronizer } from './bridge'

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
            name: 'Bridge Session',
            path: '/tmp/repo',
            host: 'localhost',
            flavor: 'codex'
        },
        metadataVersion: 1,
        agentState: null,
        agentStateVersion: 1,
        thinking: false,
        thinkingAt: 1,
        model: 'gpt-5.4',
        permissionMode: 'default',
        collaborationMode: 'default',
        ...overrides
    }
}

describe('FeishuBridgeStateSynchronizer', () => {
    it('forces foreground attention for open question requests and syncs thread session fields', () => {
        const store = new Store(':memory:')
        const synchronizer = new FeishuBridgeStateSynchronizer(store)

        const binding = store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: null,
            model: null,
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            reasoningSummary: 'detailed',
            toolVisibility: 'off',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        const result = synchronizer.syncSession(binding, createSession({
            collaborationMode: 'plan',
            agentState: {
                requests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            prompt: 'Pick one',
                            options: ['A', 'B']
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))

        expect(result.binding).toMatchObject({
            sessionId: 'session-1',
            sessionName: 'Bridge Session',
            model: 'gpt-5.4',
            collaborationMode: 'plan',
            phase: 'planning',
            deliveryMode: 'foreground',
            attention: 'question',
            reasoningSummary: 'detailed',
            toolVisibility: 'off'
        })
        expect(store.feishuThreads.getThread('default', 'chat-1', 'root-1')).toMatchObject({
            reasoningSummary: 'detailed',
            toolVisibility: 'off',
            attention: 'question'
        })

        expect(store.feishuRequests.getRequest('default', 'session-1', 'question-1')).toMatchObject({
            kind: 'question',
            answerShape: 'nested',
            status: 'open'
        })
    })

    it('marks disappeared completed requests as resolved', () => {
        const store = new Store(':memory:')
        const synchronizer = new FeishuBridgeStateSynchronizer(store)

        const binding = store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: null,
            model: null,
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'approval',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        synchronizer.syncSession(binding, createSession({
            agentState: {
                requests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            prompt: 'Pick one'
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))

        const result = synchronizer.syncSession(binding, createSession({
            agentState: {
                requests: {},
                completedRequests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            prompt: 'Pick one'
                        },
                        createdAt: 10,
                        completedAt: 20,
                        status: 'approved',
                        decision: 'approved',
                        answers: {
                            choice: {
                                answers: ['A']
                            }
                        }
                    }
                }
            }
        }))

        expect(result.binding.attention).toBe('none')
        expect(store.feishuRequests.getRequest('default', 'session-1', 'question-1')).toMatchObject({
            status: 'resolved'
        })
    })

    it('marks disappeared incomplete requests as stale', () => {
        const store = new Store(':memory:')
        const synchronizer = new FeishuBridgeStateSynchronizer(store)

        const binding = store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-1',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: null,
            model: null,
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'foreground',
            phase: 'executing',
            attention: 'approval',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        synchronizer.syncSession(binding, createSession({
            agentState: {
                requests: {
                    'perm-1': {
                        tool: 'CodexPatch',
                        arguments: {
                            grantRoot: '/tmp/repo'
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))

        synchronizer.syncSession(binding, createSession({
            agentState: {
                requests: {},
                completedRequests: {}
            }
        }))

        expect(store.feishuRequests.getRequest('default', 'session-1', 'perm-1')).toMatchObject({
            kind: 'permission',
            status: 'stale'
        })
    })

    it('reuses request tokens when a resumed session gets a new canonical session id', () => {
        const store = new Store(':memory:')
        const synchronizer = new FeishuBridgeStateSynchronizer(store)

        const binding = store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'chat-1',
            rootMessageId: 'root-1',
            sessionId: 'session-old',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo',
            sessionName: null,
            model: null,
            permissionMode: 'default',
            collaborationMode: 'default',
            deliveryMode: 'background',
            phase: 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: 'session-old',
            requestId: 'question-1',
            shortToken: 'ASK1',
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'nested',
            feishuMessageId: null,
            requestJson: '{"tool":"request_user_input"}',
            status: 'open'
        })

        synchronizer.syncSession(binding, createSession({
            id: 'session-new',
            agentState: {
                requests: {
                    'question-1': {
                        tool: 'request_user_input',
                        arguments: {
                            prompt: 'Pick one'
                        },
                        createdAt: 10
                    }
                },
                completedRequests: {}
            }
        }))

        expect(store.feishuRequests.getRequest('default', 'session-new', 'question-1')).toMatchObject({
            shortToken: 'ASK1',
            status: 'open'
        })
        expect(store.feishuRequests.getRequest('default', 'session-old', 'question-1')).toMatchObject({
            status: 'stale'
        })
    })
})
