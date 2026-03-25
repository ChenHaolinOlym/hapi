import { describe, expect, it } from 'bun:test'
import { createCipheriv, createHash } from 'node:crypto'
import { Hono } from 'hono'

import { Store } from '../store'
import { createFeishuRoutes } from './routes'
import type { FeishuInboundMessageEvent } from './types'

function encryptPayload(plaintext: string, encryptKey: string): string {
    const iv = Buffer.from('0123456789abcdef')
    const key = createHash('sha256').update(encryptKey).digest()
    const cipher = createCipheriv('aes-256-cbc', key, iv)
    const encrypted = Buffer.concat([
        cipher.update(plaintext, 'utf8'),
        cipher.final()
    ])
    return Buffer.concat([iv, encrypted]).toString('base64')
}

function signBody(rawBody: string, timestamp: string, nonce: string, encryptKey: string): string {
    return createHash('sha256')
        .update(timestamp)
        .update(nonce)
        .update(encryptKey)
        .update(rawBody)
        .digest('hex')
}

function createApp(args?: {
    verificationToken?: string | null
    encryptKey?: string | null
    onMessageEvent?: (event: FeishuInboundMessageEvent) => Promise<void> | void
    onCardActionEvent?: (event: Record<string, unknown>) => Promise<void> | void
}) {
    const store = new Store(':memory:')
    const app = new Hono()
    app.route('/feishu', createFeishuRoutes({
        store,
        config: {
            verificationToken: args?.verificationToken ?? 'verify-token',
            encryptKey: args?.encryptKey ?? 'encrypt-key'
        },
        onMessageEvent: args?.onMessageEvent,
        onCardActionEvent: args?.onCardActionEvent
    } as never))
    return { app, store }
}

