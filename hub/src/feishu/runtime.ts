import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { DecryptedMessage, Session, SyncEvent } from '@hapi/protocol/types'

import type { Store, StoredFeishuItem, StoredFeishuRequest, StoredFeishuThread } from '../store'
import type { SyncEngine } from '../sync/syncEngine'
import { renderItemCard } from './cardRenderer'
import type { FeishuClient } from './client'
import { FeishuBridgeStateSynchronizer } from './bridge'
import { FeishuItemStream } from './itemStream'
import type { FeishuItemCardModel, FeishuReasoningSummary, FeishuToolVisibility } from './types'

type FeishuBridgeRuntimeOptions = {
    namespace?: string
    store: Store
    syncEngine: Pick<SyncEngine, 'subscribe' | 'getMessagesAfter' | 'getSession'> & {
        getSessionByNamespace?: (sessionId: string, namespace: string) => Session | undefined
    }
    client: Pick<FeishuClient, 'replyCardMessage' | 'patchMessageCard' | 'replyMessage'>
}

export class FeishuBridgeRuntime {
    private readonly namespace: string
    private readonly synchronizer: FeishuBridgeStateSynchronizer
    private readonly threadTasks = new Map<string, Promise<void>>()
    private readonly itemCardModels = new Map<string, FeishuItemCardModel>()
    private unsubscribe: (() => void) | null = null

    constructor(private readonly options: FeishuBridgeRuntimeOptions) {
        this.namespace = options.namespace ?? 'default'
        this.synchronizer = new FeishuBridgeStateSynchronizer(options.store)
        this.attach()
    }

    attach(): () => void {
        if (this.unsubscribe) {
            return this.unsubscribe
        }

        this.unsubscribe = this.options.syncEngine.subscribe((event) => {
            void this.handleSyncEvent(event)
        })

        return this.unsubscribe
    }

    stop(): void {
        this.unsubscribe?.()
        this.unsubscribe = null
        this.threadTasks.clear()
        this.itemCardModels.clear()
    }

    async handleSyncEvent(event: SyncEvent): Promise<void> {
        if (event.namespace && event.namespace !== this.namespace) {
            return
        }

        if (!('sessionId' in event) || typeof event.sessionId !== 'string') {
            return
        }

        const binding = this.options.store.feishuThreads.getThreadBySessionId(this.namespace, event.sessionId)
        if (!binding) {
            return
        }

        await this.enqueueThreadTask(binding, async () => {
            const currentBinding = this.options.store.feishuThreads.getThread(
                binding.namespace,
                binding.chatId,
                binding.rootMessageId
            )
            if (!currentBinding || currentBinding.sessionId !== event.sessionId) {
                return
            }

            if (event.type === 'session-added' || event.type === 'session-updated') {
                if (currentBinding.activeTurnSeq === null) {
                    return
                }
                await this.handleSessionChanged(currentBinding.sessionId)
                return
            }

            if (event.type === 'message-received') {
                if (currentBinding.activeTurnSeq === null) {
                    return
                }
                await this.handleMessageReceived(currentBinding.sessionId, event.message)
            }
        })
    }

    private async enqueueThreadTask(binding: StoredFeishuThread, task: () => Promise<void>): Promise<void> {
        const threadKey = getThreadTaskKey(binding)
        const previous = this.threadTasks.get(threadKey) ?? Promise.resolve()
        const next = previous
            .catch(() => {})
            .then(task)
            .finally(() => {
                if (this.threadTasks.get(threadKey) === next) {
                    this.threadTasks.delete(threadKey)
                }
            })

        this.threadTasks.set(threadKey, next)
        await next
    }

