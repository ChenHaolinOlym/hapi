import { describe, expect, it } from 'bun:test'

import {
    parseFeishuChatInput,
    parseFeishuCommand,
    tokenizeFeishuCommandText
} from './commands'

describe('tokenizeFeishuCommandText', () => {
    it('splits key value pairs while preserving quoted segments', () => {
        expect(tokenizeFeishuCommandText('/hapi new repo=/tmp/repo model=gpt-5.4 name="bridge test" plan')).toEqual([
            '/hapi',
            'new',
            'repo=/tmp/repo',
            'model=gpt-5.4',
            'name=bridge test',
            'plan'
        ])
    })
})

describe('parseFeishuCommand', () => {
    it('parses /hapi new with required and optional fields', () => {
        expect(parseFeishuCommand('/hapi new repo=/tmp/repo model=gpt-5.4 name="bridge test" perm=safe-yolo machine=mac-mini worktree=feat plan')).toEqual({
            scope: 'global',
            kind: 'new-session',
            repoPath: '/tmp/repo',
            model: 'gpt-5.4',
            sessionName: 'bridge test',
            permissionMode: 'safe-yolo',
            machineId: 'mac-mini',
            worktreeName: 'feat',
            startInPlanMode: true
        })
    })

    it('requires model for /hapi new', () => {
        expect(parseFeishuCommand('/hapi new repo=/tmp/repo')).toEqual({
            scope: 'error',
            message: 'model= is required for /hapi new'
        })
    })

    it('parses global list and show commands', () => {
        expect(parseFeishuCommand('/hapi list')).toEqual({
            scope: 'global',
            kind: 'list-sessions',
            listScope: 'all',
            repoPathPrefix: null
        })
        expect(parseFeishuCommand('/hapi list bound')).toEqual({
            scope: 'global',
            kind: 'list-sessions',
            listScope: 'bound',
            repoPathPrefix: null
        })
        expect(parseFeishuCommand('/hapi list all repo=/tmp/repo')).toEqual({
            scope: 'global',
            kind: 'list-sessions',
            listScope: 'all',
            repoPathPrefix: '/tmp/repo'
        })
        expect(parseFeishuCommand('/hapi show')).toEqual({
            scope: 'global',
            kind: 'show-session',
            sessionId: null
        })
        expect(parseFeishuCommand('/hapi show session-123')).toEqual({
            scope: 'global',
            kind: 'show-session',
            sessionId: 'session-123'
        })
    })

    it('parses /status as a chat-level command', () => {
        expect(parseFeishuCommand('/status')).toEqual({
            scope: 'chat',
            kind: 'status'
        })
    })

    it('keeps /hapi new available while bound', () => {
        expect(parseFeishuChatInput('/hapi new repo=/tmp/repo model=gpt-5.4', {
            boundThread: true
        })).toEqual({
            kind: 'command',
            command: {
                type: 'new-session',
                repoPath: '/tmp/repo',
                model: 'gpt-5.4',
                permissionMode: 'default',
                machineId: null,
                worktreeName: null,
                sessionName: null,
                collaborationMode: 'default'
            }
        })
    })

    it('keeps /hapi list and /hapi show available while bound', () => {
        expect(parseFeishuChatInput('/hapi list', {
            boundThread: true
        })).toEqual({
            kind: 'command',
            command: {
                type: 'list-sessions',
                listScope: 'all',
                repoPathPrefix: null
            }
        })
        expect(parseFeishuChatInput('/hapi show session-123', {
            boundThread: true
        })).toEqual({
            kind: 'command',
            command: {
                type: 'show-session',
                sessionId: 'session-123'
            }
        })
        expect(parseFeishuChatInput('/hapi show', {
            boundThread: true
        })).toEqual({
            kind: 'command',
            command: {
                type: 'show-session',
                sessionId: null
            }
        })
    })

    it('parses attach, use, and unattach commands', () => {
        expect(parseFeishuCommand('/hapi attach session-123')).toEqual({
            scope: 'global',
            kind: 'attach-session',
            sessionId: 'session-123'
        })
        expect(parseFeishuCommand('/hapi use session-456')).toEqual({
            scope: 'global',
            kind: 'attach-session',
            sessionId: 'session-456'
        })
        expect(parseFeishuCommand('/hapi unattach')).toEqual({
            scope: 'global',
            kind: 'unattach-session',
            sessionId: null
        })
        expect(parseFeishuCommand('/hapi unattach session-789')).toEqual({
            scope: 'global',
            kind: 'unattach-session',
            sessionId: 'session-789'
        })
    })

    it('rejects /bg /fg /plan in the current MVP cut', () => {
        expect(parseFeishuCommand('/bg')).toEqual({
            scope: 'error',
            message: '/bg is not supported in the current Feishu MVP'
        })
        expect(parseFeishuCommand('/fg')).toEqual({
            scope: 'error',
            message: '/fg is not supported in the current Feishu MVP'
        })
        expect(parseFeishuCommand('/plan on')).toEqual({
            scope: 'error',
            message: '/plan is not supported in the current Feishu MVP'
        })
        expect(parseFeishuCommand('/plan off')).toEqual({
            scope: 'error',
            message: '/plan is not supported in the current Feishu MVP'
        })
    })

    it('parses remaining bound thread control commands', () => {
        expect(parseFeishuCommand('/perm read-only')).toEqual({
            scope: 'thread',
            kind: 'set-permission-mode',
            permissionMode: 'read-only'
        })
    })

    it('parses approval and question commands with optional request tokens', () => {
        expect(parseFeishuCommand('/approve r:ab12 once')).toEqual({
            scope: 'thread',
            kind: 'resolve-request',
            decision: 'approved',
            requestToken: 'ab12',
            approvalScope: 'request'
        })
        expect(parseFeishuCommand('/approve session')).toEqual({
            scope: 'thread',
            kind: 'resolve-request',
            decision: 'approved_for_session',
            requestToken: null,
            approvalScope: 'session'
        })
        expect(parseFeishuCommand('/deny r:ab12')).toEqual({
            scope: 'thread',
            kind: 'resolve-request',
            decision: 'denied',
            requestToken: 'ab12'
        })
        expect(parseFeishuCommand('/abort r:ab12')).toEqual({
            scope: 'thread',
            kind: 'resolve-request',
            decision: 'abort',
            requestToken: 'ab12'
        })
        expect(parseFeishuCommand('/choose r:ab12 2')).toEqual({
            scope: 'thread',
            kind: 'choose-option',
            requestToken: 'ab12',
            choice: 'B'
        })
    })

    it('returns null for non-command input', () => {
        expect(parseFeishuCommand('please continue')).toBeNull()
    })
})
