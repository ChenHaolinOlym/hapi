import { AGENT_MESSAGE_PAYLOAD_TYPE } from '@hapi/protocol'
import { unwrapRoleWrappedRecordEnvelope } from '@hapi/protocol/messages'
import type { DecryptedMessage, Session, SyncEvent } from '@hapi/protocol/types'

import type { Store, StoredFeishuRequest, StoredFeishuThread } from '../store'
import type { SyncEngine } from '../sync/syncEngine'
import type { FeishuClient } from './client'
import { FeishuBridgeStateSynchronizer } from './bridge'

type FeishuBridgeRuntimeOptions = {
    namespace?: string
    store: Store
    syncEngine: Pick<SyncEngine, 'subscribe' | 'getMessagesAfter' | 'getSession'> & {
        getSessionByNamespace?: (sessionId: string, namespace: string) => Session | undefined
    }
    client: Pick<FeishuClient, 'replyMessage'>
}

export class FeishuBridgeRuntime {
    private readonly namespace: string
    private readonly synchronizer: FeishuBridgeStateSynchronizer
    private readonly threadTasks = new Map<string, Promise<void>>()
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
        const threadKey = `${binding.namespace}:${binding.chatId}:${binding.rootMessageId}`
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

            const text = formatRequestPrompt(request)
            const reply = await this.replyText(sync.binding.rootMessageId, text)
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
