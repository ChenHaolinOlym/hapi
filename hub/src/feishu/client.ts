import type {
    FeishuMessageHandle,
    FeishuPatchMessageCardArgs,
    FeishuReplyCardMessageArgs,
    FeishuReplyMessageArgs,
    FeishuSendCardMessageArgs,
    FeishuSendMessageArgs,
    FeishuUpdateInteractiveCardArgs
} from './types'

type FeishuClientOptions = {
    appId: string
    appSecret: string
    baseUrl?: string
    fetchFn?: typeof fetch
    now?: () => number
}

type CachedToken = {
    value: string
    expiresAt: number
}

type FeishuApiEnvelope<T> = {
    code?: number
    msg?: string
    tenant_access_token?: string
    expire?: number
    data?: T
}

export class FeishuClient {
    private readonly appId: string
    private readonly appSecret: string
    private readonly baseUrl: string
    private readonly fetchFn: typeof fetch
    private readonly now: () => number
    private cachedToken: CachedToken | null = null

    constructor(options: FeishuClientOptions) {
        this.appId = options.appId
        this.appSecret = options.appSecret
        this.baseUrl = options.baseUrl ?? 'https://open.feishu.cn/open-apis'
        this.fetchFn = options.fetchFn ?? fetch
        this.now = options.now ?? Date.now
    }

    async getTenantAccessToken(): Promise<string> {
        if (this.cachedToken && this.cachedToken.expiresAt > this.now() + 60_000) {
            return this.cachedToken.value
        }

        const response = await this.fetchFn(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8'
            },
            body: JSON.stringify({
                app_id: this.appId,
                app_secret: this.appSecret
            })
        })

        const json = await response.json() as FeishuApiEnvelope<never>
        if (!response.ok || json.code !== 0 || !json.tenant_access_token || typeof json.expire !== 'number') {
            throw new Error(json.msg || 'Failed to get Feishu tenant access token')
        }

        this.cachedToken = {
            value: json.tenant_access_token,
            expiresAt: this.now() + (json.expire * 1000)
        }

        return json.tenant_access_token
    }

    async sendMessage(args: FeishuSendMessageArgs): Promise<FeishuMessageHandle> {
        const token = await this.getTenantAccessToken()
        const response = await this.fetchFn(
            `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(args.receiveIdType)}`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify({
                    receive_id: args.receiveId,
                    msg_type: args.msgType,
                    content: JSON.stringify(args.content)
                })
            }
        )

        return await parseMessageResponse(response)
    }

    async replyMessage(args: FeishuReplyMessageArgs): Promise<FeishuMessageHandle> {
        const token = await this.getTenantAccessToken()
        const response = await this.fetchFn(
            `${this.baseUrl}/im/v1/messages/${encodeURIComponent(args.messageId)}/reply`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify({
                    msg_type: args.msgType,
                    content: JSON.stringify(args.content)
                })
            }
        )

        return await parseMessageResponse(response)
    }

    async sendCardMessage(args: FeishuSendCardMessageArgs): Promise<FeishuMessageHandle> {
        return await this.sendMessage({
            receiveIdType: args.receiveIdType,
            receiveId: args.receiveId,
            msgType: 'interactive',
            content: args.card
        })
    }

    async replyCardMessage(args: FeishuReplyCardMessageArgs): Promise<FeishuMessageHandle> {
        return await this.replyMessage({
            messageId: args.messageId,
            msgType: 'interactive',
            content: args.card
        })
    }

    async patchMessageCard(args: FeishuPatchMessageCardArgs): Promise<void> {
        const token = await this.getTenantAccessToken()
        const response = await this.fetchFn(
            `${this.baseUrl}/im/v1/messages/${encodeURIComponent(args.messageId)}`,
            {
                method: 'PATCH',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify({
                    content: JSON.stringify(args.card)
                })
            }
        )

        await parseOkResponse(response, 'Failed to patch Feishu message card')
    }

    async updateInteractiveCard(args: FeishuUpdateInteractiveCardArgs): Promise<void> {
        const token = await this.getTenantAccessToken()
        const response = await this.fetchFn(
            `${this.baseUrl}/interactive/v1/card/update`,
            {
                method: 'POST',
                headers: {
                    authorization: `Bearer ${token}`,
                    'content-type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify({
                    token: args.token,
                    card: args.card
                })
            }
        )

        await parseOkResponse(response, 'Failed to update Feishu interactive card')
    }
}

async function parseMessageResponse(response: Response): Promise<FeishuMessageHandle> {
    const json = await parseOkResponse<{
        message_id?: unknown
        root_id?: unknown
        parent_id?: unknown
    }>(response, 'Failed to send Feishu message')

    const messageId = typeof json.data?.message_id === 'string' ? json.data.message_id : null
    if (!messageId) {
        throw new Error('Failed to send Feishu message')
    }

    return {
        messageId,
        rootId: typeof json.data?.root_id === 'string' ? json.data.root_id : null,
        parentId: typeof json.data?.parent_id === 'string' ? json.data.parent_id : null
    }
}

async function parseOkResponse<T>(response: Response, fallbackMessage: string): Promise<FeishuApiEnvelope<T>> {
    const json = await response.json() as FeishuApiEnvelope<T>

    if (!response.ok || json.code !== 0) {
        throw new Error(json.msg || fallbackMessage)
    }

    return json
}
