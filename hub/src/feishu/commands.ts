import type { CodexPermissionMode } from '@hapi/protocol/types'

import { parseFeishuChoiceValue, parseFeishuRequestToken, parsePlainFeishuChoiceReply } from './choiceParser'
import type {
    FeishuChatCommand,
    FeishuChatInput,
    FeishuCommandParseContext,
    FeishuReasoningSummary,
    FeishuRequestDecision,
    FeishuToolVisibility,
    ParsedFeishuCommand
} from './types'

const CODEX_PERMISSION_MODES: CodexPermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo']
const FEISHU_REASONING_SUMMARIES: FeishuReasoningSummary[] = ['auto', 'none', 'brief', 'detailed']
const FEISHU_TOOL_VISIBILITIES: FeishuToolVisibility[] = ['off', 'important', 'all']
const FEISHU_THREAD_COMMANDS = new Set([
    '/perm',
    '/stop',
    '/close',
    '/approve',
    '/deny',
    '/abort',
    '/choose'
])
const FEISHU_UNSUPPORTED_COMMAND_ERRORS = new Map<string, string>([
    ['/bg', '/bg is not supported in the current Feishu MVP'],
    ['/fg', '/fg is not supported in the current Feishu MVP'],
    ['/plan', '/plan is not supported in the current Feishu MVP']
])

type TokenizedCommand = {
    tokens: string[]
    error: string | null
}

export function parseFeishuChatInput(text: string, context: FeishuCommandParseContext): FeishuChatInput {
    if (context.boundThread) {
        const bareChoice = parsePlainFeishuChoiceReply(text)
        if (bareChoice) {
            return bareChoice
        }
    }

    const trimmed = text.trim()
    if (!trimmed) {
        return { kind: 'text', text }
    }

    if (!trimmed.startsWith('/')) {
        return { kind: 'text', text }
    }

    const tokenized = tokenize(trimmed)
    if (tokenized.error) {
        return { kind: 'error', error: tokenized.error }
    }

    const [head] = tokenized.tokens
    if (!head) {
        return { kind: 'text', text }
    }

    const unsupportedCommandError = FEISHU_UNSUPPORTED_COMMAND_ERRORS.get(head)
    if (unsupportedCommandError) {
        return {
            kind: 'error',
            error: unsupportedCommandError
        }
    }

    if (head === '/status') {
        return {
            kind: 'error',
            error: 'Unknown command: /status'
        }
    }

    if (head === '/hapi') {
        return parseGlobalCommand(tokenized.tokens, text)
    }

    if (context.boundThread) {
        return parseBoundThreadCommand(tokenized.tokens, text)
    }

    if (FEISHU_THREAD_COMMANDS.has(head)) {
        return {
            kind: 'error',
            error: 'Thread command requires an existing Feishu session binding'
        }
    }

    return parseGlobalCommand(tokenized.tokens, text)
}

export function tokenizeFeishuCommandText(text: string): string[] {
    return tokenize(text).tokens
}

export function parseFeishuCommand(text: string): ParsedFeishuCommand | null {
    const tokenized = tokenize(text.trim())
    if (tokenized.error) {
        return {
            scope: 'error',
            message: tokenized.error
        }
    }

    const head = tokenized.tokens[0]
    const parsed = parseFeishuChatInput(text, {
        boundThread: head ? FEISHU_THREAD_COMMANDS.has(head) : false
    })

    if (parsed.kind === 'text') {
        return null
    }

    if (parsed.kind === 'error') {
        return {
            scope: 'error',
            message: parsed.error
        }
    }

    if (parsed.kind === 'choice') {
        return {
            scope: 'thread',
            kind: 'choose-option',
            requestToken: null,
            choice: parsed.value
        }
    }

    return mapParsedCommand(parsed.command)
}

