import type { Session } from '@hapi/protocol/types'

import type { Store, StoredFeishuThread } from '../store'
import type { SyncEngine } from '../sync/syncEngine'
import { FeishuBridgeStateSynchronizer } from './bridge'
import { FeishuClient } from './client'
import { parseFeishuChatInput } from './commands'
import { renderOpenRequestCard, renderResolvedRequestCard } from './runtime'
import type { FeishuCardActionEvent, FeishuInboundMessageEvent } from './types'

type FeishuBridgeControllerOptions = {
    namespace?: string
    operatorOpenId?: string | null
    claimOperatorOpenId?: (openId: string) => Promise<void>
    store: Store
    syncEngine: Pick<
        SyncEngine,
        | 'getSessionsByNamespace'
        | 'resolveSessionAccess'
        | 'getOnlineMachinesByNamespace'
        | 'checkPathsExist'
        | 'spawnSession'
        | 'waitForSessionActive'
        | 'applySessionConfig'
        | 'renameSession'
        | 'resumeSession'
        | 'sendMessage'
        | 'approvePermission'
        | 'denyPermission'
        | 'abortSession'
        | 'archiveSession'
    >
    client: Pick<FeishuClient, 'replyMessage' | 'replyCardMessage' | 'patchMessageCard' | 'updateInteractiveCard'>
}

export class FeishuBridgeController {
    private readonly namespace: string
    private operatorOpenId: string | null
    private operatorClaimPromise: Promise<string> | null = null
    private readonly synchronizer: FeishuBridgeStateSynchronizer

    constructor(private readonly options: FeishuBridgeControllerOptions) {
        this.namespace = options.namespace ?? 'default'
        this.operatorOpenId = options.operatorOpenId ?? null
        this.synchronizer = new FeishuBridgeStateSynchronizer(options.store)
    }

    async handleMessageEvent(event: FeishuInboundMessageEvent): Promise<void> {
        if (event.chatType !== 'p2p') {
            await this.replyText(event.messageId, 'Feishu bridge MVP currently supports p2p chats only.')
            return
        }

        const operatorOpenId = await this.resolveOperatorOpenId(event.openId)
        if (operatorOpenId && event.openId !== operatorOpenId) {
            await this.replyText(event.messageId, 'This Feishu bridge is configured for a different operator.')
            return
        }

        const text = extractTextMessage(event)
        if (text === null) {
            await this.replyText(event.messageId, 'Only text messages are supported in the current Feishu bridge MVP.')
            return
        }

        const bindingResolution = this.resolveBinding(event)
        const parsed = parseFeishuChatInput(text, {
            boundThread: bindingResolution.kind === 'bound'
        })

        if (parsed.kind === 'command' && parsed.command.type === 'status') {
            await this.replyText(event.messageId, this.formatStatus(event, bindingResolution))
            return
        }

        if (bindingResolution.kind === 'ambiguous') {
            await this.replyText(
                event.messageId,
                'Multiple HAPI sessions are bound in this p2p chat. Reply to the original bound message for the target session.'
            )
            return
        }

        const binding = bindingResolution.kind === 'bound' ? bindingResolution.binding : null

        if (!binding) {
            await this.handleUnboundInput(event, parsed)
            return
        }

        if (binding.operatorOpenId !== event.openId) {
            await this.replyText(event.messageId, 'This Feishu thread is bound to a different operator.')
            return
        }

        await this.handleBoundInput(event, binding, parsed)
    }