describe('Feishu callback routes', () => {
    it('responds to plain url_verification challenges', async () => {
        const { app } = createApp({ encryptKey: null })

        const response = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                type: 'url_verification',
                token: 'verify-token',
                challenge: 'challenge-123'
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            challenge: 'challenge-123'
        })
    })

    it('responds to encrypted url_verification challenges without requiring callback signature headers', async () => {
        const { app } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key'
        })
        const plaintext = JSON.stringify({
            type: 'url_verification',
            token: 'verify-token',
            challenge: 'challenge-abc'
        })

        const response = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                encrypt: encryptPayload(plaintext, 'encrypt-key')
            })
        })

        expect(response.status).toBe(200)
        expect(await response.json()).toEqual({
            challenge: 'challenge-abc'
        })
    })

    it('verifies encrypted callback signatures, normalizes inbound message events, and deduplicates event delivery', async () => {
        const seenEvents: FeishuInboundMessageEvent[] = []
        const { app } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key',
            onMessageEvent: (event) => {
                seenEvents.push(event)
            }
        })

        const plaintext = JSON.stringify({
            schema: '2.0',
            header: {
                event_id: 'evt-1',
                event_type: 'im.message.receive_v1',
                token: 'verify-token',
                create_time: '1700000000'
            },
            event: {
                sender: {
                    sender_id: {
                        open_id: 'ou_123'
                    },
                    sender_type: 'user'
                },
                message: {
                    chat_id: 'oc_chat',
                    chat_type: 'p2p',
                    message_id: 'om_root',
                    parent_id: 'om_root',
                    root_id: 'om_root',
                    message_type: 'text',
                    content: '{"text":"hello"}',
                    create_time: '1700000001'
                }
            }
        })
        const rawBody = JSON.stringify({
            encrypt: encryptPayload(plaintext, 'encrypt-key')
        })
        const timestamp = '1700000002'
        const nonce = 'nonce-1'
        const signature = signBody(rawBody, timestamp, nonce, 'encrypt-key')

        const first = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(first.status).toBe(200)
        expect(await first.text()).toBe('')
        expect(seenEvents).toEqual([
            {
                eventId: 'evt-1',
                openId: 'ou_123',
                chatId: 'oc_chat',
                messageId: 'om_root',
                rootMessageId: 'om_root',
                parentMessageId: 'om_root',
                threadRootMessageId: 'om_root',
                messageType: 'text',
                chatType: 'p2p',
                content: '{"text":"hello"}',
                createTime: '1700000001'
            }
        ])

        const second = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(second.status).toBe(200)
        expect(seenEvents).toHaveLength(1)
    })

    it('uses parent_id as the thread root when root_id is missing', async () => {
        const seenEvents: FeishuInboundMessageEvent[] = []
        const { app } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key',
            onMessageEvent: (event) => {
                seenEvents.push(event)
            }
        })

        const plaintext = JSON.stringify({
            schema: '2.0',
            header: {
                event_id: 'evt-parent-fallback',
                event_type: 'im.message.receive_v1',
                token: 'verify-token',
                create_time: '1700000000'
            },
            event: {
                sender: {
                    sender_id: {
                        open_id: 'ou_123'
                    },
                    sender_type: 'user'
                },
                message: {
                    chat_id: 'oc_chat',
                    chat_type: 'p2p',
                    message_id: 'om_reply',
                    parent_id: 'om_parent',
                    message_type: 'text',
                    content: '{"text":"hello"}',
                    create_time: '1700000001'
                }
            }
        })
        const rawBody = JSON.stringify({
            encrypt: encryptPayload(plaintext, 'encrypt-key')
        })
        const timestamp = '1700000002'
        const nonce = 'nonce-parent-fallback'
        const signature = signBody(rawBody, timestamp, nonce, 'encrypt-key')

        const response = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(response.status).toBe(200)
        expect(seenEvents).toEqual([
            {
                eventId: 'evt-parent-fallback',
                openId: 'ou_123',
                chatId: 'oc_chat',
                messageId: 'om_reply',
                rootMessageId: null,
                parentMessageId: 'om_parent',
                threadRootMessageId: 'om_parent',
                messageType: 'text',
                chatType: 'p2p',
                content: '{"text":"hello"}',
                createTime: '1700000001'
            }
        ])
    })

    it('ignores app-sent callback messages so bot replies do not loop back into the session', async () => {
        const seenEvents: FeishuInboundMessageEvent[] = []
        const { app, store } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key',
            onMessageEvent: (event) => {
                seenEvents.push(event)
            }
        })

        const plaintext = JSON.stringify({
            schema: '2.0',
            header: {
                event_id: 'evt-app-ignore',
                event_type: 'im.message.receive_v1',
                token: 'verify-token',
                create_time: '1700000000'
            },
            event: {
                sender: {
                    sender_id: {
                        open_id: 'ou_bot'
                    },
                    sender_type: 'app'
                },
                message: {
                    chat_id: 'oc_chat',
                    chat_type: 'p2p',
                    message_id: 'om_bot_reply',
                    message_type: 'text',
                    content: '{"text":"Forwarded to session session-1."}',
                    create_time: '1700000001'
                }
            }
        })
        const rawBody = JSON.stringify({
            encrypt: encryptPayload(plaintext, 'encrypt-key')
        })
        const timestamp = '1700000002'
        const nonce = 'nonce-app-ignore'
        const signature = signBody(rawBody, timestamp, nonce, 'encrypt-key')

        const response = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(response.status).toBe(200)
        expect(await response.text()).toBe('')
        expect(seenEvents).toEqual([])
        expect(store.feishuEvents.hasSeen('callback', 'evt-app-ignore')).toBe(true)
    })

    it('rejects encrypted callbacks with invalid signatures', async () => {
        const { app } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key'
        })
        const plaintext = JSON.stringify({
            schema: '2.0',
            header: {
                event_id: 'evt-1',
                event_type: 'im.message.receive_v1',
                token: 'verify-token'
            },
            event: {
                sender: {
                    sender_id: {
                        open_id: 'ou_123'
                    }
                },
                message: {
                    chat_id: 'oc_chat',
                    message_id: 'om_root',
                    message_type: 'text',
                    content: '{"text":"hello"}'
                }
            }
        })
        const rawBody = JSON.stringify({
            encrypt: encryptPayload(plaintext, 'encrypt-key')
        })

        const response = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': '1700000002',
                'x-lark-request-nonce': 'nonce-1',
                'x-lark-signature': 'bad-signature'
            },
            body: rawBody
        })

        expect(response.status).toBe(403)
        expect(await response.json()).toEqual({
            error: 'Invalid Feishu callback signature'
        })
    })

    it('normalizes interactive card callbacks and deduplicates repeated actions', async () => {
        const seenEvents: Array<Record<string, unknown>> = []
        const { app, store } = createApp({
            verificationToken: 'verify-token',
            encryptKey: 'encrypt-key',
            onCardActionEvent: (event) => {
                seenEvents.push(event)
            }
        })

        const plaintext = JSON.stringify({
            schema: '2.0',
            header: {
                event_id: 'evt-card-1',
                event_type: 'card.action.trigger',
                token: 'verify-token',
                create_time: '1700000010'
            },
            event: {
                token: 'c-card-token',
                operator: {
                    operator_id: {
                        open_id: 'ou_123'
                    }
                },
                open_message_id: 'om_card',
                open_chat_id: 'oc_chat',
                action: {
                    value: {
                        kind: 'resolve-request',
                        requestToken: 'ASK1',
                        decision: 'approved'
                    }
                }
            }
        })
        const rawBody = JSON.stringify({
            encrypt: encryptPayload(plaintext, 'encrypt-key')
        })
        const timestamp = '1700000011'
        const nonce = 'nonce-card-1'
        const signature = signBody(rawBody, timestamp, nonce, 'encrypt-key')

        const first = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(first.status).toBe(200)
        expect(await first.text()).toBe('')
        expect(seenEvents).toEqual([
            {
                callbackToken: 'c-card-token',
                openId: 'ou_123',
                messageId: 'om_card',
                chatId: 'oc_chat',
                action: {
                    kind: 'resolve-request',
                    requestToken: 'ASK1',
                    decision: 'approved'
                }
            }
        ])

        const second = await app.request('/feishu/callback', {
            method: 'POST',
            headers: {
                'content-type': 'application/json',
                'x-lark-request-timestamp': timestamp,
                'x-lark-request-nonce': nonce,
                'x-lark-signature': signature
            },
            body: rawBody
        })

        expect(second.status).toBe(200)
        expect(seenEvents).toHaveLength(1)
        expect(store.feishuEvents.hasSeen('card', 'evt-card-1')).toBe(true)
    })
})
