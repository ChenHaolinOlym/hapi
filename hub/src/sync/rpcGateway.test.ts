import { describe, expect, it } from 'bun:test'

import { RpcRegistry } from '../socket/rpcRegistry'
import { RpcGateway } from './rpcGateway'

function createGatewayHarness(options?: {
    waitForRegistrationMs?: number
    registrationDelayMs?: number | null
}) {
    const registry = new RpcRegistry()
    const emitCalls: Array<{ method: string; params: string }> = []
    const socket = {
        timeout: (_timeoutMs: number) => ({
            emitWithAck: async (_eventName: string, payload: { method: string; params: string }) => {
                emitCalls.push(payload)
                return JSON.stringify({
                    applied: {
                        permissionMode: 'default',
                        collaborationMode: 'plan'
                    }
                })
            }
        })
    }

    const io = {
        of: (_namespace: string) => ({
            sockets: new Map<string, unknown>([['socket-1', socket]])
        })
    }

    const gateway = new RpcGateway(
        io as never,
        registry,
        {
            registrationWaitMs: options?.waitForRegistrationMs ?? 100
        }
    )

    if (options?.registrationDelayMs !== null) {
        setTimeout(() => {
            registry.register({ id: 'socket-1' } as never, 'session-1:set-session-config')
        }, options?.registrationDelayMs ?? 10)
    }

    return {
        gateway,
        emitCalls
    }
}

describe('RpcGateway requestSessionConfig', () => {
    it('waits briefly for delayed set-session-config registration before invoking the RPC', async () => {
        const { gateway, emitCalls } = createGatewayHarness({
            registrationDelayMs: 10
        })

        await expect(gateway.requestSessionConfig('session-1', {
            permissionMode: 'default',
            collaborationMode: 'plan'
        })).resolves.toEqual({
            applied: {
                permissionMode: 'default',
                collaborationMode: 'plan'
            }
        })

        expect(emitCalls).toEqual([
            {
                method: 'session-1:set-session-config',
                params: JSON.stringify({
                    permissionMode: 'default',
                    collaborationMode: 'plan'
                })
            }
        ])
    })

    it('still fails if set-session-config never registers within the wait window', async () => {
        const { gateway } = createGatewayHarness({
            waitForRegistrationMs: 20,
            registrationDelayMs: null
        })

        await expect(gateway.requestSessionConfig('session-1', {
            permissionMode: 'default'
        })).rejects.toThrow('RPC handler not registered: session-1:set-session-config')
    })
})