    async handleCardActionEvent(event: FeishuCardActionEvent): Promise<void> {
        const operatorOpenId = await this.resolveOperatorOpenId(event.openId)
        if (operatorOpenId && event.openId !== operatorOpenId) {
            return
        }

        const requestToken = asString(event.action.requestToken)
        if (!requestToken) {
            return
        }

        const requestFromMessage = asString(event.messageId)
            ? this.options.store.feishuRequests.findRequestByMessageId(this.namespace, event.messageId)
            : null
        const request = requestFromMessage?.shortToken === requestToken
            ? requestFromMessage
            : this.options.store.feishuRequests.findRequestByShortToken(this.namespace, requestToken)
        if (!request || request.status !== 'open' || request.shortToken !== requestToken) {
            return
        }

        const binding = this.options.store.feishuThreads.getThreadBySessionId(this.namespace, request.sessionId)
        if (!binding || binding.operatorOpenId !== event.openId) {
            return
        }

        if (asString(event.action.kind) === 'choose') {
            if (request.kind !== 'question') {
                return
            }

            const sessionId = await this.ensureActiveSession(binding, request.feishuMessageId ?? event.messageId)
            if (!sessionId) {
                return
            }

            const value = asString(event.action.value)
            if (!value) {
                return
            }

            const answers = buildQuestionAnswers(request, value)
            await this.options.syncEngine.approvePermission(
                sessionId,
                request.requestId,
                undefined,
                undefined,
                'approved',
                answers
            )
            this.options.store.feishuRequests.markResolved(
                this.namespace,
                request.sessionId,
                request.requestId
            )
            await this.syncResolvedRequestCard(request, 'Answered', event.callbackToken)
            return
        }

        if (asString(event.action.kind) !== 'resolve-request') {
            return
        }

        if (request.kind !== 'permission') {
            return
        }

        const decision = asRequestDecision(event.action.decision)
        if (!decision) {
            return
        }

        const sessionId = await this.ensureActiveSession(binding, request.feishuMessageId ?? event.messageId)
        if (!sessionId) {
            return
        }

        if (decision === 'approved' || decision === 'approved_for_session') {
            await this.options.syncEngine.approvePermission(
                sessionId,
                request.requestId,
                undefined,
                undefined,
                decision,
                undefined
            )
        } else {
            await this.options.syncEngine.denyPermission(sessionId, request.requestId, decision)
        }

        this.options.store.feishuRequests.markResolved(
            this.namespace,
            request.sessionId,
            request.requestId
        )
        await this.syncResolvedRequestCard(
            request,
            decision === 'approved' || decision === 'approved_for_session'
                ? 'Approved'
                : decision === 'denied'
                    ? 'Denied'
                    : 'Aborted',
            event.callbackToken
        )
    }

    private async resolveOperatorOpenId(eventOpenId: string): Promise<string | null> {
        if (this.operatorOpenId) {
            return this.operatorOpenId
        }

        if (!this.options.claimOperatorOpenId) {
            return null
        }

        if (!this.operatorClaimPromise) {
            this.operatorClaimPromise = (async () => {
                await this.options.claimOperatorOpenId?.(eventOpenId)
                this.operatorOpenId = eventOpenId
                return eventOpenId
            })().finally(() => {
                this.operatorClaimPromise = null
            })
        }

        return await this.operatorClaimPromise
    }

    private async handleUnboundInput(
        event: FeishuInboundMessageEvent,
        parsed: ReturnType<typeof parseFeishuChatInput>
    ): Promise<void> {
        if (parsed.kind === 'error') {
            await this.replyText(event.messageId, parsed.error)
            return
        }

        if (parsed.kind !== 'command') {
            await this.replyText(
                event.messageId,
                'No HAPI session is bound to this thread yet. Start with /hapi new repo=/path model=<model>.'
            )
            return
        }

        switch (parsed.command.type) {
            case 'status':
                await this.replyText(event.messageId, this.formatStatus(event, { kind: 'none' }))
                return
            case 'list-sessions':
                await this.replyText(
                    event.messageId,
                    formatSessionList(
                        this.options.syncEngine.getSessionsByNamespace(this.namespace),
                        {
                            boundSessionIds: getBoundSessionIds(this.options.store, this.namespace),
                            listScope: parsed.command.listScope,
                            repoPathPrefix: parsed.command.repoPathPrefix
                        }
                    )
                )
                return
            case 'show-session': {
                if (!parsed.command.sessionId) {
                    await this.replyText(
                        event.messageId,
                        'No HAPI session is bound to this thread yet. Use /hapi show <session-id>.'
                    )
                    return
                }
                const access = this.options.syncEngine.resolveSessionAccess(parsed.command.sessionId, this.namespace)
                if (!access.ok) {
                    await this.replyText(event.messageId, `Session not found: ${parsed.command.sessionId}`)
                    return
                }
                await this.replyText(event.messageId, formatSessionSummary(access.session))
                return
            }
            case 'attach-session':
                await this.handleAttachSession(event, parsed.command.sessionId, null)
                return
            case 'unattach-session':
                await this.handleUnattachSession(event, null, parsed.command.sessionId)
                return
            case 'new-session':
                await this.handleCreateSession(event, parsed.command)
                return
            default:
                await this.replyText(event.messageId, 'This command requires an existing Feishu session thread.')
        }
    }

