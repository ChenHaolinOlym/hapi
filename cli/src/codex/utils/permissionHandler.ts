/**
 * Permission Handler for Codex tool approval integration
 * 
 * Handles tool permission requests and responses for Codex sessions.
 * Simpler than Claude's permission handler since we get tool IDs directly.
 */

import { logger } from "@/ui/logger";
import { ApiSessionClient } from "@/api/apiSession";
import type { CodexPermissionMode } from "@hapi/protocol/types";
import {
    BasePermissionHandler,
    type AutoApprovalDecision,
    type PendingPermissionRequest,
    type PermissionCompletion
} from "@/modules/common/permission/BasePermissionHandler";

interface PermissionResponse {
    id: string;
    approved: boolean;
    decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

interface PermissionResult {
    decision: 'approved' | 'approved_for_session' | 'denied' | 'abort';
    reason?: string;
    answers?: Record<string, string[]> | Record<string, { answers: string[] }>;
}

type CodexPermissionHandlerOptions = {
    onRequest?: (request: { id: string; toolName: string; input: unknown }) => void;
    onComplete?: (result: {
        id: string;
        toolName: string;
        input: unknown;
        approved: boolean;
        decision: PermissionResult['decision'];
        reason?: string;
        answers?: PermissionResult['answers'];
    }) => void;
};

function hasAnswers(
    answers: PermissionResponse['answers']
): answers is NonNullable<PermissionResponse['answers']> {
    return answers !== undefined && Object.keys(answers).length > 0;
}

export class CodexPermissionHandler extends BasePermissionHandler<PermissionResponse, PermissionResult> {
    private readonly sessionApprovedTools = new Set<string>();

    constructor(
        session: ApiSessionClient,
        private readonly getPermissionMode: () => CodexPermissionMode | undefined,
        private readonly options?: CodexPermissionHandlerOptions
    ) {
        super(session);
    }

    protected override onRequestRegistered(id: string, toolName: string, input: unknown): void {
        this.options?.onRequest?.({ id, toolName, input });
    }

    private completeAutoApproval(
        id: string,
        toolName: string,
        input: unknown,
        decision: AutoApprovalDecision
    ): PermissionResult {
        const timestamp = Date.now();

        this.options?.onRequest?.({ id, toolName, input });
        this.options?.onComplete?.({
            id,
            toolName,
            input,
            approved: true,
            decision
        });

        this.client.updateAgentState((currentState) => ({
            ...currentState,
            completedRequests: {
                ...currentState.completedRequests,
                [id]: {
                    tool: toolName,
                    arguments: input,
                    createdAt: timestamp,
                    completedAt: timestamp,
                    status: 'approved',
                    decision
                }
            }
        }));

        logger.debug(`[Codex] Auto-approved ${toolName} (${id}) with decision=${decision}`);

        return { decision };
    }

    /**
     * Handle a tool permission request
     * @param toolCallId - The unique ID of the tool call
     * @param toolName - The name of the tool being called
     * @param input - The input parameters for the tool
     * @returns Promise resolving to permission result
     */
    async handleToolCall(
        toolCallId: string,
        toolName: string,
        input: unknown
    ): Promise<PermissionResult> {
        const mode = this.getPermissionMode() ?? 'default';
        const normalizedToolName = toolName.toLowerCase();
        const autoDecision = this.sessionApprovedTools.has(normalizedToolName)
            ? 'approved_for_session'
            : this.resolveAutoApprovalDecision(mode, toolName, toolCallId);
        if (autoDecision) {
            return Promise.resolve(this.completeAutoApproval(toolCallId, toolName, input, autoDecision));
        }

        return new Promise<PermissionResult>((resolve, reject) => {
            // Store the pending request
            this.addPendingRequest(toolCallId, toolName, input, { resolve, reject });

            // Send push notification
            // this.session.api.push().sendToAllDevices(
            //     'Permission Request',
            //     `Codex wants to use ${toolName}`,
            //     {
            //         sessionId: this.session.sessionId,
            //         requestId: toolCallId,
            //         tool: toolName,
            //         type: 'permission_request'
            //     }
            // );

            logger.debug(`[Codex] Permission request sent for tool: ${toolName} (${toolCallId})`);
        });
    }

    async handleUserInputRequest(
        requestId: string,
        input: unknown
    ): Promise<PermissionResult> {
        return new Promise<PermissionResult>((resolve, reject) => {
            this.addPendingRequest(requestId, 'request_user_input', input, { resolve, reject });
            logger.debug(`[Codex] User input request sent (${requestId})`);
        });
    }

    /**
     * Handle permission responses
     */
    protected async handlePermissionResponse(
        response: PermissionResponse,
        pending: PendingPermissionRequest<PermissionResult>
    ): Promise<PermissionCompletion> {
        if (pending.toolName === 'request_user_input') {
            const approved = response.approved && hasAnswers(response.answers);
            const result: PermissionResult = approved
                ? {
                    decision: 'approved',
                    reason: typeof response.reason === 'string' ? response.reason : undefined,
                    answers: response.answers
                }
                : {
                    decision: response.decision === 'abort' ? 'abort' : 'denied',
                    reason: typeof response.reason === 'string' ? response.reason : 'No answers were provided.'
                };

            pending.resolve(result);
            logger.debug(`[Codex] User-input request ${approved ? 'approved' : 'rejected'} for ${pending.toolName}`);

            this.options?.onComplete?.({
                id: response.id,
                toolName: pending.toolName,
                input: pending.input,
                approved,
                decision: result.decision,
                reason: result.reason,
                answers: result.answers
            });

            return {
                status: approved ? 'approved' : result.decision === 'abort' ? 'canceled' : 'denied',
                decision: result.decision,
                reason: result.reason,
                answers: result.answers
            };
        }

        const reason = typeof response.reason === 'string' ? response.reason : undefined;
        const answers = response.answers;
        const result: PermissionResult = response.approved
            ? {
                decision: response.decision === 'approved_for_session' ? 'approved_for_session' : 'approved',
                reason,
                answers
            }
            : {
                decision: response.decision === 'denied' ? 'denied' : 'abort',
                reason,
                answers
            };

        if (response.approved && result.decision === 'approved_for_session') {
            this.sessionApprovedTools.add(pending.toolName.toLowerCase());
        }

        pending.resolve(result);
        logger.debug(`[Codex] Permission ${response.approved ? 'approved' : 'denied'} for ${pending.toolName}`);

        this.options?.onComplete?.({
            id: response.id,
            toolName: pending.toolName,
            input: pending.input,
            approved: response.approved,
            decision: result.decision,
            reason: result.reason,
            answers: result.answers
        });

        return {
            status: response.approved ? 'approved' : result.decision === 'abort' ? 'canceled' : 'denied',
            decision: result.decision,
            reason: result.reason,
            answers: result.answers
        };
    }

    protected handleMissingPendingResponse(_response: PermissionResponse): void {
        logger.debug('[Codex] Permission request not found or already resolved');
    }

    /**
     * Reset state for new sessions
     */
    reset(): void {
        this.cancelPendingRequests({
            completedReason: 'Session reset',
            rejectMessage: 'Session reset'
        });
        this.sessionApprovedTools.clear();

        logger.debug('[Codex] Permission handler reset');
    }
}