    private async handleSessionChanged(sessionId: string): Promise<void> {
        const binding = this.options.store.feishuThreads.getThreadBySessionId(this.namespace, sessionId)
        if (!binding) {
            return
        }

        const session = this.resolveSession(sessionId)
        if (!session) {
            return
        }

        const sync = this.synchronizer.syncSession(binding, session)
        for (const request of sync.openRequests) {
            if (request.feishuMessageId) {
                continue
            }

            const reply = await this.options.client.replyCardMessage({
                messageId: sync.binding.rootMessageId,
                card: renderOpenRequestCard(request)
            })
            this.options.store.feishuRequests.upsertRequest({
                namespace: request.namespace,
                sessionId: request.sessionId,
                requestId: request.requestId,
                shortToken: request.shortToken,
                kind: request.kind,
                decisionScope: request.decisionScope,
                answerShape: request.answerShape,
                feishuMessageId: reply.messageId,
                requestJson: request.requestJson,
                status: request.status
            })
        }
    }

    private async handleMessageReceived(sessionId: string, message: DecryptedMessage): Promise<void> {
        const binding = this.options.store.feishuThreads.getThreadBySessionId(this.namespace, sessionId)
        if (!binding) {
            return
        }

        const messageSeq = typeof message.seq === 'number' ? message.seq : null
        if (messageSeq !== null && binding.lastForwardedSeq !== null && messageSeq <= binding.lastForwardedSeq) {
            return
        }

        if (isReadyEventMessage(message)) {
            await this.handleReadyEvent(binding, message)
            return
        }

        const failureText = extractTurnFailureText(message)
        if (failureText) {
            const forwardedSeq = await this.forwardBufferedAssistantMessages(binding)
            await this.replyText(binding.rootMessageId, failureText)
            this.updateBinding(binding, {
                deliveryMode: 'foreground',
                attention: 'failure',
                lastForwardedSeq: forwardedSeq ?? messageSeq ?? binding.lastForwardedSeq,
                activeTurnSeq: null
            })
            return
        }

        if (binding.deliveryMode !== 'foreground') {
            return
        }

        const forwardedSeq = await this.forwardBufferedAssistantMessages(binding)
        this.updateBinding(binding, {
            attention: 'none',
            lastForwardedSeq: forwardedSeq
        })
    }

    private async handleReadyEvent(binding: StoredFeishuThread, message: DecryptedMessage): Promise<void> {
        const messageSeq = typeof message.seq === 'number' ? message.seq : binding.lastForwardedSeq
        const readyAt = message.createdAt

        if (binding.deliveryMode !== 'background') {
            const forwardedSeq = await this.forwardBufferedAssistantMessages(binding)
            this.updateBinding(binding, {
                lastForwardedSeq: forwardedSeq ?? messageSeq,
                activeTurnSeq: null,
                lastSeenReadyAt: readyAt
            })
            return
        }

        const highestSeq = await this.forwardBufferedAssistantMessages(binding)
        await this.replyText(binding.rootMessageId, 'Session ready for input.')
        this.updateBinding(binding, {
            deliveryMode: 'foreground',
            attention: 'completion',
            lastForwardedSeq: highestSeq ?? messageSeq,
            activeTurnSeq: null,
            lastSeenReadyAt: readyAt
        })
    }

    private resolveSession(sessionId: string): Session | undefined {
        const byNamespace = this.options.syncEngine.getSessionByNamespace?.(sessionId, this.namespace)
        if (byNamespace) {
            return byNamespace
        }

        const session = this.options.syncEngine.getSession(sessionId)
        if (!session || session.namespace !== this.namespace) {
            return undefined
        }

        return session
    }

    private updateBinding(binding: StoredFeishuThread, updates: Partial<StoredFeishuThread>): StoredFeishuThread {
        const activeTurnSeq = Object.prototype.hasOwnProperty.call(updates, 'activeTurnSeq')
            ? updates.activeTurnSeq ?? null
            : binding.activeTurnSeq

        return this.options.store.feishuThreads.upsertThread({
            namespace: binding.namespace,
            chatId: binding.chatId,
            rootMessageId: binding.rootMessageId,
            sessionId: updates.sessionId ?? binding.sessionId,
            operatorOpenId: updates.operatorOpenId ?? binding.operatorOpenId,
            machineId: updates.machineId ?? binding.machineId,
            repoPath: updates.repoPath ?? binding.repoPath,
            sessionName: updates.sessionName ?? binding.sessionName,
            model: updates.model ?? binding.model,
            permissionMode: updates.permissionMode ?? binding.permissionMode,
            collaborationMode: updates.collaborationMode ?? binding.collaborationMode,
            deliveryMode: updates.deliveryMode ?? binding.deliveryMode,
            reasoningSummary: updates.reasoningSummary ?? binding.reasoningSummary,
            toolVisibility: updates.toolVisibility ?? binding.toolVisibility,
            phase: updates.phase ?? binding.phase,
            attention: updates.attention ?? binding.attention,
            lastForwardedSeq: updates.lastForwardedSeq ?? binding.lastForwardedSeq,
            activeTurnSeq,
            lastSeenReadyAt: updates.lastSeenReadyAt ?? binding.lastSeenReadyAt
        })
    }