function parseGlobalCommand(tokens: string[], originalText: string): FeishuChatInput {
    if (tokens[0] !== '/hapi') {
        return { kind: 'text', text: originalText }
    }

    const subcommand = tokens[1]
    if (subcommand === 'new') {
        return parseCreateSessionCommand(tokens.slice(2))
    }
    if (subcommand === 'status') {
        if (tokens.length !== 2) {
            return {
                kind: 'error',
                error: 'Unexpected arguments for /hapi status'
            }
        }
        return command({ type: 'status' })
    }
    if (subcommand === 'list') {
        return parseListSessionsCommand(tokens.slice(2))
    }
    if (subcommand === 'show' && (tokens.length === 2 || tokens.length === 3)) {
        return command({ type: 'show-session', sessionId: tokens[2] ?? null })
    }
    if ((subcommand === 'attach' || subcommand === 'use') && tokens.length === 3) {
        return command({ type: 'attach-session', sessionId: tokens[2] })
    }
    if (subcommand === 'unattach' && (tokens.length === 2 || tokens.length === 3)) {
        return command({ type: 'unattach-session', sessionId: tokens[2] ?? null })
    }
    if (subcommand === 'reasoning') {
        return parseReasoningSummaryCommand(tokens.slice(2))
    }
    if (subcommand === 'tools') {
        return parseToolVisibilityCommand(tokens.slice(2))
    }

    return {
        kind: 'error',
        error: 'Unknown /hapi command'
    }
}

function parseReasoningSummaryCommand(tokens: string[]): FeishuChatInput {
    if (tokens.length !== 1 || !isFeishuReasoningSummary(tokens[0])) {
        return {
            kind: 'error',
            error: 'Expected /hapi reasoning <auto|none|brief|detailed>'
        }
    }

    return command({
        type: 'set-reasoning-summary',
        reasoningSummary: tokens[0]
    })
}

function parseToolVisibilityCommand(tokens: string[]): FeishuChatInput {
    if (tokens.length !== 1 || !isFeishuToolVisibility(tokens[0])) {
        return {
            kind: 'error',
            error: 'Expected /hapi tools <off|important|all>'
        }
    }

    return command({
        type: 'set-tool-visibility',
        toolVisibility: tokens[0]
    })
}

function parseListSessionsCommand(tokens: string[]): FeishuChatInput {
    let listScope: 'all' | 'bound' = 'all'
    let repoPathPrefix: string | null = null
    let sawScope = false
    let sawPath = false

    for (const token of tokens) {
        if (token === 'all' || token === 'bound') {
            if (sawScope) {
                return {
                    kind: 'error',
                    error: `Duplicate /hapi list scope: ${token}`
                }
            }
            sawScope = true
            listScope = token
            continue
        }

        const assignment = parseAssignment(token)
        if (!assignment) {
            return {
                kind: 'error',
                error: `Unknown /hapi list argument: ${token}`
            }
        }

        if (assignment.key !== 'repo' && assignment.key !== 'path') {
            return {
                kind: 'error',
                error: `Unknown /hapi list argument: ${assignment.key}`
            }
        }
        if (sawPath) {
            return {
                kind: 'error',
                error: `Duplicate /hapi list argument: ${assignment.key}`
            }
        }
        sawPath = true
        repoPathPrefix = assignment.value
    }

    return command({
        type: 'list-sessions',
        listScope,
        repoPathPrefix
    })
}

function parseCreateSessionCommand(tokens: string[]): FeishuChatInput {
    let repoPath: string | null = null
    let model: string | null = null
    let sessionName: string | null = null
    let permissionMode: CodexPermissionMode = 'default'
    let machineId: string | null = null
    let worktreeName: string | null = null
    let collaborationMode: 'default' | 'plan' = 'default'

    const seenKeys = new Set<string>()
    let sawPlanFlag = false

    for (const token of tokens) {
        if (token === 'plan') {
            if (sawPlanFlag) {
                return {
                    kind: 'error',
                    error: 'Duplicate plan flag for /hapi new'
                }
            }
            sawPlanFlag = true
            collaborationMode = 'plan'
            continue
        }

        const assignment = parseAssignment(token)
        if (!assignment) {
            return {
                kind: 'error',
                error: `Unknown /hapi new argument: ${token}`
            }
        }

        if (seenKeys.has(assignment.key)) {
            return {
                kind: 'error',
                error: `Duplicate /hapi new argument: ${assignment.key}`
            }
        }
        seenKeys.add(assignment.key)

        switch (assignment.key) {
            case 'repo':
                repoPath = assignment.value
                break
            case 'model':
                model = assignment.value
                break
            case 'name':
                sessionName = assignment.value
                break
            case 'perm':
                if (!isFeishuPermissionMode(assignment.value)) {
                    return {
                        kind: 'error',
                        error: `Unsupported Feishu permission mode: ${assignment.value}`
                    }
                }
                permissionMode = assignment.value
                break
            case 'machine':
                machineId = assignment.value
                break
            case 'worktree':
                worktreeName = assignment.value
                break
            default:
                return {
                    kind: 'error',
                    error: `Unknown /hapi new argument: ${assignment.key}`
                }
        }
    }

    if (!model) {
        return {
            kind: 'error',
            error: 'model= is required for /hapi new'
        }
    }
    if (!repoPath) {
        return {
            kind: 'error',
            error: 'repo= is required for /hapi new'
        }
    }

    return command({
        type: 'new-session',
        repoPath,
        model,
        permissionMode,
        machineId,
        worktreeName,
        sessionName,
        collaborationMode
    })
}

