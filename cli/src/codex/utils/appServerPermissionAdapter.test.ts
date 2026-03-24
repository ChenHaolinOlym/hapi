import { describe, expect, it, vi } from 'vitest';

import { registerAppServerPermissionHandlers } from './appServerPermissionAdapter';

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        info: vi.fn(),
        debugLargeJson: vi.fn()
    }
}));

function createHarness() {
    const handlers = new Map<string, (params: unknown) => Promise<unknown> | unknown>();
    const client = {
        registerRequestHandler(method: string, handler: (params: unknown) => Promise<unknown> | unknown) {
            handlers.set(method, handler);
        }
    };
    const permissionHandler = {
        handleToolCall: vi.fn(async () => ({ decision: 'approved' }))
    };

    return {
        client,
        handlers,
        permissionHandler
    };
}

describe('registerAppServerPermissionHandlers', () => {
    it('returns accept with answers for requestUserInput when a callback is registered', async () => {
        const { client, handlers, permissionHandler } = createHarness();

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never,
            onUserInputRequest: async () => ({
                decision: 'approved',
                answers: {
                    choice: {
                        answers: ['A']
                    }
                }
            })
        });

        const handler = handlers.get('item/tool/requestUserInput');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            itemId: 'question-1'
        })).resolves.toEqual({
            decision: 'accept',
            answers: {
                choice: {
                    answers: ['A']
                }
            }
        });
    });

    it('maps structured question decisions back to the app-server protocol', async () => {
        const { client, handlers, permissionHandler } = createHarness();

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never,
            onUserInputRequest: async () => ({
                decision: 'abort',
                reason: 'Need clarification'
            })
        });

        const handler = handlers.get('item/tool/requestUserInput');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            itemId: 'question-1'
        })).resolves.toEqual({
            decision: 'cancel'
        });
    });

    it('cancels requestUserInput when no callback is registered', async () => {
        const { client, handlers, permissionHandler } = createHarness();

        registerAppServerPermissionHandlers({
            client: client as never,
            permissionHandler: permissionHandler as never
        });

        const handler = handlers.get('item/tool/requestUserInput');
        expect(handler).toBeTypeOf('function');

        await expect(handler?.({
            itemId: 'question-1'
        })).resolves.toEqual({
            decision: 'cancel'
        });
    });
});