    private async replyText(messageId: string, text: string): Promise<{
        messageId: string
        rootId: string | null
        parentId: string | null
    }> {
        return await this.options.client.replyMessage({
            messageId,
            msgType: 'text',
            content: {
                text
            }
        })
    }

    private async forwardBufferedAssistantMessages(
        binding: StoredFeishuThread
    ): Promise<number | null> {
        let cursor = binding.lastForwardedSeq ?? 0
        let highestSeq = binding.lastForwardedSeq

        while (true) {
            const messages = this.options.syncEngine.getMessagesAfter(binding.sessionId, {
                afterSeq: cursor,
                limit: 200
            })
            if (messages.length === 0) {
                return highestSeq
            }

            let pageMaxSeq = cursor
            for (const candidate of messages) {
                if (typeof candidate.seq === 'number' && candidate.seq > pageMaxSeq) {
                    pageMaxSeq = candidate.seq
                }

                const deliveredItem = await this.recordFeishuItems(binding, candidate)
                if (deliveredItem) {
                    continue
                }

                const assistantText = extractAssistantText(candidate)
                if (!assistantText) {
                    continue
                }

                await this.replyText(binding.rootMessageId, assistantText)
            }

            if (pageMaxSeq <= cursor) {
                return highestSeq
            }

            cursor = pageMaxSeq
            highestSeq = pageMaxSeq

            if (messages.length < 200) {
                return highestSeq
            }
        }
    }

    private async recordFeishuItems(binding: StoredFeishuThread, message: DecryptedMessage): Promise<boolean> {
        const itemStream = this.getItemStream(binding)
        const items = itemStream.consume(message, {
            activeTurnSeq: binding.activeTurnSeq,
            reasoningSummary: binding.reasoningSummary,
            toolVisibility: binding.toolVisibility
        })
        if (items.length === 0) {
            return false
        }

        const baseRenderVersion = getMessageRenderVersion(message)
        for (const [index, item] of items.entries()) {
            const existing = this.options.store.feishuItems.getItem(binding.namespace, binding.rootMessageId, item.itemKey)
            if (existing && isTerminalItemStatus(existing.status) && isStatusRegression(existing.status, item.status)) {
                const persistedModel = this.getPersistedItemCardModel(binding, item.itemKey, existing)
                if (persistedModel) {
                    this.itemCardModels.set(getItemRenderKey(binding, item.itemKey), persistedModel)
                }
                continue
            }

            const stored = this.options.store.feishuItems.upsertItem({
                namespace: binding.namespace,
                chatId: binding.chatId,
                rootMessageId: binding.rootMessageId,
                sessionId: binding.sessionId,
                itemKey: item.itemKey,
                itemType: item.itemType,
                status: item.status,
                sourceId: item.sourceId ?? existing?.sourceId ?? null,
                feishuMessageId: existing?.feishuMessageId ?? null,
                renderVersion: baseRenderVersion + index
            })

            const previousModel = this.getPersistedItemCardModel(binding, item.itemKey, existing)
            const model = buildItemCardModel(message, item, {
                reasoningSummary: binding.reasoningSummary,
                toolVisibility: binding.toolVisibility
            }, previousModel)
            if (!model) {
                continue
            }

            const storedWithRenderState = this.options.store.feishuItems.upsertItem({
                namespace: stored.namespace,
                chatId: stored.chatId,
                rootMessageId: stored.rootMessageId,
                sessionId: stored.sessionId,
                itemKey: stored.itemKey,
                itemType: stored.itemType,
                status: stored.status,
                sourceId: stored.sourceId,
                feishuMessageId: stored.feishuMessageId,
                renderStateJson: JSON.stringify(model),
                renderVersion: stored.renderVersion
            })

            await this.deliverItemCard(binding, storedWithRenderState, model)
            this.itemCardModels.set(getItemRenderKey(binding, item.itemKey), model)
        }

        return true
    }

