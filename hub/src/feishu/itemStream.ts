import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { DecryptedMessage } from '@hapi/protocol/types'

import type {
    FeishuItemStatus,
    FeishuItemType,
    StoredFeishuItem,
    StoredFeishuThread
} from '../store/types'

export type FeishuItemStreamThread = Pick<StoredFeishuThread, 'activeTurnSeq' | 'reasoningSummary' | 'toolVisibility'>

export type FeishuNormalizedItem = {
    itemKey: string
    itemType: FeishuItemType
    status: FeishuItemStatus
    sourceId?: string | null
}

type CodexPayload =
    | {
        type: 'message'
        message: string
    }
    | {
        type: 'reasoning-delta'
        delta: string
    }
    | {
        type: 'reasoning'
        message: string
    }
    | {
        type: 'tool-call'
        callId: string
    }
    | {
        type: 'tool-call-result'
        callId: string
        is_error?: boolean
        output?: unknown
    }

export class FeishuItemStream {
    private readonly nextIndexByTurnKey = new Map<string, number>()
    private readonly activeReasoningKeyByTurnKey = new Map<string, string>()
    private readonly latestReasoningKeyByTurnKey = new Map<string, string>()
    private readonly toolItemKeyByTurnAndCallId = new Map<string, string>()
    private readonly responseItemKeyByTurnAndSourceId = new Map<string, string>()
    private readonly legacyItemKeysByTurnAndType = new Map<string, string[]>()

    hydrate(items: Array<Pick<StoredFeishuItem, 'itemKey' | 'itemType' | 'status' | 'sourceId'>>): void {
        for (const item of items) {
            const parsed = parseItemKey(item.itemKey)
            if (!parsed) {
                continue
            }

            const currentMaxIndex = this.nextIndexByTurnKey.get(parsed.turnKey) ?? 0
            if (parsed.index > currentMaxIndex) {
                this.nextIndexByTurnKey.set(parsed.turnKey, parsed.index)
            }

            if (item.itemType === 'reasoning') {
                this.latestReasoningKeyByTurnKey.set(parsed.turnKey, item.itemKey)
                if (item.status === 'active') {
                    this.activeReasoningKeyByTurnKey.set(parsed.turnKey, item.itemKey)
                }
            }

            if (item.itemType === 'tool') {
                if (item.sourceId) {
                    this.toolItemKeyByTurnAndCallId.set(
                        getToolOwnershipKey(parsed.turnKey, item.sourceId),
                        item.itemKey
                    )
                } else {
                    this.addLegacyItemKey(parsed.turnKey, 'tool', item.itemKey)
                }
            }

            if (item.itemType === 'response') {
                if (item.sourceId) {
                    this.responseItemKeyByTurnAndSourceId.set(
                        getItemSourceKey(parsed.turnKey, 'response', item.sourceId),
                        item.itemKey
                    )
                } else {
                    this.addLegacyItemKey(parsed.turnKey, 'response', item.itemKey)
                }
            }
        }
    }

    consume(message: DecryptedMessage, thread: FeishuItemStreamThread): FeishuNormalizedItem[] {
        const turnKey = getTurnKey(thread)
        if (!turnKey) {
            return []
        }

        const payload = extractCodexPayload(message)
        if (!payload) {
            return []
        }

        if (payload.type === 'reasoning-delta') {
            if (thread.reasoningSummary === 'none') {
                return []
            }

            const itemKey = this.activeReasoningKeyByTurnKey.get(turnKey)
                ?? this.latestReasoningKeyByTurnKey.get(turnKey)
                ?? this.allocateItemKey(turnKey, 'reasoning')
            this.activeReasoningKeyByTurnKey.set(turnKey, itemKey)
            this.latestReasoningKeyByTurnKey.set(turnKey, itemKey)

            return [{
                itemKey,
                itemType: 'reasoning',
                status: 'active'
            }]
        }

        if (payload.type === 'reasoning') {
            const itemKey = this.activeReasoningKeyByTurnKey.get(turnKey)
                ?? this.latestReasoningKeyByTurnKey.get(turnKey)
            this.activeReasoningKeyByTurnKey.delete(turnKey)

            if (thread.reasoningSummary === 'none' && !itemKey) {
                return []
            }

            const resolvedItemKey = itemKey ?? this.allocateItemKey(turnKey, 'reasoning')
            this.latestReasoningKeyByTurnKey.set(turnKey, resolvedItemKey)

            return [{
                itemKey: resolvedItemKey,
                itemType: 'reasoning',
                status: 'completed'
            }]
        }

        if (payload.type === 'tool-call') {
            if (thread.toolVisibility === 'off') {
                return []
            }

            const ownershipKey = getToolOwnershipKey(turnKey, payload.callId)
            const itemKey = this.toolItemKeyByTurnAndCallId.get(ownershipKey)
                ?? this.takeLegacyItemKey(turnKey, 'tool')
                ?? this.allocateItemKey(turnKey, 'tool')
            this.toolItemKeyByTurnAndCallId.set(ownershipKey, itemKey)

            return [{
                itemKey,
                itemType: 'tool',
                status: 'active',
                sourceId: payload.callId
            }]
        }

        if (payload.type === 'tool-call-result') {
            const ownershipKey = getToolOwnershipKey(turnKey, payload.callId)
            const itemKey = this.toolItemKeyByTurnAndCallId.get(ownershipKey)
                ?? this.takeLegacyItemKey(turnKey, 'tool')

            if (thread.toolVisibility === 'off' && !itemKey) {
                return []
            }

            return [{
                itemKey: itemKey ?? this.allocateItemKey(turnKey, 'tool'),
                itemType: 'tool',
                status: isToolFailure(payload) ? 'failed' : 'completed',
                sourceId: payload.callId
            }]
        }

        if (!payload.message || isLowSignalAssistantText(payload.message)) {
            return []
        }

        const responseSourceId = message.id
        const responseOwnershipKey = getItemSourceKey(turnKey, 'response', responseSourceId)
        const responseItemKey = this.responseItemKeyByTurnAndSourceId.get(responseOwnershipKey)
            ?? this.takeLegacyItemKey(turnKey, 'response')
            ?? this.allocateItemKey(turnKey, 'response')
        this.responseItemKeyByTurnAndSourceId.set(responseOwnershipKey, responseItemKey)

        return [{
            itemKey: responseItemKey,
            itemType: 'response',
            status: 'completed',
            sourceId: responseSourceId
        }]
    }

