import { describe, expect, it } from 'bun:test'

import { Store } from '../store'
import { FeishuWebSocketTransport, type FeishuWebSocketSdk } from './websocketTransport'

function createSdkHarness() {
    const handlers = new Map<string, (payload: unknown) => Promise<void> | void>()
    const startCalls: Array<Record<string, unknown>> = []
    let stopCalls = 0

    class FakeEventDispatcher {
        register(nextHandlers: Record<string, (payload: unknown) => Promise<void> | void>) {
            for (const [eventType, handler] of Object.entries(nextHandlers)) {
                handlers.set(eventType, handler)
            }
        }
    }

    class FakeWsClient {
        start(args: Record<string, unknown>) {
            startCalls.push(args)
        }

        stop() {
            stopCalls += 1
        }
    }

    const sdk: FeishuWebSocketSdk = {
        EventDispatcher: FakeEventDispatcher as unknown as FeishuWebSocketSdk['EventDispatcher'],
        WSClient: FakeWsClient as unknown as FeishuWebSocketSdk['WSClient'],
        LoggerLevel: {
            info: 'info'
        }
    }

    return {
        handlers,
        startCalls,
        getStopCalls: () => stopCalls,
        sdkLoader: async () => sdk
    }
}

describe('FeishuWebSocketTransport', () => {
    it('starts long-connection mode, normalizes inbound text messages, and suppresses duplicate message ids', async () => {
        const store = new Store(':memory:')
        const harness = createSdkHarness()
        const seenEvents: Array<Record<string, unknown>> = []
        const transport = new FeishuWebSocketTransport({
            appId: 'cli_test',
            appSecret: 'secret_test',
            store,
            sdkLoader: harness.sdkLoader,
            onMessageEvent: async (event) => {
                seenEvents.push(event)
            }
        })

        await transport.start()

        expect(harness.startCalls).toHaveLength(1)
        const handler = harness.handlers.get('im.message.receive_v1')
        expect(typeof handler).toBe('function')

        await handler?.({
            event_id: 'evt_1',
            sender: {
                sender_id: {
                    open_id: 'ou_123'
                }
            },
            message: {
                chat_id: 'oc_chat_1',
                chat_type: 'p2p',
                message_id: 'om_message_1',
                parent_id: 'om_parent_1',
                root_id: 'om_root_1',
                message_type: 'text',
                content: '{"text":"hello from websocket"}',
                create_time: '1700000001'
            }
        })

        await handler?.({
            event_id: 'evt_2',
            sender: {
                sender_id: {
                    open_id: 'ou_123'
                }
            },
            message: {
                chat_id: 'oc_chat_1',
                chat_type: 'p2p',
                message_id: 'om_message_1',
                parent_id: 'om_parent_1',
                root_id: 'om_root_1',
                message_type: 'text',
                content: '{"text":"hello from websocket"}',
                create_time: '1700000001'
            }
        })

        expect(seenEvents).toEqual([
            {
                eventId: 'evt_1',
                openId: 'ou_123',
                chatId: 'oc_chat_1',
                messageId: 'om_message_1',
                rootMessageId: 'om_root_1',
                parentMessageId: 'om_parent_1',
                threadRootMessageId: 'om_root_1',
                messageType: 'text',
                chatType: 'p2p',
                content: '{"text":"hello from websocket"}',
                createTime: '1700000001'
            }
        ])
    })

    it('falls back to message id for event id and thread root when root id is missing', async () => {
        const store = new Store(':memory:')
        const harness = createSdkHarness()
        const seenEvents: Array<Record<string, unknown>> = []
        const transport = new FeishuWebSocketTransport({
            appId: 'cli_test',
            appSecret: 'secret_test',
            store,
            sdkLoader: harness.sdkLoader,
            onMessageEvent: async (event) => {
                seenEvents.push(event)
            }
        })

        await transport.start()

        const handler = harness.handlers.get('im.message.receive_v1')
        await handler?.({
            sender: {
                sender_id: {
                    open_id: 'ou_123'
                }
            },
            message: {
                chat_id: 'oc_chat_1',
                chat_type: 'p2p',
                message_id: 'om_message_2',
                message_type: 'text',
                content: '{"text":"fallback ids"}'
            }
        })

        expect(seenEvents).toEqual([
            {
                eventId: 'om_message_2',
                openId: 'ou_123',
                chatId: 'oc_chat_1',
                messageId: 'om_message_2',
                rootMessageId: null,
                parentMessageId: null,
                threadRootMessageId: 'om_message_2',
                messageType: 'text',
                chatType: 'p2p',
                content: '{"text":"fallback ids"}',
                createTime: null
            }
        ])
    })

    it('uses parent_id as the thread root when root_id is missing', async () => {
        const store = new Store(':memory:')
        const harness = createSdkHarness()
        const seenEvents: Array<Record<string, unknown>> = []
        const transport = new FeishuWebSocketTransport({
            appId: 'cli_test',
            appSecret: 'secret_test',
            store,
            sdkLoader: harness.sdkLoader,
            onMessageEvent: async (event) => {
                seenEvents.push(event)
            }
        })

        await transport.start()

        const handler = harness.handlers.get('im.message.receive_v1')
        await handler?.({
            sender: {
                sender_id: {
                    open_id: 'ou_123'
                }
            },
            message: {
                chat_id: 'oc_chat_1',
                chat_type: 'p2p',
                message_id: 'om_message_3',
                parent_id: 'om_parent_3',
                message_type: 'text',
                content: '{"text":"reply without root"}'
            }
        })

        expect(seenEvents).toEqual([
            {
                eventId: 'om_message_3',
                openId: 'ou_123',
                chatId: 'oc_chat_1',
                messageId: 'om_message_3',
                rootMessageId: null,
                parentMessageId: 'om_parent_3',
                threadRootMessageId: 'om_parent_3',
                messageType: 'text',
                chatType: 'p2p',
                content: '{"text":"reply without root"}',
                createTime: null
            }
        ])
    })

    it('ignores app-sent websocket messages so bot replies do not loop back into the session', async () => {
        const store = new Store(':memory:')
        const harness = createSdkHarness()
        const seenEvents: Array<Record<string, unknown>> = []
        const transport = new FeishuWebSocketTransport({
            appId: 'cli_test',
            appSecret: 'secret_test',
            store,
            sdkLoader: harness.sdkLoader,
            onMessageEvent: async (event) => {
                seenEvents.push(event)
            }
        })

        await transport.start()

        const handler = harness.handlers.get('im.message.receive_v1')
        await handler?.({
            event_id: 'evt_app_1',
            sender: {
                sender_id: {
                    open_id: 'ou_bot'
                },
                sender_type: 'app'
            },
            message: {
                chat_id: 'oc_chat_1',
                chat_type: 'p2p',
                message_id: 'om_bot_1',
                message_type: 'text',
                content: '{"text":"Forwarded to session session-1."}'
            }
        })

        expect(seenEvents).toEqual([])
    })

    it('stops the websocket client once and ignores repeated stops', async () => {
        const store = new Store(':memory:')
        const harness = createSdkHarness()
        const transport = new FeishuWebSocketTransport({
            appId: 'cli_test',
            appSecret: 'secret_test',
            store,
            sdkLoader: harness.sdkLoader,
            onMessageEvent: async () => {}
        })

        await transport.start()
        transport.stop()
        transport.stop()

        expect(harness.getStopCalls()).toBe(1)
    })
})