    private getItemStream(binding: StoredFeishuThread): FeishuItemStream {
        const stream = new FeishuItemStream()
        stream.hydrate(this.options.store.feishuItems.listItemsForRootMessage(
            binding.namespace,
            binding.rootMessageId
        ))
        return stream
    }

    private async deliverItemCard(
        binding: StoredFeishuThread,
        item: ReturnType<Store['feishuItems']['upsertItem']>,
        model: FeishuItemCardModel
    ): Promise<void> {
        const card = renderItemCard(model)
        if (item.feishuMessageId) {
            await this.options.client.patchMessageCard({
                messageId: item.feishuMessageId,
                card
            })
            return
        }

        const reply = await this.options.client.replyCardMessage({
            messageId: binding.rootMessageId,
            card
        })
        this.options.store.feishuItems.upsertItem({
            namespace: item.namespace,
            chatId: item.chatId,
            rootMessageId: item.rootMessageId,
            sessionId: item.sessionId,
            itemKey: item.itemKey,
            itemType: item.itemType,
            status: item.status,
            sourceId: item.sourceId,
            feishuMessageId: reply.messageId,
            renderStateJson: JSON.stringify(model),
            renderVersion: item.renderVersion
        })
    }

    private getPersistedItemCardModel(
        binding: StoredFeishuThread,
        itemKey: string,
        item: StoredFeishuItem | null
    ): FeishuItemCardModel | null {
        if (!item) {
            return null
        }

        const cached = this.itemCardModels.get(getItemRenderKey(binding, itemKey)) ?? null
        if (cached) {
            return cached
        }

        const parsed = parseItemCardModel(item.renderStateJson)
        if (parsed) {
            this.itemCardModels.set(getItemRenderKey(binding, itemKey), parsed)
        }
        return parsed
    }
}

function getThreadTaskKey(binding: StoredFeishuThread): string {
    return `${binding.namespace}:${binding.chatId}:${binding.rootMessageId}`
}

function getItemRenderKey(binding: StoredFeishuThread, itemKey: string): string {
    return `${getThreadTaskKey(binding)}:${itemKey}`
}

function isTerminalItemStatus(status: StoredFeishuItem['status']): boolean {
    return status === 'completed' || status === 'failed'
}

function isStatusRegression(
    existingStatus: StoredFeishuItem['status'],
    incomingStatus: 'active' | 'completed' | 'failed'
): boolean {
    return getItemStatusRank(incomingStatus) < getItemStatusRank(existingStatus)
}

function getItemStatusRank(status: 'active' | 'completed' | 'failed'): number {
    switch (status) {
        case 'failed':
            return 2
        case 'completed':
            return 1
        case 'active':
        default:
            return 0
    }
}

function getMessageRenderVersion(message: DecryptedMessage): number {
    if (typeof message.seq === 'number') {
        return message.seq
    }

    return Number.isFinite(message.createdAt) ? message.createdAt : Date.now()
}

function extractAssistantText(message: DecryptedMessage): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record || record.role !== 'agent') {
        return null
    }

    const content = asRecord(record.content)
    const payload = asRecord(content?.data)

    if (content?.type !== AGENT_MESSAGE_PAYLOAD_TYPE || payload?.type !== 'message') {
        return null
    }

    const text = asString(payload.message)
    if (!text || isLowSignalAssistantText(text)) {
        return null
    }

    return text
}

type RuntimeCardContext = {
    reasoningSummary: FeishuReasoningSummary
    toolVisibility: FeishuToolVisibility
}

