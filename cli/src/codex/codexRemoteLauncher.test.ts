import { afterEach, describe, expect, it, vi } from 'vitest';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import type { EnhancedMode } from './loop';

const harness = {
    notifications: [] as Array<{ method: string; params: unknown }>,
    registerRequestCalls: [] as string[],
    initializeCalls: [] as unknown[],
    appServerRequestHandlers: new Map<string, (params: unknown) => Promise<unknown> | unknown>(),
    startTurnNotifications: null as Array<{ method: string; params: unknown }> | null,
    startTurnCalls: 0,
    startTurnHandler: null as null | ((args: {
        callIndex: number;
        notificationHandler: ((method: string, params: unknown) => void) | null;
    }) => Promise<{ turn: Record<string, never> }>)
};

vi.mock('./codexAppServerClient', () => {
    class MockCodexAppServerClient {
        private notificationHandler: ((method: string, params: unknown) => void) | null = null;

        async connect(): Promise<void> {}

        async initialize(params: unknown): Promise<{ protocolVersion: number }> {
            harness.initializeCalls.push(params);
            return { protocolVersion: 1 };
        }

        setNotificationHandler(handler: ((method: string, params: unknown) => void) | null): void {
            this.notificationHandler = handler;
        }

        registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown): void {
            harness.registerRequestCalls.push(method);
            harness.appServerRequestHandlers.set(method, handler);
        }

        async startThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async resumeThread(): Promise<{ thread: { id: string }; model: string }> {
            return { thread: { id: 'thread-anonymous' }, model: 'gpt-5.4' };
        }

        async startTurn(): Promise<{ turn: Record<string, never> }> {
            const callIndex = ++harness.startTurnCalls;
            if (harness.startTurnHandler) {
                return await harness.startTurnHandler({
                    callIndex,
                    notificationHandler: this.notificationHandler
                });
            }

            const notifications = harness.startTurnNotifications ?? [
                { method: 'turn/started', params: { turn: {} } },
                { method: 'turn/completed', params: { status: 'Completed', turn: {} } }
            ];
            for (const notification of notifications) {
                harness.notifications.push(notification);
                this.notificationHandler?.(notification.method, notification.params);
            }

            return { turn: {} };
        }

        async interruptTurn(): Promise<Record<string, never>> {
            return {};
        }

        async disconnect(): Promise<void> {}
    }

    return { CodexAppServerClient: MockCodexAppServerClient };
});

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

vi.mock('@/configuration', () => ({
    configuration: {
        isRunnerProcess: false,
        logsDir: '/tmp/hapi-codex-remote-launcher-test-logs'
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            stop: () => {}
        },
        mcpServers: {}
    })
}));

import { codexRemoteLauncher } from './codexRemoteLauncher';

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createMode(): EnhancedMode {
    return {
        permissionMode: 'default',
        collaborationMode: 'default'
    };
}

function createSessionStub(
    messages: string[] = ['hello from launcher test'],
    options?: { closeQueue?: boolean }
) {
    const queue = new MessageQueue2<EnhancedMode>((mode) => JSON.stringify(mode));
    for (const message of messages) {
        queue.push(message, createMode());
    }
    if (options?.closeQueue !== false) {
        queue.close();
    }

    const sessionEvents: Array<{ type: string; [key: string]: unknown }> = [];
    const codexMessages: unknown[] = [];
    const thinkingChanges: boolean[] = [];
    const foundSessionIds: string[] = [];
    let currentModel: string | null | undefined;
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => unknown>();
    const client = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        },
        sendAgentMessage(message: unknown) {
            codexMessages.push(message);
        },
        sendUserMessage(_text: string) {},
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            sessionEvents.push(event);
        }
    };

    const session = {
        path: '/tmp/hapi-update',
        logPath: '/tmp/hapi-update/test.log',
        client,
        queue,
        codexArgs: undefined,
        codexCliOverrides: undefined,
        sessionId: null as string | null,
        thinking: false,
        getPermissionMode() {
            return 'default' as const;
        },
        setModel(nextModel: string | null) {
            currentModel = nextModel;
        },
        getModel() {
            return currentModel;
        },
        onThinkingChange(nextThinking: boolean) {
            session.thinking = nextThinking;
            thinkingChanges.push(nextThinking);
        },
        onSessionFound(id: string) {
            session.sessionId = id;
            foundSessionIds.push(id);
        },
        sendAgentMessage(message: unknown) {
            client.sendAgentMessage(message);
        },
        sendSessionEvent(event: { type: string; [key: string]: unknown }) {
            client.sendSessionEvent(event);
        },
        sendUserMessage(text: string) {
            client.sendUserMessage(text);
        }
    };

    return {
        session,
        sessionEvents,
        codexMessages,
        thinkingChanges,
        foundSessionIds,
        rpcHandlers,
        getModel: () => currentModel,
        getAgentState: () => agentState
    };
}

