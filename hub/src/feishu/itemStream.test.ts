import { describe, expect, it } from 'bun:test'

import { AGENT_MESSAGE_PAYLOAD_TYPE, type DecryptedMessage } from '@hapi/protocol/types'

import { FeishuItemStream, type FeishuItemStreamThread } from './itemStream'

function createCodexMessage(seq: number, payload: Record<string, unknown>): DecryptedMessage {
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

function createThread(overrides?: Partial<FeishuItemStreamThread>): FeishuItemStreamThread {
    return {
        activeTurnSeq: 1,
        reasoningSummary: 'brief',
        toolVisibility: 'all',
        ...overrides
    }
}

describe('FeishuItemStream', () => {
    it('normalizes reasoning tool and response items in exact append order', () => {
        const stream = new FeishuItemStream()
        const thread = createThread()

        expect(stream.consume(createCodexMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan '
        }), thread)).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'active' }
        ])

        expect(stream.consume(createCodexMessage(2, {
            type: 'reasoning-delta',
            delta: 'step'
        }), thread)).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'active' }
        ])

        expect(stream.consume(createCodexMessage(3, {
            type: 'reasoning',
            message: 'Plan step',
            id: 'reasoning-complete'
        }), thread)).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' }
        ])

        expect(stream.consume(createCodexMessage(4, {
            type: 'tool-call',
            name: 'bash',
            callId: 'call-1',
            input: {
                command: 'ls'
            },
            id: 'tool-start'
        }), thread)).toEqual([
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'active', sourceId: 'call-1' }
        ])

        expect(stream.consume(createCodexMessage(5, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }), thread)).toEqual([
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed', sourceId: 'call-1' }
        ])

        expect(stream.consume(createCodexMessage(6, {
            type: 'message',
            message: 'First response block',
            id: 'response-1'
        }), thread)).toEqual([
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed', sourceId: 'codex-6' }
        ])

        expect(stream.consume(createCodexMessage(7, {
            type: 'message',
            message: 'Second response block',
            id: 'response-2'
        }), thread)).toEqual([
            { itemKey: 'turn1:response:4', itemType: 'response', status: 'completed', sourceId: 'codex-7' }
        ])
    })

    it('applies thread settings and does not allocate hidden reasoning or tool items', () => {
        const stream = new FeishuItemStream()
        const thread = createThread({
            reasoningSummary: 'none',
            toolVisibility: 'off'
        })

        expect(stream.consume(createCodexMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan'
        }), thread)).toEqual([])

        expect(stream.consume(createCodexMessage(2, {
            type: 'reasoning',
            message: 'Plan done',
            id: 'reasoning-complete'
        }), thread)).toEqual([])

        expect(stream.consume(createCodexMessage(3, {
            type: 'tool-call',
            name: 'bash',
            callId: 'call-1',
            input: {
                command: 'ls'
            },
            id: 'tool-start'
        }), thread)).toEqual([])

        expect(stream.consume(createCodexMessage(4, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }), thread)).toEqual([])

        expect(stream.consume(createCodexMessage(5, {
            type: 'message',
            message: 'Visible response block',
            id: 'response-1'
        }), thread)).toEqual([
            { itemKey: 'turn1:response:1', itemType: 'response', status: 'completed', sourceId: 'codex-5' }
        ])
    })

    it('allocates a fresh tool item when a later turn reuses a hydrated call id', () => {
        const stream = new FeishuItemStream()
        stream.hydrate([{
            itemKey: 'turn1:tool:1',
            itemType: 'tool',
            status: 'active',
            sourceId: 'call-1'
        }])

        expect(stream.consume(createCodexMessage(1, {
            type: 'tool-call',
            name: 'bash',
            callId: 'call-1',
            input: {
                command: 'pwd'
            },
            id: 'tool-start-turn-2'
        }), createThread({
            activeTurnSeq: 2
        }))).toEqual([
            { itemKey: 'turn2:tool:1', itemType: 'tool', status: 'active', sourceId: 'call-1' }
        ])
    })

    it('reuses persisted completed item keys when replaying reasoning tool and response messages', () => {
        const stream = new FeishuItemStream()
        stream.hydrate([
            {
                itemKey: 'turn1:reasoning:1',
                itemType: 'reasoning',
                status: 'completed',
                sourceId: null
            },
            {
                itemKey: 'turn1:tool:2',
                itemType: 'tool',
                status: 'completed',
                sourceId: 'call-1'
            },
            {
                itemKey: 'turn1:response:3',
                itemType: 'response',
                status: 'completed',
                sourceId: 'codex-4'
            }
        ])
        const thread = createThread()

        expect(stream.consume(createCodexMessage(1, {
            type: 'reasoning-delta',
            delta: 'Plan'
        }), thread)).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'active' }
        ])

        expect(stream.consume(createCodexMessage(2, {
            type: 'reasoning',
            message: 'Plan complete',
            id: 'reasoning-complete'
        }), thread)).toEqual([
            { itemKey: 'turn1:reasoning:1', itemType: 'reasoning', status: 'completed' }
        ])

        expect(stream.consume(createCodexMessage(3, {
            type: 'tool-call-result',
            callId: 'call-1',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result'
        }), thread)).toEqual([
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed', sourceId: 'call-1' }
        ])

        expect(stream.consume(createCodexMessage(4, {
            type: 'message',
            message: 'Recovered response block',
            id: 'response-1'
        }), thread)).toEqual([
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed', sourceId: 'codex-4' }
        ])
    })

    it('does not attach a hidden tool result to a different visible tool item', () => {
        const stream = new FeishuItemStream()

        expect(stream.consume(createCodexMessage(1, {
            type: 'tool-call',
            callId: 'call-a',
            name: 'bash',
            input: {
                command: 'hidden'
            },
            id: 'tool-start-a'
        }), createThread({
            toolVisibility: 'off'
        }))).toEqual([])

        expect(stream.consume(createCodexMessage(2, {
            type: 'tool-call',
            callId: 'call-b',
            name: 'bash',
            input: {
                command: 'visible'
            },
            id: 'tool-start-b'
        }), createThread({
            toolVisibility: 'all'
        }))).toEqual([
            { itemKey: 'turn1:tool:1', itemType: 'tool', status: 'active', sourceId: 'call-b' }
        ])

        expect(stream.consume(createCodexMessage(3, {
            type: 'tool-call-result',
            callId: 'call-a',
            output: {
                stdout: 'done'
            },
            id: 'tool-result-a'
        }), createThread({
            toolVisibility: 'all'
        }))).toEqual([
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed', sourceId: 'call-a' }
        ])
    })

    it('reuses legacy persisted tool and response items that do not have source ids yet', () => {
        const stream = new FeishuItemStream()
        stream.hydrate([
            {
                itemKey: 'turn1:tool:2',
                itemType: 'tool',
                status: 'completed',
                sourceId: null
            },
            {
                itemKey: 'turn1:response:3',
                itemType: 'response',
                status: 'completed',
                sourceId: null
            }
        ])
        const thread = createThread()

        expect(stream.consume(createCodexMessage(4, {
            type: 'tool-call-result',
            callId: 'legacy-call',
            output: {
                stdout: 'ok'
            },
            id: 'tool-result-legacy'
        }), thread)).toEqual([
            { itemKey: 'turn1:tool:2', itemType: 'tool', status: 'completed', sourceId: 'legacy-call' }
        ])

        expect(stream.consume(createCodexMessage(5, {
            type: 'message',
            message: 'Legacy response replay',
            id: 'response-legacy'
        }), thread)).toEqual([
            { itemKey: 'turn1:response:3', itemType: 'response', status: 'completed', sourceId: 'codex-5' }
        ])
    })
})