function parseBoundThreadCommand(tokens: string[], originalText: string): FeishuChatInput {
    const [head, ...rest] = tokens

    switch (head) {
        case '/bg':
            return command({ type: 'set-delivery-mode', deliveryMode: 'background' })
        case '/fg':
            return command({ type: 'set-delivery-mode', deliveryMode: 'foreground' })
        case '/plan':
            if (rest.length !== 1 || (rest[0] !== 'on' && rest[0] !== 'off')) {
                return { kind: 'error', error: 'Expected /plan on or /plan off' }
            }
            return command({
                type: 'set-collaboration-mode',
                collaborationMode: rest[0] === 'on' ? 'plan' : 'default'
            })
        case '/perm':
            if (rest.length !== 1 || !isFeishuPermissionMode(rest[0])) {
                return {
                    kind: 'error',
                    error: `Unsupported Feishu permission mode: ${rest[0] ?? ''}`.trim()
                }
            }
            return command({ type: 'set-permission-mode', permissionMode: rest[0] })
        case '/stop':
            if (rest.length !== 0) {
                return { kind: 'error', error: 'Unexpected arguments for /stop' }
            }
            return command({ type: 'stop-session' })
        case '/close':
            if (rest.length !== 0) {
                return { kind: 'error', error: 'Unexpected arguments for /close' }
            }
            return command({ type: 'close-session' })
        case '/approve':
            return parseResolveRequestCommand(rest, 'approved')
        case '/deny':
            return parseResolveRequestCommand(rest, 'denied')
        case '/abort':
            return parseResolveRequestCommand(rest, 'abort')
        case '/choose':
            return parseChooseCommand(rest)
        default:
            return { kind: 'text', text: originalText }
    }
}

function parseResolveRequestCommand(
    tokens: string[],
    fallbackDecision: Exclude<FeishuRequestDecision, 'approved_for_session'>
): FeishuChatInput {
    let requestToken: string | null = null
    let decision: FeishuRequestDecision = fallbackDecision

    for (const token of tokens) {
        const parsedToken = parseFeishuRequestToken(token)
        if (parsedToken) {
            requestToken = parsedToken
            continue
        }

        if (token === 'once') {
            decision = fallbackDecision
            continue
        }

        if (token === 'session' && fallbackDecision === 'approved') {
            decision = 'approved_for_session'
            continue
        }

        return {
            kind: 'error',
            error: `Unsupported ${fallbackDecision === 'approved' ? '/approve' : fallbackDecision === 'denied' ? '/deny' : '/abort'} argument: ${token}`
        }
    }

    return command({
        type: 'resolve-request',
        requestToken,
        decision
    })
}

function parseChooseCommand(tokens: string[]): FeishuChatInput {
    let requestToken: string | null = null
    let value: string | null = null

    for (const token of tokens) {
        const parsedToken = parseFeishuRequestToken(token)
        if (parsedToken) {
            requestToken = parsedToken
            continue
        }

        if (value === null) {
            value = token
            continue
        }

        return {
            kind: 'error',
            error: `Unsupported /choose value: ${token}`
        }
    }

    const parsedChoice = value ? parseFeishuChoiceValue(value) : null
    if (!parsedChoice) {
        return {
            kind: 'error',
            error: `Unsupported /choose value: ${value ?? ''}`.trim()
        }
    }

    return command({
        type: 'choose',
        requestToken,
        value: parsedChoice
    })
}

