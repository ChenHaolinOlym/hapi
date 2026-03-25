import { Hono } from 'hono'

import type { Store } from '../store'
import { decryptFeishuPayload, verifyFeishuSignature } from './security'
import type { FeishuCardActionEvent, FeishuInboundMessageEvent, FeishuWebhookConfig } from './types'

type CreateFeishuRoutesOptions = {
    store: Store
    config: FeishuWebhookConfig
    onMessageEvent?: (event: FeishuInboundMessageEvent) => Promise<void> | void
    onCardActionEvent?: (event: FeishuCardActionEvent) => Promise<void> | void
}

type ParsedCallbackBody = {
    body: Record<string, unknown>
    isUrlVerification: boolean
}

type CallbackParseError = {
    error: string
    status: 400 | 403 | 503
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

function parseJsonObject(text: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(text) as unknown
        return asRecord(parsed)
    } catch {
        return null
    }
}

function emptyOk(): Response {
    return new Response('', { status: 200 })
}

function extractVerificationToken(body: Record<string, unknown>): string | null {
    return asString(body.token) ?? asString(asRecord(body.header)?.token)
}

function parseIncomingBody(rawBody: string, args: {
    config: FeishuWebhookConfig
    timestamp: string | null
    nonce: string | null
    signature: string | null
}): ParsedCallbackBody | CallbackParseError {
    const outer = parseJsonObject(rawBody)
    if (!outer) {
        return { error: 'Invalid Feishu callback body', status: 400 }
    }

    const encrypted = asString(outer.encrypt)
    if (!encrypted) {
        return {
            body: outer,
            isUrlVerification: outer.type === 'url_verification'
        }
    }

    if (!args.config.encryptKey) {
        return { error: 'Feishu encrypt key is not configured', status: 503 }
    }

    let decrypted: Record<string, unknown> | null = null
    try {
        decrypted = parseJsonObject(decryptFeishuPayload(encrypted, args.config.encryptKey))
    } catch {
        return { error: 'Invalid Feishu encrypted payload', status: 400 }
    }

    if (!decrypted) {
        return { error: 'Invalid Feishu encrypted payload', status: 400 }
    }

    const isUrlVerification = decrypted.type === 'url_verification'
    if (!isUrlVerification) {
        if (!args.timestamp || !args.nonce || !args.signature) {
            return { error: 'Invalid Feishu callback signature', status: 403 }
        }

        const valid = verifyFeishuSignature({
            timestamp: args.timestamp,
            nonce: args.nonce,
            encryptKey: args.config.encryptKey,
            rawBody,
            signature: args.signature
        })
        if (!valid) {
            return { error: 'Invalid Feishu callback signature', status: 403 }
        }
    }

    return {
        body: decrypted,
        isUrlVerification
    }
}

function verifyToken(config: FeishuWebhookConfig, body: Record<string, unknown>): boolean {
    if (!config.verificationToken) {
        return true
    }

    const token = extractVerificationToken(body)
    return token === config.verificationToken
}

type NormalizedCallbackMessageEvent =
    | {
        kind: 'event'
        event: FeishuInboundMessageEvent
    }
    | {
        kind: 'ignore'
    }
    | {
        kind: 'invalid'
    }

type NormalizedCardActionEvent =
    | {
        kind: 'event'
        event: FeishuCardActionEvent
    }
    | {
        kind: 'invalid'
    }

function normalizeMessageEvent(body: Record<string, unknown>): NormalizedCallbackMessageEvent {
    const header = asRecord(body.header)
    const event = asRecord(body.event)
    const sender = asRecord(event?.sender)
    const senderId = asRecord(sender?.sender_id)
    const message = asRecord(event?.message)

    const eventId = asString(header?.event_id)
    const messageId = asString(message?.message_id)
    if (!eventId || !messageId) {
        return {
            kind: 'invalid'
        }
    }

    if (asString(sender?.sender_type) === 'app') {
        return {
            kind: 'ignore'
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

    return {
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

function normalizeCardActionEvent(body: Record<string, unknown>): NormalizedCardActionEvent {
    const event = asRecord(body.event)
    const operator = asRecord(event?.operator)
    const operatorId = asRecord(operator?.operator_id)
    const action = asRecord(event?.action)
    const value = asRecord(action?.value)

    const callbackToken = asString(event?.token)
    const openId = asString(operatorId?.open_id)
    const messageId = asString(event?.open_message_id)
    const chatId = asString(event?.open_chat_id)

    if (!callbackToken || !openId || !messageId || !chatId || !value) {
        return {
            kind: 'invalid'
        }
    }

    return {
        kind: 'event',
        event: {
            callbackToken,
            openId,
            messageId,
            chatId,
            action: value
        }
    }
}

export function createFeishuRoutes(options: CreateFeishuRoutesOptions): Hono {
    const app = new Hono()

    app.post('/callback', async (c) => {
        const rawBody = await c.req.text()
        const parsed = parseIncomingBody(rawBody, {
            config: options.config,
            timestamp: c.req.header('x-lark-request-timestamp') ?? null,
            nonce: c.req.header('x-lark-request-nonce') ?? null,
            signature: c.req.header('x-lark-signature') ?? null
        })

        if ('error' in parsed) {
            return c.json({ error: parsed.error }, parsed.status)
        }

        if (!verifyToken(options.config, parsed.body)) {
            return c.json({ error: 'Invalid Feishu verification token' }, 403)
        }

        if (parsed.isUrlVerification) {
            const challenge = asString(parsed.body.challenge)
            if (!challenge) {
                return c.json({ error: 'Missing Feishu challenge' }, 400)
            }
            return c.json({ challenge })
        }

        const header = asRecord(parsed.body.header)
        const eventId = asString(header?.event_id)
        const eventType = asString(header?.event_type)

        if (!eventId || !eventType) {
            return c.json({ error: 'Invalid Feishu callback event' }, 400)
        }

        const eventSource = eventType === 'card.action.trigger' ? 'card' : 'callback'
        if (options.store.feishuEvents.hasSeen(eventSource, eventId)) {
            return emptyOk()
        }

        if (eventType === 'im.message.receive_v1') {
            const normalizedEvent = normalizeMessageEvent(parsed.body)
            if (normalizedEvent.kind === 'invalid') {
                return c.json({ error: 'Invalid Feishu message event' }, 400)
            }

            if (normalizedEvent.kind === 'event') {
                await options.onMessageEvent?.(normalizedEvent.event)
            }
        }

        if (eventType === 'card.action.trigger') {
            const normalizedEvent = normalizeCardActionEvent(parsed.body)
            if (normalizedEvent.kind === 'invalid') {
                return c.json({ error: 'Invalid Feishu card action event' }, 400)
            }

            await options.onCardActionEvent?.(normalizedEvent.event)
        }

        options.store.feishuEvents.markSeen(eventSource, eventId)
        return emptyOk()
    })

    return app
}
