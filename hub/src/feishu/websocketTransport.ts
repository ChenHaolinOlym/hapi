import type { Store } from '../store'
import type { FeishuInboundMessageEvent } from './types'

type FeishuWebSocketEventDispatcher = {
    register: (handlers: Record<string, (payload: unknown) => Promise<void> | void>) => void
}

type FeishuWebSocketClient = {
    start: (args: { eventDispatcher: FeishuWebSocketEventDispatcher }) => void
    stop?: () => void
    close?: () => void
}

export type FeishuWebSocketSdk = {
    EventDispatcher: new (options: Record<string, unknown>) => FeishuWebSocketEventDispatcher
    WSClient: new (options: {
        appId: string
        appSecret: string
        loggerLevel?: unknown
    }) => FeishuWebSocketClient
    LoggerLevel: {
        info: unknown
    }
}

type FeishuWebSocketTransportOptions = {
    appId: string
    appSecret: string
    store: Pick<Store, 'feishuEvents'>
    onMessageEvent: (event: FeishuInboundMessageEvent) => Promise<void> | void
    sdkLoader?: () => Promise<FeishuWebSocketSdk>
}

function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null
    }
    return value as Record<string, unknown>
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

type NormalizedWebSocketMessageEvent =
    | {
        kind: 'event'
        messageId: string
        event: FeishuInboundMessageEvent
    }
    | {
        kind: 'ignore'
        messageId: string
    }
    | {
        kind: 'invalid'
    }

function normalizeFeishuWebSocketMessageEvent(payload: unknown): NormalizedWebSocketMessageEvent {
    const event = asRecord(payload)
    const sender = asRecord(event?.sender)
    const senderId = asRecord(sender?.sender_id)
    const message = asRecord(event?.message)

    const messageId = asString(message?.message_id)
    if (!messageId) {
        return {
            kind: 'invalid'
        }
    }

    if (asString(sender?.sender_type) === 'app') {
        return {
            kind: 'ignore',
            messageId
        }
    }

    const openId = asString(senderId?.open_id)
    const chatId = asString(message?.chat_id)

    if (!openId || !chatId) {
        return {
            kind: 'invalid'
        }
    }

    const rootMessageId = asString(message?.root_id)
    const parentMessageId = asString(message?.parent_id)
    const eventId = asString(event?.event_id) ?? messageId

    return {
        messageId,
        kind: 'event',
        event: {
            eventId,
            openId,
            chatId,
            messageId,
            rootMessageId,
            parentMessageId,
            threadRootMessageId: rootMessageId ?? parentMessageId ?? messageId,
            messageType: asString(message?.message_type) ?? 'unknown',
            chatType: asString(message?.chat_type) ?? 'unknown',
            content: asString(message?.content) ?? '',
            createTime: asString(message?.create_time)
        }
    }
}

async function loadDefaultFeishuWebSocketSdk(): Promise<FeishuWebSocketSdk> {
    return await import('@larksuiteoapi/node-sdk') as unknown as FeishuWebSocketSdk
}

export class FeishuWebSocketTransport {
    private readonly sdkLoader: () => Promise<FeishuWebSocketSdk>
    private wsClient: FeishuWebSocketClient | null = null

    constructor(private readonly options: FeishuWebSocketTransportOptions) {
        this.sdkLoader = options.sdkLoader ?? loadDefaultFeishuWebSocketSdk
    }

    async start(): Promise<void> {
        if (this.wsClient) {
            return
        }

        const sdk = await this.sdkLoader()
        const eventDispatcher = new sdk.EventDispatcher({})
        eventDispatcher.register({
            'im.message.receive_v1': async (payload) => {
                const normalized = normalizeFeishuWebSocketMessageEvent(payload)
                if (normalized.kind === 'invalid') {
                    return
                }

                if (this.options.store.feishuEvents.hasSeen('message', normalized.messageId)) {
                    return
                }

                if (normalized.kind === 'ignore') {
                    this.options.store.feishuEvents.markSeen('message', normalized.messageId)
                    return
                }

                await this.options.onMessageEvent(normalized.event)
                this.options.store.feishuEvents.markSeen('message', normalized.messageId)
            }
        })

        const wsClient = new sdk.WSClient({
            appId: this.options.appId,
            appSecret: this.options.appSecret,
            loggerLevel: sdk.LoggerLevel.info
        })
        wsClient.start({ eventDispatcher })
        this.wsClient = wsClient
    }

    stop(): void {
        if (!this.wsClient) {
            return
        }

        const client = this.wsClient
        this.wsClient = null

        if (typeof client.stop === 'function') {
            client.stop()
            return
        }

        if (typeof client.close === 'function') {
            client.close()
        }
    }
}