function tokenize(text: string): TokenizedCommand {
    const tokens: string[] = []
    let current = ''
    let quote: '"' | '\'' | null = null
    let escape = false

    for (const char of text.trim()) {
        if (escape) {
            current += char
            escape = false
            continue
        }

        if (char === '\\' && quote !== null) {
            escape = true
            continue
        }

        if (quote !== null) {
            if (char === quote) {
                quote = null
            } else {
                current += char
            }
            continue
        }

        if (char === '"' || char === '\'') {
            quote = char
            continue
        }

        if (/\s/.test(char)) {
            if (current) {
                tokens.push(current)
                current = ''
            }
            continue
        }

        current += char
    }

    if (escape || quote !== null) {
        return {
            tokens: [],
            error: 'Unterminated quoted argument'
        }
    }

    if (current) {
        tokens.push(current)
    }

    return {
        tokens,
        error: null
    }
}

function parseAssignment(token: string): { key: string; value: string } | null {
    const index = token.indexOf('=')
    if (index <= 0 || index === token.length - 1) {
        return null
    }

    return {
        key: token.slice(0, index),
        value: token.slice(index + 1)
    }
}

function isFeishuPermissionMode(value: string): value is CodexPermissionMode {
    return CODEX_PERMISSION_MODES.includes(value as CodexPermissionMode)
}

function isFeishuReasoningSummary(value: string): value is FeishuReasoningSummary {
    return FEISHU_REASONING_SUMMARIES.includes(value as FeishuReasoningSummary)
}

function isFeishuToolVisibility(value: string): value is FeishuToolVisibility {
    return FEISHU_TOOL_VISIBILITIES.includes(value as FeishuToolVisibility)
}

function command(commandValue: FeishuChatCommand): FeishuChatInput {
    return {
        kind: 'command',
        command: commandValue
    }
}

function mapParsedCommand(commandValue: FeishuChatCommand): ParsedFeishuCommand {
    switch (commandValue.type) {
        case 'status':
            return {
                scope: 'global',
                kind: 'status'
            }
        case 'new-session':
            return {
                scope: 'global',
                kind: 'new-session',
                repoPath: commandValue.repoPath,
                model: commandValue.model,
                sessionName: commandValue.sessionName,
                permissionMode: commandValue.permissionMode,
                machineId: commandValue.machineId,
                worktreeName: commandValue.worktreeName,
                startInPlanMode: commandValue.collaborationMode === 'plan'
            }
        case 'list-sessions':
            return {
                scope: 'global',
                kind: 'list-sessions',
                listScope: commandValue.listScope,
                repoPathPrefix: commandValue.repoPathPrefix
            }
        case 'show-session':
            return {
                scope: 'global',
                kind: 'show-session',
                sessionId: commandValue.sessionId
            }
        case 'attach-session':
            return {
                scope: 'global',
                kind: 'attach-session',
                sessionId: commandValue.sessionId
            }
        case 'unattach-session':
            return {
                scope: 'global',
                kind: 'unattach-session',
                sessionId: commandValue.sessionId
            }
        case 'set-delivery-mode':
            return {
                scope: 'thread',
                kind: 'set-delivery-mode',
                deliveryMode: commandValue.deliveryMode
            }
        case 'set-collaboration-mode':
            return {
                scope: 'thread',
                kind: 'set-collaboration-mode',
                collaborationMode: commandValue.collaborationMode
            }
        case 'set-permission-mode':
            return {
                scope: 'thread',
                kind: 'set-permission-mode',
                permissionMode: commandValue.permissionMode
            }
        case 'set-reasoning-summary':
            return {
                scope: 'thread',
                kind: 'set-reasoning-summary',
                reasoningSummary: commandValue.reasoningSummary
            }
        case 'set-tool-visibility':
            return {
                scope: 'thread',
                kind: 'set-tool-visibility',
                toolVisibility: commandValue.toolVisibility
            }
        case 'stop-session':
            return {
                scope: 'thread',
                kind: 'stop-session'
            }
        case 'close-session':
            return {
                scope: 'thread',
                kind: 'close-session'
            }
        case 'resolve-request':
            return {
                scope: 'thread',
                kind: 'resolve-request',
                decision: commandValue.decision,
                requestToken: commandValue.requestToken,
                ...(commandValue.decision === 'approved'
                    ? { approvalScope: 'request' as const }
                    : commandValue.decision === 'approved_for_session'
                        ? { approvalScope: 'session' as const }
                        : {})
            }
        case 'choose':
            return {
                scope: 'thread',
                kind: 'choose-option',
                requestToken: commandValue.requestToken,
                choice: commandValue.value
            }
    }
}
