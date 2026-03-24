import { describe, expect, it, vi } from 'vitest';
import type { ApiSessionClient } from '@/api/apiSession';
import { CodexPermissionHandler } from './permissionHandler';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

type FakeAgentState = {
    requests: Record<string, unknown>;
    completedRequests: Record<string, unknown>;
};

function createHarness(mode: 'default' | 'read-only' | 'safe-yolo' | 'yolo') {
    let agentState: FakeAgentState = {
        requests: {},
        completedRequests: {}
    };

    const rpcHandlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    const session = {
        rpcHandlerManager: {
            registerHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
                rpcHandlers.set(method, handler);
            }
        },
        updateAgentState(handler: (state: FakeAgentState) => FakeAgentState) {
            agentState = handler(agentState);
        }
    } as unknown as ApiSessionClient;

    const handler = new CodexPermissionHandler(session, () => mode);

    return {
        handler,
        rpcHandlers,
        getAgentState: () => agentState
    };
}

describe('CodexPermissionHandler', () => {
    it('auto-approves yolo requests for the session', async () => {
        const { handler, getAgentState } = createHarness('yolo');

        await expect(handler.handleToolCall('perm-1', 'CodexPatch', { grantRoot: '/tmp' })).resolves.toEqual({
            decision: 'approved_for_session'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch',
                status: 'approved',
                decision: 'approved_for_session'
            }
        });
    });

    it('auto-approves safe-yolo requests once', async () => {
        const { handler, getAgentState } = createHarness('safe-yolo');

        await expect(handler.handleToolCall('perm-1', 'CodexBash', { command: 'pwd' })).resolves.toEqual({
            decision: 'approved'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexBash',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('keeps default mode requests pending until a permission RPC arrives', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');
        const resultPromise = handler.handleToolCall('perm-1', 'CodexPatch', { grantRoot: '/tmp' });

        expect(getAgentState().requests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch'
            }
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({ id: 'perm-1', approved: true, decision: 'approved' });

        await expect(resultPromise).resolves.toEqual({
            decision: 'approved',
            reason: undefined
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexPatch',
                status: 'approved',
                decision: 'approved'
            }
        });
    });

    it('remembers session-scoped approvals for later requests of the same tool', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');

        const firstResultPromise = handler.handleToolCall('perm-1', 'CodexBash', { command: 'echo first' });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({ id: 'perm-1', approved: true, decision: 'approved_for_session' });

        await expect(firstResultPromise).resolves.toEqual({
            decision: 'approved_for_session',
            reason: undefined
        });

        const secondResult = Promise.race([
            handler.handleToolCall('perm-2', 'CodexBash', { command: 'echo second' }),
            new Promise((resolve) => setTimeout(() => resolve('timed-out'), 20))
        ]);

        await expect(secondResult).resolves.toEqual({
            decision: 'approved_for_session'
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'perm-1': {
                tool: 'CodexBash',
                status: 'approved',
                decision: 'approved_for_session'
            },
            'perm-2': {
                tool: 'CodexBash',
                status: 'approved',
                decision: 'approved_for_session'
            }
        });
    });

    it('auto-approves read-only non-write tools but not patches', async () => {
        const { handler, getAgentState } = createHarness('read-only');

        await expect(handler.handleToolCall('read-1', 'Read', { file: 'README.md' })).resolves.toEqual({
            decision: 'approved'
        });

        const patchPromise = handler.handleToolCall('patch-1', 'CodexPatch', { grantRoot: '/tmp' });
        expect(getAgentState().requests).toMatchObject({
            'patch-1': {
                tool: 'CodexPatch'
            }
        });

        handler.reset();
        await expect(patchPromise).rejects.toThrow('Session reset');
    });

    it('keeps question requests pending until answers arrive over the permission RPC', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');
        const questionHandler = handler as unknown as {
            handleUserInputRequest?: (id: string, input: unknown) => Promise<unknown>;
        };

        const resultPromise = questionHandler.handleUserInputRequest?.('question-1', {
            prompt: 'Pick one',
            options: ['A', 'B']
        });

        expect(resultPromise).toBeDefined();
        expect(getAgentState().requests).toMatchObject({
            'question-1': {
                tool: 'request_user_input',
                arguments: {
                    prompt: 'Pick one'
                }
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
            decision: 'approved',
            reason: undefined,
            answers: {
                choice: {
                    answers: ['A']
                }
            }
        });

        expect(getAgentState().requests).toEqual({});
        expect(getAgentState().completedRequests).toMatchObject({
            'question-1': {
                tool: 'request_user_input',
                status: 'approved',
                decision: 'approved',
                answers: {
                    choice: {
                        answers: ['A']
                    }
                }
            }
        });
    });

    it('rejects question requests that complete without answers', async () => {
        const { handler, rpcHandlers, getAgentState } = createHarness('default');
        const questionHandler = handler as unknown as {
            handleUserInputRequest?: (id: string, input: unknown) => Promise<unknown>;
        };

        const resultPromise = questionHandler.handleUserInputRequest?.('question-2', {
            prompt: 'Pick one',
            options: ['A', 'B']
        });

        const permissionRpc = rpcHandlers.get('permission');
        expect(permissionRpc).toBeTypeOf('function');

        await permissionRpc?.({
            id: 'question-2',
            approved: true,
            decision: 'approved'
        });

        await expect(resultPromise).resolves.toEqual({
            decision: 'denied',
            reason: 'No answers were provided.'
        });

        expect(getAgentState().completedRequests).toMatchObject({
            'question-2': {
                tool: 'request_user_input',
                status: 'denied',
                decision: 'denied',
                reason: 'No answers were provided.'
            }
        });
    });
});
