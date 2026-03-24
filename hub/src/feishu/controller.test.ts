import { describe, expect, it } from 'bun:test'

import type { Session } from '@hapi/protocol/types'

import { Store } from '../store'
import { FeishuBridgeController } from './controller'
import type { FeishuInboundMessageEvent } from './types'

function createTextEvent(overrides?: Partial<FeishuInboundMessageEvent>): FeishuInboundMessageEvent {
    return {
        eventId: 'evt-1',
        openId: 'ou_123',
        chatId: 'oc_chat',
        messageId: 'om_root',
        rootMessageId: null,
        parentMessageId: null,
        threadRootMessageId: 'om_root',
        messageType: 'text',
        chatType: 'p2p',
        content: JSON.stringify({ text: '/hapi list' }),
        createTime: '1700000000',
        ...overrides
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

function createHarness(options?: {
    namespace?: string
    operatorOpenId?: string | null
    claimOperatorOpenId?: (openId: string) => Promise<void>
}) {
    const store = new Store(':memory:')
    const replied: Array<{ messageId: string; text: string }> = []
    const namespace = options?.namespace ?? 'default'
    const syncCalls = {
        checkPathsExist: [] as Array<[string, string[]]>,
        spawnSession: [] as Array<unknown[]>,
        waitForSessionActive: [] as Array<string>,
        applySessionConfig: [] as Array<[string, Record<string, unknown>]>,
        renameSession: [] as Array<[string, string]>,
        resumeSession: [] as Array<[string, string]>,
        sendMessage: [] as Array<[string, Record<string, unknown>]>,
        approvePermission: [] as Array<[string, string, unknown[]]>,
        denyPermission: [] as Array<[string, string, unknown[]]>,
        abortSession: [] as Array<string>,
        archiveSession: [] as Array<string>
    }

    const sessionsById = new Map<string, Session>([
        ['session-1', createSession({ namespace })],
        ['session-2', createSession({
            id: 'session-2',
            namespace,
            active: false,
            metadata: {
                path: '/tmp/repo-2',
                host: 'localhost',
                name: 'Bridge Session 2',
                flavor: 'codex'
            }
        })]
    ])

    const insertSessionRow = (session: Session) => {
        const db = (store.sessions as unknown as {
            db: {
                prepare: (sql: string) => {
                    run: (params: Record<string, unknown>) => void
                }
            }
        }).db

        db.prepare(`
            INSERT OR REPLACE INTO sessions (
                id, tag, namespace, machine_id, created_at, updated_at,
                metadata, metadata_version, agent_state, agent_state_version,
                model, todos, todos_updated_at, team_state, team_state_updated_at,
                active, active_at, seq
            ) VALUES (
                @id, NULL, @namespace, NULL, @created_at, @updated_at,
                @metadata, 1, @agent_state, 1,
                @model, NULL, NULL, NULL, NULL,
                @active, @active_at, @seq
            )
        `).run({
            id: session.id,
            namespace: session.namespace,
            created_at: session.createdAt,
            updated_at: session.updatedAt,
            metadata: JSON.stringify(session.metadata),
            agent_state: JSON.stringify(session.agentState),
            model: session.model,
            active: session.active ? 1 : 0,
            active_at: session.activeAt,
            seq: session.seq
        })
    }

    for (const session of sessionsById.values()) {
        insertSessionRow(session)
    }

    const syncEngine = {
        getSessionsByNamespace: () => Array.from(sessionsById.values()),
        resolveSessionAccess: (sessionId: string, namespace: string) => {
            const session = sessionsById.get(sessionId)
            if (!session) {
                return { ok: false, reason: 'not-found' as const }
            }
            if (session.namespace !== namespace) {
                return { ok: false, reason: 'access-denied' as const }
            }
            return { ok: true, sessionId, session }
        },
        getOnlineMachinesByNamespace: () => [{ id: 'machine-1' }],
        checkPathsExist: async (machineId: string, paths: string[]) => {
            syncCalls.checkPathsExist.push([machineId, paths])
            return Object.fromEntries(paths.map((path) => [path, true]))
        },
        spawnSession: async (...args: unknown[]) => {
            syncCalls.spawnSession.push(args)
            const session = createSession({
                id: 'session-new',
                metadata: {
                    path: '/tmp/repo-new',
                    host: 'localhost',
                    name: 'New Session',
                    flavor: 'codex'
                }
            })
            sessionsById.set(session.id, session)
            return { type: 'success' as const, sessionId: session.id }
        },
        waitForSessionActive: async (sessionId: string) => {
            syncCalls.waitForSessionActive.push(sessionId)
            return true
        },
        applySessionConfig: async (sessionId: string, config: Record<string, unknown>) => {
            syncCalls.applySessionConfig.push([sessionId, config])
        },
        renameSession: async (sessionId: string, name: string) => {
            syncCalls.renameSession.push([sessionId, name])
        },
        resumeSession: async (sessionId: string, namespace: string) => {
            syncCalls.resumeSession.push([sessionId, namespace])
            const resumed = createSession({
                id: 'session-2-resumed',
                namespace,
                metadata: {
                    path: '/tmp/repo-2',
                    host: 'localhost',
                    name: 'Bridge Session 2',
                    flavor: 'codex'
                }
            })
            sessionsById.set(resumed.id, resumed)
            insertSessionRow(resumed)
            return { type: 'success' as const, sessionId: resumed.id }
        },
        sendMessage: async (sessionId: string, payload: Record<string, unknown>) => {
            syncCalls.sendMessage.push([sessionId, payload])
            store.messages.addMessage(sessionId, {
                role: 'user',
                content: {
                    type: 'text',
                    text: String(payload.text ?? '')
                },
                meta: {
                    sentFrom: payload.sentFrom ?? 'webapp'
                }
            }, typeof payload.localId === 'string' ? payload.localId : undefined)
        },
        approvePermission: async (sessionId: string, requestId: string, ...rest: unknown[]) => {
            syncCalls.approvePermission.push([sessionId, requestId, rest])
        },
        denyPermission: async (sessionId: string, requestId: string, ...rest: unknown[]) => {
            syncCalls.denyPermission.push([sessionId, requestId, rest])
        },
        abortSession: async (sessionId: string) => {
            syncCalls.abortSession.push(sessionId)
        },
        archiveSession: async (sessionId: string) => {
            syncCalls.archiveSession.push(sessionId)
        }
    }

    const client = {
        replyMessage: async (args: {
            messageId: string
            msgType: string
            content: Record<string, unknown>
        }) => {
            replied.push({
                messageId: args.messageId,
                text: String(args.content.text ?? '')
            })
            return {
                messageId: 'om_reply',
                rootId: args.messageId,
                parentId: args.messageId
            }
        }
    }

    const controller = new FeishuBridgeController({
        namespace,
        operatorOpenId: options?.operatorOpenId ?? null,
        claimOperatorOpenId: options?.claimOperatorOpenId,
        store,
        syncEngine: syncEngine as never,
        client: client as never
    })

    return {
        store,
        controller,
        replied,
        syncCalls
    }
}

describe('FeishuBridgeController', () => {
    it('replies with a simple session list for unbound /hapi list', async () => {
        const { controller, replied } = createHarness()

        await controller.handleMessageEvent(createTextEvent({
            content: JSON.stringify({ text: '/hapi list' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_root',
                text: expect.stringContaining('session-1')
            }
        ])
    })

    it('lists sessions from a bound thread and marks the current one', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi list' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: [
                    'session-1 [active] /tmp/repo (current)',
                    'session-2 [inactive] /tmp/repo-2'
                ].join('\n')
            }
        ])
    })

    it('lists only bound sessions and filters by repo prefix', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_1',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi list bound' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_2',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi list all repo=/tmp/repo-2' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_reply_1',
                text: 'session-1 [active] /tmp/repo (current)'
            },
            {
                messageId: 'om_reply_2',
                text: 'session-2 [inactive] /tmp/repo-2'
            }
        ])
    })

    it('shows session details from a bound thread and marks the current session', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi show session-1' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: [
                    'Session: session-1',
                    'Status: active',
                    'Path: /tmp/repo',
                    'Model: gpt-5.4',
                    'Permission: default',
                    'Collaboration: default',
                    'Current: true'
                ].join('\n')
            }
        ])
    })

    it('shows the current bound session when /hapi show omits the session id', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi show' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: [
                    'Session: session-1',
                    'Status: active',
                    'Path: /tmp/repo',
                    'Model: gpt-5.4',
                    'Permission: default',
                    'Collaboration: default',
                    'Current: true'
                ].join('\n')
            }
        ])
    })

    it('rejects non-p2p chats and unauthorized operators before doing bridge work', async () => {
        const { controller, replied, syncCalls } = createHarness({
            operatorOpenId: 'ou_allowed'
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_group',
            chatType: 'group',
            content: JSON.stringify({ text: '/hapi list' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_other',
            openId: 'ou_other',
            content: JSON.stringify({ text: '/hapi list' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_group',
                text: expect.stringContaining('p2p')
            },
            {
                messageId: 'om_other',
                text: expect.stringContaining('different operator')
            }
        ])
        expect(syncCalls.spawnSession).toHaveLength(0)
        expect(syncCalls.sendMessage).toHaveLength(0)
    })

    it('claims the first p2p sender as operator when none is configured and rejects later senders', async () => {
        const claimedOpenIds: string[] = []
        const { controller, replied } = createHarness({
            claimOperatorOpenId: async (openId: string) => {
                claimedOpenIds.push(openId)
            }
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_first',
            openId: 'ou_first',
            content: JSON.stringify({ text: '/hapi list' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_other',
            openId: 'ou_other',
            content: JSON.stringify({ text: '/hapi list' })
        }))

        expect(claimedOpenIds).toEqual(['ou_first'])
        expect(replied).toEqual([
            {
                messageId: 'om_first',
                text: expect.stringContaining('session-1')
            },
            {
                messageId: 'om_other',
                text: expect.stringContaining('different operator')
            }
        ])
    })

    it('uses the configured namespace instead of default', async () => {
        const { controller, replied } = createHarness({
            namespace: 'ops'
        })

        await controller.handleMessageEvent(createTextEvent({
            content: JSON.stringify({ text: '/hapi list' })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_root',
                text: expect.stringContaining('session-1')
            }
        ])
    })

    it('creates a Codex session from /hapi new and persists the thread binding', async () => {
        const { controller, store, replied, syncCalls } = createHarness()

        await controller.handleMessageEvent(createTextEvent({
            content: JSON.stringify({
                text: '/hapi new repo=/tmp/repo-new model=gpt-5.4 name="Bridge Session" plan perm=safe-yolo'
            })
        }))

        expect(syncCalls.checkPathsExist).toEqual([
            ['machine-1', ['/tmp/repo-new']]
        ])
        expect(syncCalls.spawnSession).toHaveLength(1)
        expect(syncCalls.waitForSessionActive).toEqual(['session-new'])
        expect(syncCalls.applySessionConfig).toEqual([
            ['session-new', { permissionMode: 'safe-yolo', collaborationMode: 'plan' }]
        ])
        expect(syncCalls.renameSession).toEqual([
            ['session-new', 'Bridge Session']
        ])
        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            sessionId: 'session-new',
            repoPath: '/tmp/repo-new',
            model: 'gpt-5.4',
            collaborationMode: 'plan',
            permissionMode: 'safe-yolo'
        })
        expect(replied).toEqual([
            {
                messageId: 'om_root',
                text: expect.stringContaining('session-new')
            }
        ])
    })

    it('attaches the current thread to an existing session via attach and use', async () => {
        const { controller, store, replied } = createHarness()

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_attach',
            content: JSON.stringify({ text: '/hapi attach session-1' })
        }))

        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            sessionId: 'session-1',
            repoPath: '/tmp/repo'
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_use',
            content: JSON.stringify({ text: '/hapi use session-2' })
        }))

        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            sessionId: 'session-2',
            repoPath: '/tmp/repo-2'
        })
        expect(replied).toEqual([
            {
                messageId: 'om_attach',
                text: expect.stringContaining('Attached thread to session session-1')
            },
            {
                messageId: 'om_use',
                text: expect.stringContaining('Attached thread to session session-2')
            }
        ])
    })

    it('unattaches the current thread or all bindings for a session', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_1',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/hapi unattach' })
        }))

        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toBeNull()

        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo-2',
            sessionName: 'Bridge Session 2',
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

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_2',
            content: JSON.stringify({ text: '/hapi unattach session-2' })
        }))

        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toBeNull()
        expect(replied).toEqual([
            {
                messageId: 'om_reply_1',
                text: 'Unattached current thread.'
            },
            {
                messageId: 'om_reply_2',
                text: 'Unattached 1 binding(s) for session session-2.'
            }
        ])
    })

    it('reports unbound thread status with chat metadata', async () => {
        const { controller, replied } = createHarness()

        await controller.handleMessageEvent(createTextEvent({
            content: JSON.stringify({
                text: '/status'
            })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_root',
                text: [
                    'Thread bound: no',
                    'Chat: oc_chat',
                    'Thread root: om_root'
                ].join('\n')
            }
        ])
    })

    it('reports bound thread status with session and cwd details', async () => {
        const { controller, store, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            lastForwardedSeq: 11,
            activeTurnSeq: 12,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({
                text: '/status'
            })
        }))

        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: [
                    'Thread bound: yes',
                    'Session: session-1',
                    'Status: active',
                    'Working dir: /tmp/repo',
                    'Machine: machine-1',
                    'Model: gpt-5.4',
                    'Permission: default',
                    'Thread root: om_root'
                ].join('\n')
            }
        ])
    })

    it('rebinds the current thread when /hapi new is sent from a bound thread', async () => {
        const { controller, store, replied, syncCalls } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({
                text: '/hapi new repo=/tmp/repo-new model=gpt-5.4 name="Bridge Session New"'
            })
        }))

        expect(syncCalls.checkPathsExist).toEqual([
            ['machine-1', ['/tmp/repo-new']]
        ])
        expect(syncCalls.spawnSession).toHaveLength(1)
        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            sessionId: 'session-new',
            repoPath: '/tmp/repo-new',
            sessionName: 'Bridge Session New'
        })
        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: expect.stringContaining('session-new')
            }
        ])
    })

    it('resumes bound sessions and forwards plain text replies with a deterministic local id', async () => {
        const { controller, store, syncCalls, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo-2',
            sessionName: 'Bridge Session 2',
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

        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-2',
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: 'continue with the refactor' })
        }))

        expect(syncCalls.resumeSession).toEqual([
            ['session-2', 'default']
        ])
        expect(syncCalls.sendMessage).toEqual([
            ['session-2-resumed', {
                text: 'continue with the refactor',
                localId: 'feishu:evt-2',
                sentFrom: 'webapp'
            }]
        ])
        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            sessionId: 'session-2-resumed',
            activeTurnSeq: 1,
            lastForwardedSeq: 1
        })
        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: expect.stringContaining('Forwarded')
            }
        ])
    })

    it('falls back to the only bound p2p session in the chat when follow-up messages have no thread metadata', async () => {
        const { controller, store, syncCalls, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
            sessionId: 'session-2',
            operatorOpenId: 'ou_123',
            machineId: 'machine-1',
            repoPath: '/tmp/repo-2',
            sessionName: 'Bridge Session 2',
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

        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-follow-up',
            messageId: 'om_follow_up',
            rootMessageId: null,
            parentMessageId: null,
            threadRootMessageId: 'om_follow_up',
            content: JSON.stringify({ text: 'Read README.md and summarize it in one sentence.' })
        }))

        expect(syncCalls.resumeSession).toEqual([
            ['session-2', 'default']
        ])
        expect(syncCalls.sendMessage).toEqual([
            ['session-2-resumed', {
                text: 'Read README.md and summarize it in one sentence.',
                localId: 'feishu:evt-follow-up',
                sentFrom: 'webapp'
            }]
        ])
        expect(replied).toEqual([
            {
                messageId: 'om_follow_up',
                text: expect.stringContaining('Forwarded')
            }
        ])
    })

    it('approves session-scoped permission requests and resolves them locally', async () => {
        const { controller, store, syncCalls, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            attention: 'approval',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: 'perm-1',
            shortToken: 'ASK1',
            kind: 'permission',
            decisionScope: 'request',
            answerShape: 'flat',
            feishuMessageId: null,
            requestJson: '{"tool":"CodexPatch"}',
            status: 'open'
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/approve r:ASK1 session' })
        }))

        expect(syncCalls.approvePermission).toEqual([
            ['session-1', 'perm-1', [undefined, undefined, 'approved_for_session', undefined]]
        ])
        expect(store.feishuRequests.getRequest('default', 'session-1', 'perm-1')).toMatchObject({
            status: 'resolved'
        })
        expect(replied).toEqual([
            {
                messageId: 'om_reply',
                text: expect.stringContaining('Approved')
            }
        ])
    })

    it('answers nested request_user_input questions from explicit and implicit choices', async () => {
        const { controller, store, syncCalls, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            attention: 'question',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })
        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: 'question-1',
            shortToken: 'ASK1',
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'nested',
            feishuMessageId: null,
            requestJson: JSON.stringify({
                tool: 'request_user_input',
                arguments: {
                    questions: [
                        { id: 'choice', question: 'Pick one' }
                    ]
                }
            }),
            status: 'open'
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_1',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/choose r:ASK1 B' })
        }))

        expect(syncCalls.approvePermission).toEqual([
            ['session-1', 'question-1', [
                undefined,
                undefined,
                'approved',
                {
                    choice: {
                        answers: ['B']
                    }
                }
            ]]
        ])
        expect(store.feishuRequests.getRequest('default', 'session-1', 'question-1')).toMatchObject({
            status: 'resolved'
        })

        store.feishuRequests.upsertRequest({
            namespace: 'default',
            sessionId: 'session-1',
            requestId: 'question-2',
            shortToken: 'ASK2',
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'nested',
            feishuMessageId: null,
            requestJson: JSON.stringify({
                tool: 'request_user_input',
                arguments: {
                    questions: [
                        { id: 'choice', question: 'Pick one' }
                    ]
                }
            }),
            status: 'open'
        })

        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-3',
            messageId: 'om_reply_2',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: 'yes' })
        }))

        expect(syncCalls.approvePermission[1]).toEqual([
            'session-1',
            'question-2',
            [
                undefined,
                undefined,
                'approved',
                {
                    choice: {
                        answers: ['yes']
                    }
                }
            ]
        ])
        expect(replied).toEqual([
            {
                messageId: 'om_reply_1',
                text: expect.stringContaining('Answered')
            },
            {
                messageId: 'om_reply_2',
                text: expect.stringContaining('Answered')
            }
        ])
    })

    it('applies bound-thread mode commands and stop/close control actions', async () => {
        const { controller, store, syncCalls, replied } = createHarness()
        store.feishuThreads.upsertThread({
            namespace: 'default',
            chatId: 'oc_chat',
            rootMessageId: 'om_root',
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
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await controller.handleMessageEvent(createTextEvent({
            messageId: 'om_reply_1',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/perm read-only' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-3',
            messageId: 'om_reply_2',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/bg' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-4',
            messageId: 'om_reply_3',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/stop' })
        }))
        await controller.handleMessageEvent(createTextEvent({
            eventId: 'evt-5',
            messageId: 'om_reply_4',
            threadRootMessageId: 'om_root',
            content: JSON.stringify({ text: '/close' })
        }))

        expect(syncCalls.applySessionConfig).toEqual([
            ['session-1', { permissionMode: 'read-only' }]
        ])
        expect(syncCalls.abortSession).toEqual(['session-1'])
        expect(syncCalls.archiveSession).toEqual(['session-1'])
        expect(store.feishuThreads.getThread('default', 'oc_chat', 'om_root')).toMatchObject({
            permissionMode: 'read-only',
            collaborationMode: 'default'
        })
        expect(replied).toEqual([
            {
                messageId: 'om_reply_1',
                text: expect.stringContaining('Permission mode')
            },
            {
                messageId: 'om_reply_2',
                text: '/bg is not supported in the current Feishu MVP'
            },
            {
                messageId: 'om_reply_3',
                text: expect.stringContaining('Stopped')
            },
            {
                messageId: 'om_reply_4',
                text: expect.stringContaining('Closed')
            }
        ])
    })
})