type RuntimeCardPayload =
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
        name: string
        input: unknown
    }
    | {
        type: 'tool-call-result'
        output: unknown
    }

function buildItemCardModel(
    message: DecryptedMessage,
    item: { itemKey: string; itemType: string; status: 'active' | 'completed' | 'failed' },
    context: RuntimeCardContext,
    previous: FeishuItemCardModel | null
): FeishuItemCardModel | null {
    const payload = extractRuntimeCardPayload(message)

    if (item.itemType === 'reasoning') {
        if (payload?.type === 'reasoning-delta') {
            const previousText = previous?.itemType === 'reasoning' ? previous.text : ''
            return {
                itemKey: item.itemKey,
                itemType: 'reasoning',
                status: item.status,
                reasoningSummary: context.reasoningSummary,
                text: `${previousText}${payload.delta}`
            }
        }

        const nextText = payload?.type === 'reasoning'
            ? payload.message
            : previous?.itemType === 'reasoning'
                ? previous.text
                : null
        if (!nextText) {
            return null
        }

        return {
            itemKey: item.itemKey,
            itemType: 'reasoning',
            status: item.status,
            reasoningSummary: context.reasoningSummary,
            text: nextText
        }
    }

    if (item.itemType === 'tool') {
        if (payload?.type === 'tool-call') {
            return {
                itemKey: item.itemKey,
                itemType: 'tool',
                status: item.status,
                toolVisibility: context.toolVisibility,
                toolName: payload.name,
                summary: item.status === 'active' ? `Running ${payload.name}.` : `${payload.name} completed.`,
                input: payload.input
            }
        }

        if (payload?.type === 'tool-call-result') {
            const toolName = previous?.itemType === 'tool' ? previous.toolName : 'Tool'
            return {
                itemKey: item.itemKey,
                itemType: 'tool',
                status: item.status,
                toolVisibility: context.toolVisibility,
                toolName,
                summary: item.status === 'failed' ? `${toolName} failed.` : `${toolName} completed.`,
                input: previous?.itemType === 'tool' ? previous.input : undefined,
                output: payload.output
            }
        }

        return previous?.itemType === 'tool'
            ? {
                ...previous,
                status: item.status,
                toolVisibility: context.toolVisibility
            }
            : null
    }

    if (item.itemType !== 'response') {
        return null
    }

    const text = payload?.type === 'message'
        ? payload.message
        : previous?.itemType === 'response'
            ? previous.text
            : null
    if (!text) {
        return null
    }

    return {
        itemKey: item.itemKey,
        itemType: 'response',
        status: 'completed',
        text
    }
}

function extractRuntimeCardPayload(message: DecryptedMessage): RuntimeCardPayload | null {
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
        const name = asString(payload.name)
        if (!name) {
            return null
        }
        return {
            type,
            name,
            input: payload.input
        }
    }

    if (type === 'tool-call-result') {
        return {
            type,
            output: payload.output
        }
    }

    return null
}

function parseItemCardModel(value: string | null): FeishuItemCardModel | null {
    if (!value) {
        return null
    }

    try {
        const parsed = JSON.parse(value) as Record<string, unknown>
        const itemType = typeof parsed.itemType === 'string' ? parsed.itemType : null
        const status = typeof parsed.status === 'string' ? parsed.status : null
        const itemKey = typeof parsed.itemKey === 'string' ? parsed.itemKey : null
        if (!itemType || !status || !itemKey) {
            return null
        }

        if (itemType === 'reasoning') {
            const text = typeof parsed.text === 'string' ? parsed.text : null
            const reasoningSummary = typeof parsed.reasoningSummary === 'string' ? parsed.reasoningSummary : null
            if (!text || !reasoningSummary) {
                return null
            }
            return {
                itemKey,
                itemType,
                status: status as FeishuItemCardModel['status'],
                reasoningSummary: reasoningSummary as FeishuReasoningSummary,
                text
            }
        }

        if (itemType === 'tool') {
            const toolName = typeof parsed.toolName === 'string' ? parsed.toolName : null
            const summary = typeof parsed.summary === 'string' ? parsed.summary : null
            const toolVisibility = typeof parsed.toolVisibility === 'string' ? parsed.toolVisibility : null
            if (!toolName || !summary || !toolVisibility) {
                return null
            }
            return {
                itemKey,
                itemType,
                status: status as FeishuItemCardModel['status'],
                toolVisibility: toolVisibility as FeishuToolVisibility,
                toolName,
                summary,
                input: parsed.input,
                output: parsed.output
            }
        }

        if (itemType === 'response') {
            const text = typeof parsed.text === 'string' ? parsed.text : null
            if (!text) {
                return null
            }
            return {
                itemKey,
                itemType,
                status: 'completed',
                text
            }
        }

        return null
    } catch {
        return null
    }
}

