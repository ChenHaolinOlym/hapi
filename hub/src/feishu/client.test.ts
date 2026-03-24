import { describe, expect, it } from 'bun:test'

import { FeishuClient } from './client'

type FetchCall = {
    url: string
    init?: RequestInit
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
})