    private allocateItemKey(
        turnKey: string,
        itemType: Extract<FeishuItemType, 'reasoning' | 'response' | 'tool'>
    ): string {
        const nextIndex = (this.nextIndexByTurnKey.get(turnKey) ?? 0) + 1
        this.nextIndexByTurnKey.set(turnKey, nextIndex)
        return `${turnKey}:${itemType}:${nextIndex}`
    }

    private addLegacyItemKey(
        turnKey: string,
        itemType: Extract<FeishuItemType, 'response' | 'tool'>,
        itemKey: string
    ): void {
        const key = getLegacyReplayKey(turnKey, itemType)
        const itemKeys = this.legacyItemKeysByTurnAndType.get(key) ?? []
        itemKeys.push(itemKey)
        this.legacyItemKeysByTurnAndType.set(key, itemKeys)
    }

    private takeLegacyItemKey(
        turnKey: string,
        itemType: Extract<FeishuItemType, 'response' | 'tool'>
    ): string | null {
        const key = getLegacyReplayKey(turnKey, itemType)
        const itemKeys = this.legacyItemKeysByTurnAndType.get(key)
        if (!itemKeys || itemKeys.length === 0) {
            return null
        }

        const [itemKey, ...rest] = itemKeys
        if (rest.length === 0) {
            this.legacyItemKeysByTurnAndType.delete(key)
        } else {
            this.legacyItemKeysByTurnAndType.set(key, rest)
        }

        return itemKey ?? null
    }
}

function extractCodexPayload(message: DecryptedMessage): CodexPayload | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record || record.role !== 'agent') {
        return null
    }

    const content = asRecord(record.content)
    const payload = asRecord(content?.data)
    if (content?.type !== AGENT_MESSAGE_PAYLOAD_TYPE || !payload) {
        return null
    }

    const type = asString(payload.type)
    if (type === 'message') {
        const text = asString(payload.message)
        return text ? { type, message: text } : null
    }

    if (type === 'reasoning-delta') {
        const delta = asString(payload.delta)
        return delta ? { type, delta } : null
    }

    if (type === 'reasoning') {
        const text = asString(payload.message)
        return text ? { type, message: text } : null
    }

    if (type === 'tool-call') {
        const callId = asString(payload.callId)
        return callId ? { type, callId } : null
    }

    if (type === 'tool-call-result') {
        const callId = asString(payload.callId)
        if (!callId) {
            return null
        }

        return {
            type,
            callId,
            is_error: typeof payload.is_error === 'boolean' ? payload.is_error : undefined,
            output: payload.output
        }
    }

    return null
}

function getTurnKey(thread: FeishuItemStreamThread): string | null {
    return typeof thread.activeTurnSeq === 'number' ? `turn${thread.activeTurnSeq}` : null
}

function parseItemKey(itemKey: string): { turnKey: string; index: number } | null {
    const match = /^([^:]+):[^:]+:(\d+)$/.exec(itemKey)
    if (!match) {
        return null
    }

    const index = Number.parseInt(match[2], 10)
    if (!Number.isFinite(index)) {
        return null
    }

    return {
        turnKey: match[1],
        index
    }
}

function getToolOwnershipKey(turnKey: string, callId: string): string {
    return getItemSourceKey(turnKey, 'tool', callId)
}

function getItemSourceKey(
    turnKey: string,
    itemType: Extract<FeishuItemType, 'response' | 'tool'>,
    sourceId: string
): string {
    return `${turnKey}:${itemType}:${sourceId}`
}

function getLegacyReplayKey(
    turnKey: string,
    itemType: Extract<FeishuItemType, 'response' | 'tool'>
): string {
    return `${turnKey}:${itemType}:legacy`
}

function isToolFailure(payload: Extract<CodexPayload, { type: 'tool-call-result' }>): boolean {
    if (payload.is_error) {
        return true
    }

    const output = asRecord(payload.output)
    const status = asString(output?.status)
    if (status === 'failed' || status === 'error') {
        return true
    }

    return output?.success === false
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

function isLowSignalAssistantText(text: string): boolean {
    const normalized = text.trim().toLowerCase()
    if (normalized.length === 0) {
        return true
    }

    return normalized.startsWith('using skill:')
        || normalized === 'using direct command execution as requested.'
}