function extractTurnFailureText(message: DecryptedMessage): string | null {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record || record.role !== 'agent') {
        return null
    }

    const content = asRecord(record.content)
    const payload = asRecord(content?.data)
    if (content?.type !== 'event') {
        return null
    }

    if (payload?.type === 'turn-failed') {
        const error = asString(payload.error)
        return error ? `Task failed: ${error}` : 'Task failed'
    }

    if (payload?.type === 'turn-aborted') {
        return 'Turn aborted'
    }

    return null
}

function isReadyEventMessage(message: DecryptedMessage): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record || record.role !== 'agent') {
        return false
    }

    const content = asRecord(record.content)
    const payload = asRecord(content?.data)
    return content?.type === 'event' && payload?.type === 'ready'
}

export function formatRequestPrompt(request: StoredFeishuRequest): string {
    if (request.kind === 'question') {
        const prompt = extractQuestionPrompt(request.requestJson) ?? `Question ${request.shortToken}`
        const options = extractQuestionOptions(request.requestJson)
        const optionLines = formatQuestionOptions(options)

        return [
            `Question needed [${request.shortToken}]`,
            prompt,
            ...optionLines,
            `Reply with A/B/C, yes/no, or /choose r:${request.shortToken} <choice>.`
        ].join('\n')
    }

    const toolName = extractRequestToolName(request.requestJson) ?? 'permission request'
    return [
        `Approval needed [${request.shortToken}]`,
        `Tool: ${toolName}`,
        `Reply /approve r:${request.shortToken} once`,
        `/approve r:${request.shortToken} session`,
        `/deny r:${request.shortToken}`,
        `/abort r:${request.shortToken}`
    ].join('\n')
}

export function renderOpenRequestCard(request: StoredFeishuRequest): Record<string, unknown> {
    if (request.kind === 'question') {
        const prompt = extractQuestionPrompt(request.requestJson) ?? `Question ${request.shortToken}`
        const options = extractQuestionOptions(request.requestJson)
        const optionLines = formatQuestionOptions(options)

        return buildRequestCard(
            `Question needed [${request.shortToken}]`,
            [prompt, ...optionLines],
            options.slice(0, 3).map((option, index) => ({
                label: getQuestionChoiceLabel(options, index),
                value: {
                    kind: 'choose',
                    requestToken: request.shortToken,
                    value: normalizeQuestionChoiceValue(options, index)
                }
            }))
        )
    }

    const toolName = extractRequestToolName(request.requestJson) ?? 'permission request'
    return buildRequestCard(
        `Approval needed [${request.shortToken}]`,
        [`Tool: ${toolName}`],
        [
            {
                label: 'Approve once',
                value: {
                    kind: 'resolve-request',
                    requestToken: request.shortToken,
                    decision: 'approved'
                }
            },
            {
                label: 'Approve for session',
                value: {
                    kind: 'resolve-request',
                    requestToken: request.shortToken,
                    decision: 'approved_for_session'
                }
            },
            {
                label: 'Deny',
                value: {
                    kind: 'resolve-request',
                    requestToken: request.shortToken,
                    decision: 'denied'
                }
            },
            {
                label: 'Abort',
                value: {
                    kind: 'resolve-request',
                    requestToken: request.shortToken,
                    decision: 'abort'
                }
            }
        ]
    )
}