    private async handleCreateSession(
        event: FeishuInboundMessageEvent,
        command: Extract<ReturnType<typeof parseFeishuChatInput>, { kind: 'command' }>['command'] & { type: 'new-session' },
        currentBinding?: StoredFeishuThread | null
    ): Promise<void> {
        const machineId = command.machineId
            ?? currentBinding?.machineId
            ?? resolveMachineId(
            this.options.syncEngine.getOnlineMachinesByNamespace(this.namespace)
        )
        if (!machineId) {
            await this.replyText(event.messageId, 'Multiple online machines detected. Use machine=<machine-id> in /hapi new.')
            return
        }

        const exists = await this.options.syncEngine.checkPathsExist(machineId, [command.repoPath])
        if (exists[command.repoPath] !== true) {
            await this.replyText(event.messageId, `Path does not exist on machine ${machineId}: ${command.repoPath}`)
            return
        }

        const spawn = await this.options.syncEngine.spawnSession(
            machineId,
            command.repoPath,
            'codex',
            command.model,
            undefined,
            undefined,
            command.worktreeName ? 'worktree' : undefined,
            command.worktreeName ?? undefined
        )
        if (spawn.type !== 'success') {
            await this.replyText(event.messageId, `Failed to create session: ${spawn.message}`)
            return
        }

        const becameActive = await this.options.syncEngine.waitForSessionActive(spawn.sessionId)
        if (!becameActive) {
            await this.replyText(event.messageId, `Session ${spawn.sessionId} failed to become active.`)
            return
        }

        await this.options.syncEngine.applySessionConfig(spawn.sessionId, {
            permissionMode: command.permissionMode,
            collaborationMode: command.collaborationMode
        })
        if (command.sessionName) {
            await this.options.syncEngine.renameSession(spawn.sessionId, command.sessionName)
        }

        this.options.store.feishuThreads.upsertThread({
            namespace: this.namespace,
            chatId: event.chatId,
            rootMessageId: event.threadRootMessageId,
            sessionId: spawn.sessionId,
            operatorOpenId: event.openId,
            machineId,
            repoPath: command.repoPath,
            sessionName: command.sessionName,
            model: command.model,
            permissionMode: command.permissionMode,
            collaborationMode: command.collaborationMode,
            deliveryMode: 'foreground',
            reasoningSummary: currentBinding?.reasoningSummary ?? 'auto',
            toolVisibility: currentBinding?.toolVisibility ?? 'important',
            phase: command.collaborationMode === 'plan' ? 'planning' : 'executing',
            attention: 'none',
            lastForwardedSeq: null,
            activeTurnSeq: null,
            lastSeenReadyAt: null
        })

        await this.replyText(
            event.messageId,
            `Created Codex session ${spawn.sessionId} on ${machineId} for ${command.repoPath}.`
        )
    }