describe('codexRemoteLauncher', () => {
    afterEach(() => {
        harness.notifications = [];
        harness.registerRequestCalls = [];
        harness.initializeCalls = [];
        harness.appServerRequestHandlers.clear();
        harness.startTurnNotifications = null;
        harness.startTurnCalls = 0;
        harness.startTurnHandler = null;
    });

    it('finishes a turn and emits ready when task lifecycle events omit turn_id', async () => {
        const {
            session,
            sessionEvents,
            thinkingChanges,
            foundSessionIds,
            getModel
        } = createSessionStub();

        const exitReason = await codexRemoteLauncher(session as never);

        expect(exitReason).toBe('exit');
        expect(foundSessionIds).toContain('thread-anonymous');
        expect(getModel()).toBe('gpt-5.4');
        expect(harness.initializeCalls).toEqual([{
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        }]);
        expect(harness.notifications.map((entry) => entry.method)).toEqual(['turn/started', 'turn/completed']);
        expect(sessionEvents.filter((event) => event.type === 'ready').length).toBeGreaterThanOrEqual(1);
        expect(thinkingChanges).toContain(true);
        expect(session.thinking).toBe(false);
    });

    it('resolves requestUserInput via the session permission RPC', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub();

        await codexRemoteLauncher(session as never);

        const requestUserInput = harness.appServerRequestHandlers.get('item/tool/requestUserInput');
        expect(requestUserInput).toBeTypeOf('function');

        const resultPromise = Promise.resolve(requestUserInput?.({
            itemId: 'question-1',
            prompt: 'Pick one',
            options: ['A', 'B']
        }));

        expect(getAgentState().requests).toMatchObject({
            'question-1': {
                tool: 'request_user_input'
            }
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'question-1',
            approved: true,
            decision: 'approved',
            answers: {
                choice: {
                    answers: ['A']
                }
            }
        });

        await expect(resultPromise).resolves.toEqual({
            decision: 'accept',
            answers: {
                choice: {
                    answers: ['A']
                }
            }
        });
    });

    it('preserves session-scoped approvals across completed turns', async () => {
        const { session, rpcHandlers, getAgentState } = createSessionStub(
            ['first turn'],
            { closeQueue: false }
        );

        harness.startTurnHandler = async ({ callIndex, notificationHandler }) => {
            const requestApproval = harness.appServerRequestHandlers.get('item/commandExecution/requestApproval');
            expect(requestApproval).toBeTypeOf('function');

            const permissionRpc = rpcHandlers.get('permission');
            expect(permissionRpc).toBeTypeOf('function');

            const requestId = callIndex === 1 ? 'perm-1' : 'perm-2';
            const decisionPromise = Promise.resolve(requestApproval?.({
                itemId: requestId,
                reason: `Write file ${callIndex}`,
                command: ['bash', '-lc', `echo ${callIndex}`],
                cwd: '/tmp/hapi-update'
            }));

            if (callIndex === 1) {
                expect(getAgentState().requests).toMatchObject({
                    'perm-1': {
                        tool: 'CodexBash'
                    }
                });

                await permissionRpc?.({
                    id: 'perm-1',
                    approved: true,
                    decision: 'approved_for_session'
                });

                await expect(decisionPromise).resolves.toEqual({
                    decision: 'acceptForSession'
                });

                session.queue.push('second turn', createMode());
            } else {
                const autoDecision = await Promise.race([
                    decisionPromise,
                    new Promise((resolve) => setTimeout(() => resolve('timed-out'), 25))
                ]);

                if (autoDecision === 'timed-out') {
                    await permissionRpc?.({
                        id: 'perm-2',
                        approved: true,
                        decision: 'approved_for_session'
                    });
                    await decisionPromise;
                }

                expect(autoDecision).toEqual({
                    decision: 'acceptForSession'
                });
                expect(getAgentState().requests).not.toMatchObject({
                    'perm-2': expect.anything()
                });

                session.queue.close();
            }

            const notifications = [
                { method: 'turn/started', params: { turn: { id: `turn-${callIndex}` } } },
                { method: 'turn/completed', params: { status: 'Completed', turn: { id: `turn-${callIndex}` } } }
            ];
            for (const notification of notifications) {
                harness.notifications.push(notification);
                notificationHandler?.(notification.method, notification.params);
            }

            return { turn: { id: `turn-${callIndex}` } as never };
        };

        await expect(codexRemoteLauncher(session as never)).resolves.toBe('exit');

        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexBash',
                decision: 'approved_for_session'
            },
            'perm-2': {
                tool: 'CodexBash',
                decision: 'approved_for_session'
            }
        });
    });

    it('emits request_user_input tool messages with answers and nested item ids', async () => {
        const { session, codexMessages, rpcHandlers } = createSessionStub();

        await codexRemoteLauncher(session as never);

        const requestUserInput = harness.appServerRequestHandlers.get('item/tool/requestUserInput');
        expect(requestUserInput).toBeTypeOf('function');

        const requestPayload = {
            item: { id: 'question-2' },
            questions: [
                {
                    id: 'choice',
                    question: 'Pick one'
                }
            ]
        };

        const resultPromise = Promise.resolve(requestUserInput?.(requestPayload));

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call',
            name: 'request_user_input',
            callId: 'question-2',
            input: requestPayload
        }));

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'question-2',
            approved: true,
            decision: 'approved',
            answers: {
                choice: {
                    answers: ['B']
                }
            }
        });

        await expect(resultPromise).resolves.toEqual({
            decision: 'accept',
            answers: {
                choice: {
                    answers: ['B']
                }
            }
        });

        expect(codexMessages).toContainEqual(expect.objectContaining({
            type: 'tool-call-result',
            callId: 'question-2',
            output: {
                decision: 'approved',
                reason: undefined,
                answers: {
                    choice: {
                        answers: ['B']
                    }
                }
            },
            is_error: false
        }));
    });

    it('emits an explicit turn-failed session event when Codex reports a failed turn', async () => {
        harness.startTurnNotifications = [
            { method: 'turn/started', params: { turn: {} } },
            {
                method: 'turn/completed',
                params: {
                    status: 'failed',
                    error: 'Codex exploded',
                    turn: {}
                }
            }
        ];
        const { session, sessionEvents } = createSessionStub();

        await codexRemoteLauncher(session as never);

        expect(sessionEvents).toContainEqual({
            type: 'turn-failed',
            error: 'Codex exploded'
        });
    });
});