export function renderResolvedRequestCard(
    request: StoredFeishuRequest,
    resolutionText: string
): Record<string, unknown> {
    if (request.kind === 'question') {
        const prompt = extractQuestionPrompt(request.requestJson) ?? `Question ${request.shortToken}`
        return buildRequestCard(
            `${resolutionText} [${request.shortToken}]`,
            [prompt],
            []
        )
    }

    const toolName = extractRequestToolName(request.requestJson) ?? 'permission request'
    return buildRequestCard(
        `${resolutionText} [${request.shortToken}]`,
        [`Tool: ${toolName}`],
        []
    )
}

function extractRequestToolName(requestJson: string): string | null {
    const parsed = parseRequestJson(requestJson)
    return asString(parsed?.tool)
}

function extractQuestionPrompt(requestJson: string): string | null {
    const parsed = parseRequestJson(requestJson)
    const args = asRecord(parsed?.arguments)
    const questions = Array.isArray(args?.questions) ? args.questions : null
    const firstQuestion = questions ? asRecord(questions[0]) : null

    return asString(firstQuestion?.question)
        ?? asString(args?.prompt)
        ?? asString(parsed?.prompt)
        ?? asString(parsed?.question)
}

function extractQuestionOptions(requestJson: string): string[] {
    const parsed = parseRequestJson(requestJson)
    const args = asRecord(parsed?.arguments)
    const questions = Array.isArray(args?.questions) ? args.questions : null
    const firstQuestion = questions ? asRecord(questions[0]) : null
    const candidates = [
        firstQuestion?.options,
        args?.options,
        parsed?.options
    ]

    for (const candidate of candidates) {
        if (!Array.isArray(candidate)) {
            continue
        }
        const values = candidate.filter((value): value is string => typeof value === 'string' && value.length > 0)
        if (values.length > 0) {
            return values
        }
    }

    return []
}

function formatQuestionOptions(options: string[]): string[] {
    if (options.length === 0) {
        return []
    }

    const normalized = options.map((option) => option.trim().toLowerCase())
    if (options.length === 2 && normalized[0] === 'yes' && normalized[1] === 'no') {
        return [
            `yes. ${options[0]}`,
            `no. ${options[1]}`
        ]
    }

    const labels = ['A', 'B', 'C']
    return options.slice(0, labels.length).map((option, index) => `${labels[index]}. ${option}`)
}

function buildRequestCard(
    title: string,
    lines: string[],
    actions: Array<{ label: string; value: Record<string, unknown> }>
): Record<string, unknown> {
    const elements: Record<string, unknown>[] = []
    for (const line of lines) {
        if (!line) {
            continue
        }

        elements.push({
            tag: 'div',
            text: {
                tag: 'plain_text',
                content: line
            }
        })
    }

    if (actions.length > 0) {
        elements.push({
            tag: 'action',
            actions: actions.map((action) => ({
                tag: 'button',
                text: {
                    tag: 'plain_text',
                    content: action.label
                },
                value: action.value
            }))
        })
    }

    return {
        schema: '2.0',
        config: {
            wide_screen_mode: true
        },
        header: {
            title: {
                tag: 'plain_text',
                content: title
            }
        },
        elements
    }
}

function getQuestionChoiceLabel(options: string[], index: number): string {
    const labels = getQuestionChoiceValues(options)
    const choice = labels[index] ?? String(index + 1)
    return options.length === 2 && labels[0] === 'yes' && labels[1] === 'no'
        ? options[index] ?? choice
        : `${choice}. ${options[index] ?? ''}`.trim()
}

function normalizeQuestionChoiceValue(options: string[], index: number): string {
    return getQuestionChoiceValues(options)[index] ?? String(index + 1)
}

function getQuestionChoiceValues(options: string[]): string[] {
    const normalized = options.map((option) => option.trim().toLowerCase())
    if (options.length === 2 && normalized[0] === 'yes' && normalized[1] === 'no') {
        return ['yes', 'no']
    }

    return ['A', 'B', 'C'].slice(0, options.length)
}

function parseRequestJson(requestJson: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(requestJson) as unknown
        return asRecord(parsed)
    } catch {
        return null
    }
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