    private async handleAttachSession(
        event: FeishuInboundMessageEvent,
        sessionId: string,
        currentBinding: StoredFeishuThread | null
    ): Promise<void> {
        const access = this.options.syncEngine.resolveSessionAccess(sessionId, this.namespace)
        if (!access.ok) {
            await this.replyText(event.messageId, `Session not found: ${sessionId}`)
            return
        }

        const isSameThreadBinding = currentBinding !== null
            && currentBinding.chatId === event.chatId
            && currentBinding.rootMessageId === event.threadRootMessageId
            && currentBinding.sessionId === access.sessionId
        if (!isSameThreadBinding) {
            this.options.store.feishuThreads.deleteThreadsBySessionId(this.namespace, access.sessionId)
        }

        const latestMessage = this.options.store.messages.getMessages(access.sessionId, 1).at(-1) ?? null
        const baseBinding = this.options.store.feishuThreads.upsertThread({
            namespace: this.namespace,
            chatId: event.chatId,
            rootMessageId: event.threadRootMessageId,
            sessionId: access.sessionId,
            operatorOpenId: event.openId,
            machineId: access.session.metadata?.machineId ?? currentBinding?.machineId ?? null,
            repoPath: access.session.metadata?.path ?? currentBinding?.repoPath ?? '(unknown)',
            sessionName: access.session.metadata?.name ?? currentBinding?.sessionName ?? null,
            model: access.session.model,
            permissionMode: normalizePermissionMode(access.session.permissionMode, currentBinding?.permissionMode),
            collaborationMode: access.session.collaborationMode ?? currentBinding?.collaborationMode ?? 'default',
            deliveryMode: currentBinding?.deliveryMode ?? 'foreground',
            reasoningSummary: currentBinding?.reasoningSummary ?? 'auto',
            toolVisibility: currentBinding?.toolVisibility ?? 'important',
            phase: (access.session.collaborationMode ?? currentBinding?.collaborationMode) === 'plan' ? 'planning' : 'executing',
            attention: 'none',
            lastForwardedSeq: latestMessage?.seq ?? null,
            activeTurnSeq: latestMessage?.seq ?? null,
            lastSeenReadyAt: null
        })

        const sync = this.synchronizer.syncSession(baseBinding, access.session)
        for (const request of sync.openRequests) {
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

        await this.replyText(event.messageId, `Attached thread to session ${sync.binding.sessionId}.`)
    }

    private async handleUnattachSession(
        event: FeishuInboundMessageEvent,
        currentBinding: StoredFeishuThread | null,
        targetSessionId: string | null
    ): Promise<void> {
        if (targetSessionId) {
            const deleted = this.options.store.feishuThreads.deleteThreadsBySessionId(this.namespace, targetSessionId)
            await this.replyText(event.messageId, `Unattached ${deleted} binding(s) for session ${targetSessionId}.`)
            return
        }

        if (!currentBinding) {
            await this.replyText(event.messageId, 'Current thread is not attached.')
            return
        }

        this.options.store.feishuThreads.deleteThread(
            currentBinding.namespace,
            currentBinding.chatId,
            currentBinding.rootMessageId
        )
        await this.replyText(event.messageId, 'Unattached current thread.')
    }

    private async handleBoundInput(
        event: FeishuInboundMessageEvent,
        binding: StoredFeishuThread,
        parsed: ReturnType<typeof parseFeishuChatInput>
    ): Promise<void> {
        if (parsed.kind === 'error') {
            await this.replyText(event.messageId, parsed.error)
            return
        }

        if (parsed.kind === 'text') {
            const sessionId = await this.ensureActiveSession(binding, event.messageId)
            if (!sessionId) {
                return
            }

            await this.options.syncEngine.sendMessage(sessionId, {
                text: parsed.text,
                localId: `feishu:${event.eventId}`,
                sentFrom: 'webapp'
            })
            const latestMessage = this.options.store.messages.getMessages(sessionId, 1).at(-1) ?? null
            this.updateBinding(binding, {
                sessionId,
                attention: 'none',
                lastForwardedSeq: latestMessage?.seq ?? binding.lastForwardedSeq,
                activeTurnSeq: latestMessage?.seq ?? binding.activeTurnSeq
            })
            await this.replyText(event.messageId, `Forwarded to session ${sessionId}.`)
            return
        }

        if (parsed.kind === 'choice') {
            const sessionId = await this.ensureActiveSession(binding, event.messageId)
            if (!sessionId) {
                return
            }

            const target = this.resolveOpenRequest(sessionId, binding.sessionId, null, 'question')
            if (!target.ok) {
                await this.replyText(event.messageId, target.message)
                return
            }

            const answers = buildQuestionAnswers(target.request, parsed.value)
            await this.options.syncEngine.approvePermission(
                sessionId,
                target.request.requestId,
                undefined,
                undefined,
                'approved',
                answers
            )
            this.options.store.feishuRequests.markResolved(
                this.namespace,
                target.request.sessionId,
                target.request.requestId
            )
            await this.syncResolvedRequestCard(target.request, 'Answered')
            await this.replyText(event.messageId, `Answered request ${target.request.shortToken}.`)
            return
        }

        if (parsed.kind === 'command') {
            switch (parsed.command.type) {
                case 'status':
                    await this.replyText(event.messageId, this.formatStatus(event, {
                        kind: 'bound',
                        binding
                    }))
                    return
                case 'new-session':
                    await this.handleCreateSession(event, parsed.command, binding)
                    return
                case 'attach-session':
                    await this.handleAttachSession(event, parsed.command.sessionId, binding)
                    return
                case 'unattach-session':
                    await this.handleUnattachSession(event, binding, parsed.command.sessionId)
                    return
                case 'list-sessions':
                    await this.replyText(
                        event.messageId,
                        formatSessionList(
                            this.options.syncEngine.getSessionsByNamespace(this.namespace),
                            {
                                currentSessionId: binding.sessionId,
                                boundSessionIds: getBoundSessionIds(this.options.store, this.namespace),
                                listScope: parsed.command.listScope,
                                repoPathPrefix: parsed.command.repoPathPrefix
                            }
                        )
                    )
                    return
                case 'show-session': {
                    const targetSessionId = parsed.command.sessionId ?? binding.sessionId
                    const access = this.options.syncEngine.resolveSessionAccess(targetSessionId, this.namespace)
                    if (!access.ok) {
                        await this.replyText(event.messageId, `Session not found: ${targetSessionId}`)
                        return
                    }
                    await this.replyText(
                        event.messageId,
                        formatSessionSummary(access.session, access.sessionId === binding.sessionId)
                    )
                    return
                }
                case 'set-delivery-mode':
                    this.updateBinding(binding, {
                        deliveryMode: parsed.command.deliveryMode
                    })
                    await this.replyText(event.messageId, `Delivery mode set to ${parsed.command.deliveryMode}.`)
                    return
                case 'set-permission-mode': {
                    const sessionId = await this.ensureActiveSession(binding, event.messageId)
                    if (!sessionId) {
                        return
                    }
                    await this.options.syncEngine.applySessionConfig(sessionId, {
                        permissionMode: parsed.command.permissionMode
                    })
                    this.updateBinding(binding, {
                        sessionId,
                        permissionMode: parsed.command.permissionMode
                    })
                    await this.replyText(event.messageId, `Permission mode set to ${parsed.command.permissionMode}.`)
                    return
                }
                case 'set-reasoning-summary':
                    this.updateBinding(binding, {
                        reasoningSummary: parsed.command.reasoningSummary
                    })
                    await this.replyText(event.messageId, `Reasoning summary set to ${parsed.command.reasoningSummary}.`)
                    return
                case 'set-tool-visibility':
                    this.updateBinding(binding, {
                        toolVisibility: parsed.command.toolVisibility
                    })
                    await this.replyText(event.messageId, `Tool visibility set to ${parsed.command.toolVisibility}.`)
                    return
                case 'set-collaboration-mode': {
                    const sessionId = await this.ensureActiveSession(binding, event.messageId)
                    if (!sessionId) {
                        return
                    }
                    await this.options.syncEngine.applySessionConfig(sessionId, {
                        collaborationMode: parsed.command.collaborationMode
                    })
                    this.updateBinding(binding, {
                        sessionId,
                        collaborationMode: parsed.command.collaborationMode,
                        phase: parsed.command.collaborationMode === 'plan' ? 'planning' : 'executing'
                    })
                    await this.replyText(event.messageId, `Collaboration mode set to ${parsed.command.collaborationMode}.`)
                    return
                }
                case 'stop-session': {
                    const sessionId = await this.ensureActiveSession(binding, event.messageId)
                    if (!sessionId) {
                        return
                    }
                    await this.options.syncEngine.abortSession(sessionId)
                    await this.replyText(event.messageId, `Stopped session ${sessionId}.`)
                    return
                }
                case 'close-session':
                    await this.options.syncEngine.archiveSession(binding.sessionId)
                    await this.replyText(event.messageId, `Closed session ${binding.sessionId}.`)
                    return
                case 'resolve-request': {
                    const sessionId = await this.ensureActiveSession(binding, event.messageId)
                    if (!sessionId) {
                        return
                    }

                    const target = this.resolveOpenRequest(
                        sessionId,
                        binding.sessionId,
                        parsed.command.requestToken,
                        parsed.command.decision === 'approved' || parsed.command.decision === 'approved_for_session'
                            ? 'permission'
                            : null
                    )
                    if (!target.ok) {
                        await this.replyText(event.messageId, target.message)
                        return
                    }

                    if (parsed.command.decision === 'approved' || parsed.command.decision === 'approved_for_session') {
                        await this.options.syncEngine.approvePermission(
                            sessionId,
                            target.request.requestId,
                            undefined,
                            undefined,
                            parsed.command.decision,
                            undefined
                        )
                        await this.replyText(event.messageId, `Approved request ${target.request.shortToken}.`)
                    } else {
                        await this.options.syncEngine.denyPermission(
                            sessionId,
                            target.request.requestId,
                            parsed.command.decision
                        )
                        await this.replyText(event.messageId, `Resolved request ${target.request.shortToken} with ${parsed.command.decision}.`)
                    }

                    this.options.store.feishuRequests.markResolved(
                        this.namespace,
                        target.request.sessionId,
                        target.request.requestId
                    )
                    await this.syncResolvedRequestCard(
                        target.request,
                        parsed.command.decision === 'approved' || parsed.command.decision === 'approved_for_session'
                            ? 'Approved'
                            : parsed.command.decision === 'denied'
                                ? 'Denied'
                                : 'Aborted'
                    )
                    return
                }
                case 'choose': {
                    const sessionId = await this.ensureActiveSession(binding, event.messageId)
                    if (!sessionId) {
                        return
                    }

                    const target = this.resolveOpenRequest(sessionId, binding.sessionId, parsed.command.requestToken, 'question')
                    if (!target.ok) {
                        await this.replyText(event.messageId, target.message)
                        return
                    }

                    const answers = buildQuestionAnswers(target.request, parsed.command.value)
                    await this.options.syncEngine.approvePermission(
                        sessionId,
                        target.request.requestId,
                        undefined,
                        undefined,
                        'approved',
                        answers
                    )
                    this.options.store.feishuRequests.markResolved(
                        this.namespace,
                        target.request.sessionId,
                        target.request.requestId
                    )
                    await this.syncResolvedRequestCard(target.request, 'Answered')
                    await this.replyText(event.messageId, `Answered request ${target.request.shortToken}.`)
                    return
                }
                default:
                    break
            }
        }

        await this.replyText(
            event.messageId,
            'This in-thread command is not wired yet in the current Feishu bridge batch.'
        )
    }

    private async ensureActiveSession(binding: StoredFeishuThread, replyToMessageId: string): Promise<string | null> {
        const access = this.options.syncEngine.resolveSessionAccess(binding.sessionId, this.namespace)
        if (!access.ok) {
            await this.replyText(replyToMessageId, `Session not found: ${binding.sessionId}`)
            return null
        }

        if (access.session.active) {
            return access.sessionId
        }

        const resumed = await this.options.syncEngine.resumeSession(binding.sessionId, this.namespace)
        if (resumed.type !== 'success') {
            await this.replyText(replyToMessageId, `Failed to resume session ${binding.sessionId}: ${resumed.message}`)
            return null
        }

        if (resumed.sessionId !== binding.sessionId) {
            this.options.store.feishuThreads.upsertThread({
                namespace: binding.namespace,
                chatId: binding.chatId,
                rootMessageId: binding.rootMessageId,
                sessionId: resumed.sessionId,
                operatorOpenId: binding.operatorOpenId,
                machineId: binding.machineId,
                repoPath: binding.repoPath,
                sessionName: binding.sessionName,
                model: binding.model,
                permissionMode: binding.permissionMode,
                collaborationMode: binding.collaborationMode,
                deliveryMode: binding.deliveryMode,
                reasoningSummary: binding.reasoningSummary,
                toolVisibility: binding.toolVisibility,
                phase: binding.phase,
                attention: binding.attention,
                lastForwardedSeq: binding.lastForwardedSeq,
                activeTurnSeq: binding.activeTurnSeq,
                lastSeenReadyAt: binding.lastSeenReadyAt
            })
        }

        return resumed.sessionId
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

    private resolveBinding(
        event: FeishuInboundMessageEvent
    ): { kind: 'bound'; binding: StoredFeishuThread } | { kind: 'ambiguous' } | { kind: 'none' } {
        const exactBinding = this.options.store.feishuThreads.getThread(
            this.namespace,
            event.chatId,
            event.threadRootMessageId
        )
        if (exactBinding) {
            return {
                kind: 'bound',
                binding: exactBinding
            }
        }

        if (event.chatType !== 'p2p') {
            return { kind: 'none' }
        }

        const chatBindings = this.options.store.feishuThreads.getThreadsForChat(
            this.namespace,
            event.chatId,
            event.openId
        )
        if (chatBindings.length === 1) {
            return {
                kind: 'bound',
                binding: chatBindings[0]
            }
        }

        if (chatBindings.length > 1) {
            return { kind: 'ambiguous' }
        }

        return { kind: 'none' }
    }

    private resolveOpenRequest(
        sessionId: string,
        previousSessionId: string,
        requestToken: string | null,
        requiredKind: 'permission' | 'question' | null
    ): { ok: true; request: ReturnType<Store['feishuRequests']['listOpenRequestsForSession']>[number] } | { ok: false; message: string } {
        const candidates = [
            ...this.options.store.feishuRequests.listOpenRequestsForSession(this.namespace, sessionId),
            ...(previousSessionId === sessionId
                ? []
                : this.options.store.feishuRequests.listOpenRequestsForSession(this.namespace, previousSessionId))
        ].filter((request, index, requests) =>
            requests.findIndex((candidate) =>
                candidate.sessionId === request.sessionId && candidate.requestId === request.requestId
            ) === index
        )

        const filtered = requiredKind
            ? candidates.filter((request) => request.kind === requiredKind)
            : candidates

        if (requestToken) {
            const match = filtered.find((request) => request.shortToken === requestToken)
            if (!match) {
                return { ok: false, message: `Open request not found for token ${requestToken}.` }
            }
            return { ok: true, request: match }
        }

        if (filtered.length === 0) {
            return { ok: false, message: requiredKind === 'question' ? 'No open question requests.' : 'No open requests.' }
        }

        if (filtered.length > 1) {
            return { ok: false, message: 'Multiple open requests. Use the request token.' }
        }

        return { ok: true, request: filtered[0] }
    }

    private async syncResolvedRequestCard(
        request: ReturnType<Store['feishuRequests']['listOpenRequestsForSession']>[number],
        resolutionText: string,
        callbackToken?: string
    ): Promise<void> {
        const card = renderResolvedRequestCard(request, resolutionText)
        if (callbackToken) {
            await this.options.client.updateInteractiveCard({
                token: callbackToken,
                card
            })
            return
        }

        if (!request.feishuMessageId) {
            return
        }

        await this.options.client.patchMessageCard({
            messageId: request.feishuMessageId,
            card
        })
    }

    private async replyText(messageId: string, text: string): Promise<void> {
        await this.options.client.replyMessage({
            messageId,
            msgType: 'text',
            content: {
                text
            }
        })
    }

    private formatStatus(
        event: FeishuInboundMessageEvent,
        bindingResolution: { kind: 'bound'; binding: StoredFeishuThread } | { kind: 'ambiguous' } | { kind: 'none' }
    ): string {
        if (bindingResolution.kind !== 'bound') {
            const lines = [
                'Thread bound: no',
                `Chat: ${event.chatId}`,
                `Thread root: ${event.threadRootMessageId}`
            ]
            if (bindingResolution.kind === 'ambiguous') {
                lines.push('Binding resolution: ambiguous')
            }
            return lines.join('\n')
        }

        const { binding } = bindingResolution
        const access = this.options.syncEngine.resolveSessionAccess(binding.sessionId, this.namespace)
        const session = access.ok ? access.session : null
        const workingDir = session?.metadata?.path ?? binding.repoPath
        const model = session?.model ?? binding.model ?? '(auto)'
        const permissionMode = session?.permissionMode ?? binding.permissionMode
        const status = session?.active ? 'active' : 'inactive'

        const lines = [
            'Thread bound: yes',
            `Session: ${binding.sessionId}`,
            `Status: ${status}`,
            `Working dir: ${workingDir}`,
            `Machine: ${binding.machineId ?? '(unknown)'}`,
            `Model: ${model}`,
            `Permission: ${permissionMode}`,
            `Reasoning summary: ${binding.reasoningSummary}`,
            `Tool visibility: ${binding.toolVisibility}`,
            `Thread root: ${binding.rootMessageId}`
        ]
        return lines.join('\n')
    }
}

function extractTextMessage(event: FeishuInboundMessageEvent): string | null {
    if (event.messageType !== 'text') {
        return null
    }

    try {
        const parsed = JSON.parse(event.content) as { text?: unknown }
        return asString(parsed.text)
    } catch {
        return null
    }
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null
}

function asRequestDecision(value: unknown): 'approved' | 'approved_for_session' | 'denied' | 'abort' | null {
    return value === 'approved' || value === 'approved_for_session' || value === 'denied' || value === 'abort'
        ? value
        : null
}

function resolveMachineId(machines: Array<{ id: string }>): string | null {
    if (machines.length === 1) {
        return machines[0].id
    }
    return null
}

function buildQuestionAnswers(
    request: ReturnType<Store['feishuRequests']['listOpenRequestsForSession']>[number],
    value: string
): Record<string, string[]> | Record<string, { answers: string[] }> {
    const questionId = extractQuestionId(request.requestJson) ?? 'choice'
    if (request.answerShape === 'nested') {
        return {
            [questionId]: {
                answers: [value]
            }
        }
    }

    return {
        [questionId]: [value]
    }
}

function extractQuestionId(requestJson: string): string | null {
    try {
        const parsed = JSON.parse(requestJson) as {
            questions?: Array<{ id?: unknown }>
            arguments?: {
                questions?: Array<{ id?: unknown }>
            }
        }

        const directId = typeof parsed.questions?.[0]?.id === 'string' ? parsed.questions[0].id : null
        if (directId) {
            return directId
        }

        const nestedId = typeof parsed.arguments?.questions?.[0]?.id === 'string'
            ? parsed.arguments.questions[0].id
            : null
        return nestedId
    } catch {
        return null
    }
}

function getBoundSessionIds(store: Store, namespace: string): Set<string> {
    return new Set(store.feishuThreads.getThreadsByNamespace(namespace).map((binding) => binding.sessionId))
}

function normalizePermissionMode(
    permissionMode: Session['permissionMode'],
    fallback: StoredFeishuThread['permissionMode'] | undefined
): StoredFeishuThread['permissionMode'] {
    if (
        permissionMode === 'default'
        || permissionMode === 'read-only'
        || permissionMode === 'safe-yolo'
        || permissionMode === 'yolo'
    ) {
        return permissionMode
    }

    return fallback ?? 'default'
}

function formatSessionList(
    sessions: Session[],
    options?: {
        currentSessionId?: string | null
        boundSessionIds?: Set<string>
        listScope?: 'all' | 'bound'
        repoPathPrefix?: string | null
    }
): string {
    const boundSessionIds = options?.boundSessionIds ?? new Set<string>()
    const listScope = options?.listScope ?? 'all'
    const repoPathPrefix = options?.repoPathPrefix ?? null

    const filtered = sessions.filter((session) => {
        const sessionPath = session.metadata?.path ?? ''
        if (repoPathPrefix && !sessionPath.startsWith(repoPathPrefix)) {
            return false
        }
        if (listScope === 'bound' && !boundSessionIds.has(session.id)) {
            return false
        }
        return true
    })

    if (filtered.length === 0) {
        return 'No sessions found in this namespace.'
    }

    return filtered
        .map((session) => {
            const isCurrent = options?.currentSessionId === session.id
            const isBound = boundSessionIds.has(session.id)
            const marker = isCurrent
                ? ' (current)'
                : isBound
                    ? ' (bound)'
                    : ''
            return `${session.id} [${session.active ? 'active' : 'inactive'}] ${session.metadata?.path ?? ''}${marker}`.trim()
        })
        .join('\n')
}

function formatSessionSummary(session: Session, isCurrent: boolean = false): string {
    const lines = [
        `Session: ${session.id}`,
        `Status: ${session.active ? 'active' : 'inactive'}`,
        `Path: ${session.metadata?.path ?? '(unknown)'}`,
        `Model: ${session.model ?? '(auto)'}`,
        `Permission: ${session.permissionMode ?? '(unset)'}`,
        `Collaboration: ${session.collaborationMode ?? '(unset)'}`
    ]
    if (isCurrent) {
        lines.push('Current: true')
    }
    return lines.join('\n')
}
