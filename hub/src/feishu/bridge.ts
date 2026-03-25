import type { Session } from '@hapi/protocol/types'

import { getSessionName } from '../notifications/sessionInfo'
import type { Store, StoredFeishuRequest, StoredFeishuThread } from '../store'

type RequestProjection = {
    kind: StoredFeishuRequest['kind']
    decisionScope: StoredFeishuRequest['decisionScope']
    answerShape: StoredFeishuRequest['answerShape']
    requestJson: string
}

export class FeishuBridgeStateSynchronizer {
    constructor(private readonly store: Store) {
    }

    syncSession(binding: StoredFeishuThread, session: Session): {
        binding: StoredFeishuThread
        openRequests: StoredFeishuRequest[]
    } {
        const previousSessionId = binding.sessionId
        const activeSessionId = session.id
        const openRequests = session.agentState?.requests ?? {}
        const completedRequests = session.agentState?.completedRequests ?? {}
        const existingOpen = this.store.feishuRequests.listOpenRequestsForSession(binding.namespace, activeSessionId)
        const previousOpen = previousSessionId !== activeSessionId
            ? this.store.feishuRequests.listOpenRequestsForSession(binding.namespace, previousSessionId)
            : []
        const seenRequestIds = new Set<string>()
        const usedTokens = new Set(
            [...existingOpen, ...previousOpen].map((request) => request.shortToken)
        )

        for (const [requestId, request] of Object.entries(openRequests)) {
            seenRequestIds.add(requestId)
            const existing = this.store.feishuRequests.getRequest(binding.namespace, activeSessionId, requestId)
            const migrated = previousOpen.find((candidate) => candidate.requestId === requestId)
            const shortToken = existing?.shortToken ?? migrated?.shortToken ?? allocateShortToken(requestId, usedTokens)
            usedTokens.add(shortToken)
            const projection = projectRequest(request)

            this.store.feishuRequests.upsertRequest({
                namespace: binding.namespace,
                sessionId: activeSessionId,
                requestId,
                shortToken,
                kind: projection.kind,
                decisionScope: projection.decisionScope,
                answerShape: projection.answerShape,
                feishuMessageId: existing?.feishuMessageId ?? null,
                requestJson: projection.requestJson,
                status: 'open'
            })
        }

        for (const request of existingOpen) {
            if (seenRequestIds.has(request.requestId)) {
                continue
            }

            if (Object.prototype.hasOwnProperty.call(completedRequests, request.requestId)) {
                this.store.feishuRequests.markResolved(binding.namespace, activeSessionId, request.requestId)
            } else {
                this.store.feishuRequests.markStale(binding.namespace, activeSessionId, request.requestId)
            }
        }

        for (const request of previousOpen) {
            if (seenRequestIds.has(request.requestId)) {
                this.store.feishuRequests.markStale(binding.namespace, previousSessionId, request.requestId)
                continue
            }

            if (Object.prototype.hasOwnProperty.call(completedRequests, request.requestId)) {
                this.store.feishuRequests.markResolved(binding.namespace, previousSessionId, request.requestId)
            } else {
                this.store.feishuRequests.markStale(binding.namespace, previousSessionId, request.requestId)
            }
        }

        const refreshedOpen = this.store.feishuRequests.listOpenRequestsForSession(binding.namespace, activeSessionId)
        const nextAttention = deriveAttention(refreshedOpen)
        const nextDeliveryMode = nextAttention === 'none' ? binding.deliveryMode : 'foreground'
        const nextCollaborationMode = session.collaborationMode ?? binding.collaborationMode
        const nextPermissionMode = resolvePermissionMode(session.permissionMode, binding.permissionMode)

        const nextBinding = this.store.feishuThreads.upsertThread({
            namespace: binding.namespace,
            chatId: binding.chatId,
            rootMessageId: binding.rootMessageId,
            sessionId: activeSessionId,
            operatorOpenId: binding.operatorOpenId,
            machineId: session.metadata?.machineId ?? binding.machineId,
            repoPath: session.metadata?.path ?? binding.repoPath,
            sessionName: getSessionName(session),
            model: session.model,
            permissionMode: nextPermissionMode,
            collaborationMode: nextCollaborationMode,
            deliveryMode: nextDeliveryMode,
            reasoningSummary: binding.reasoningSummary,
            toolVisibility: binding.toolVisibility,
            phase: nextCollaborationMode === 'plan' ? 'planning' : 'executing',
            attention: nextAttention,
            lastForwardedSeq: binding.lastForwardedSeq,
            activeTurnSeq: binding.activeTurnSeq,
            lastSeenReadyAt: binding.lastSeenReadyAt
        })

        return {
            binding: nextBinding,
            openRequests: refreshedOpen
        }
    }
}

type OpenAgentRequest = NonNullable<NonNullable<Session['agentState']>['requests']>[string]

function projectRequest(request: OpenAgentRequest): RequestProjection {
    if (request.tool === 'request_user_input') {
        return {
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'nested',
            requestJson: stringifyRequest(request)
        }
    }

    if (request.tool === 'AskUserQuestion') {
        return {
            kind: 'question',
            decisionScope: 'request',
            answerShape: 'flat',
            requestJson: stringifyRequest(request)
        }
    }

    return {
        kind: 'permission',
        decisionScope: 'request',
        answerShape: 'flat',
        requestJson: stringifyRequest(request)
    }
}

function resolvePermissionMode(
    permissionMode: Session['permissionMode'],
    fallback: StoredFeishuThread['permissionMode']
): StoredFeishuThread['permissionMode'] {
    if (
        permissionMode === 'default'
        || permissionMode === 'read-only'
        || permissionMode === 'safe-yolo'
        || permissionMode === 'yolo'
    ) {
        return permissionMode
    }

    return fallback
}

function deriveAttention(openRequests: StoredFeishuRequest[]): StoredFeishuThread['attention'] {
    if (openRequests.some((request) => request.kind === 'question')) {
        return 'question'
    }
    if (openRequests.some((request) => request.kind === 'permission')) {
        return 'approval'
    }
    return 'none'
}

function allocateShortToken(requestId: string, usedTokens: Set<string>): string {
    const normalized = requestId.toUpperCase().replace(/[^A-Z0-9]/g, '') || 'REQ'
    const maxLength = 6
    let token = normalized.slice(0, maxLength)
    let counter = 2

    while (usedTokens.has(token)) {
        const suffix = String(counter)
        token = `${normalized.slice(0, Math.max(1, maxLength - suffix.length))}${suffix}`
        counter += 1
    }

    return token
}

function stringifyRequest(request: unknown): string {
    try {
        return JSON.stringify(request)
    } catch {
        return '{}'
    }
}
