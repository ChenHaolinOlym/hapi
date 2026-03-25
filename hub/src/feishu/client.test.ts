import { describe, expect, it } from 'bun:test'

import { FeishuClient } from './client'

type FetchCall = {
    url: string
    init?: RequestInit
}

function parseJsonBody(init?: RequestInit): Record<string, unknown> | null {
    if (typeof init?.body !== 'string') {
        return null
    }

    try {
        return JSON.parse(init.body) as Record<string, unknown>
    } catch {
        return null
    }
}

function createFetchHarness() {
    const calls: FetchCall[] = []
    let tokenCalls = 0

    const fetchFn: typeof fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })

        if (url.endsWith('/auth/v3/tenant_access_token/internal')) {
            tokenCalls += 1
            return new Response(JSON.stringify({
                code: 0,
                msg: 'ok',
                tenant_access_token: `token-${tokenCalls}`,
                expire: 7200
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            })
        }

        if (url.includes('/im/v1/messages?receive_id_type=chat_id')) {
            const body = parseJsonBody(init)
            const msgType = body?.msg_type

            if (msgType === 'interactive') {
                return new Response(JSON.stringify({
                    code: 0,
                    msg: 'ok',
                    data: {
                        message_id: 'om_card_sent',
                        root_id: 'om_card_sent',
                        parent_id: 'om_card_sent'
                    }
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json'
                    }
                })
            }

            return new Response(JSON.stringify({
                code: 0,
                msg: 'ok',
                data: {
                    message_id: 'om_sent',
                    root_id: 'om_sent',
                    parent_id: 'om_sent'
                }
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            })
        }

        if (url.endsWith('/im/v1/messages/om_root/reply')) {
            const body = parseJsonBody(init)
            const msgType = body?.msg_type

            if (msgType === 'interactive') {
                return new Response(JSON.stringify({
                    code: 0,
                    msg: 'ok',
                    data: {
                        message_id: 'om_card_reply',
                        root_id: 'om_root',
                        parent_id: 'om_root'
                    }
                }), {
                    status: 200,
                    headers: {
                        'content-type': 'application/json'
                    }
                })
            }

            return new Response(JSON.stringify({
                code: 0,
                msg: 'ok',
                data: {
                    message_id: 'om_reply',
                    root_id: 'om_root',
                    parent_id: 'om_root'
                }
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            })
        }

        if (url.endsWith('/im/v1/messages/om_card_shared')) {
            return new Response(JSON.stringify({
                code: 0,
                msg: 'ok',
                data: {}
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            })
        }

        if (url.endsWith('/interactive/v1/card/update')) {
            return new Response(JSON.stringify({
                code: 0,
                msg: 'ok'
            }), {
                status: 200,
                headers: {
                    'content-type': 'application/json'
                }
            })
        }

        return new Response('not found', { status: 404 })
    }) as typeof fetch

    return {
        fetchFn,
        calls
    }
}

describe('FeishuClient', () => {
    it('caches tenant access tokens until they near expiry', async () => {
        let now = 1_700_000_000_000
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn,
            now: () => now
        })

        const first = await client.getTenantAccessToken()
        const second = await client.getTenantAccessToken()

        expect(first).toBe('token-1')
        expect(second).toBe('token-1')
        expect(calls.filter((call) => call.url.endsWith('/auth/v3/tenant_access_token/internal'))).toHaveLength(1)

        now += (7200 - 30) * 1000
        const refreshed = await client.getTenantAccessToken()
        expect(refreshed).toBe('token-2')
        expect(calls.filter((call) => call.url.endsWith('/auth/v3/tenant_access_token/internal'))).toHaveLength(2)
    })

    it('sends chat messages with bearer auth and receive_id_type', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const result = await client.sendMessage({
            receiveIdType: 'chat_id',
            receiveId: 'oc_chat',
            msgType: 'text',
            content: {
                text: 'hello'
            }
        })

        const request = calls.find((call) => call.url.includes('/im/v1/messages?receive_id_type=chat_id'))
        expect(request).toBeDefined()
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            receive_id: 'oc_chat',
            msg_type: 'text',
            content: JSON.stringify({
                text: 'hello'
            })
        }))
        expect(result).toEqual({
            messageId: 'om_sent',
            rootId: 'om_sent',
            parentId: 'om_sent'
        })
    })

    it('sends interactive card messages as full card payloads', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const card = {
            config: {
                wide_screen_mode: true
            },
            header: {
                title: {
                    tag: 'plain_text',
                    content: 'Status'
                },
                template: 'blue'
            },
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: 'Card content'
                    }
                }
            ]
        }

        const result = await client.sendCardMessage({
            receiveIdType: 'chat_id',
            receiveId: 'oc_chat',
            card
        })

        const request = calls.find((call) => call.url.includes('/im/v1/messages?receive_id_type=chat_id') && parseJsonBody(call.init)?.msg_type === 'interactive')
        expect(request).toBeDefined()
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            receive_id: 'oc_chat',
            msg_type: 'interactive',
            content: JSON.stringify(card)
        }))
        expect(result).toEqual({
            messageId: 'om_card_sent',
            rootId: 'om_card_sent',
            parentId: 'om_card_sent'
        })
    })

    it('replies to an existing message thread', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const result = await client.replyMessage({
            messageId: 'om_root',
            msgType: 'text',
            content: {
                text: 'reply'
            }
        })

        const request = calls.find((call) => call.url.endsWith('/im/v1/messages/om_root/reply'))
        expect(request).toBeDefined()
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            msg_type: 'text',
            content: JSON.stringify({
                text: 'reply'
            })
        }))
        expect(result).toEqual({
            messageId: 'om_reply',
            rootId: 'om_root',
            parentId: 'om_root'
        })
    })

    it('replies with interactive card payloads', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const card = {
            config: {
                wide_screen_mode: true
            },
            elements: [
                {
                    tag: 'markdown',
                    content: 'Reply card'
                }
            ]
        }

        const result = await client.replyCardMessage({
            messageId: 'om_root',
            card
        })

        const request = calls.find((call) => call.url.endsWith('/im/v1/messages/om_root/reply') && parseJsonBody(call.init)?.msg_type === 'interactive')
        expect(request).toBeDefined()
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            msg_type: 'interactive',
            content: JSON.stringify(card)
        }))
        expect(result).toEqual({
            messageId: 'om_card_reply',
            rootId: 'om_root',
            parentId: 'om_root'
        })
    })

    it('patches a sent card message by message id', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const card = {
            config: {
                update_multi: true
            },
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'plain_text',
                        content: 'Updated'
                    }
                }
            ]
        }

        const result = await client.patchMessageCard({
            messageId: 'om_card_shared',
            card
        })

        const request = calls.find((call) => call.url.endsWith('/im/v1/messages/om_card_shared'))
        expect(request).toBeDefined()
        expect(request?.init?.method).toBe('PATCH')
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            content: JSON.stringify(card)
        }))
        expect(result).toBeUndefined()
    })

    it('uses the delayed update endpoint for interactive card callbacks', async () => {
        const { fetchFn, calls } = createFetchHarness()
        const client = new FeishuClient({
            appId: 'cli_a',
            appSecret: 'cli_s',
            fetchFn
        })

        const card = {
            open_ids: ['ou_requester'],
            elements: [
                {
                    tag: 'div',
                    text: {
                        tag: 'lark_md',
                        content: '**Approved**'
                    }
                }
            ]
        }

        const result = await client.updateInteractiveCard({
            token: 'c-card-token',
            card
        })

        const request = calls.find((call) => call.url.endsWith('/interactive/v1/card/update'))
        expect(request).toBeDefined()
        expect(request?.init?.method).toBe('POST')
        expect(request?.init?.headers).toMatchObject({
            authorization: 'Bearer token-1',
            'content-type': 'application/json; charset=utf-8'
        })
        expect(request?.init?.body).toBe(JSON.stringify({
            token: 'c-card-token',
            card
        }))
        expect(result).toBeUndefined()
    })
})
