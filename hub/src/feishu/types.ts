export type FeishuPermissionMode = 'default' | 'read-only' | 'safe-yolo' | 'yolo'

export type FeishuChoiceValue = 'A' | 'B' | 'C' | 'yes' | 'no'

export type FeishuChatCommand =
    | {
        type: 'status'
    }
    | {
        type: 'new-session'
        repoPath: string
        model: string
        permissionMode: FeishuPermissionMode
        machineId: string | null
        worktreeName: string | null
        sessionName: string | null
        collaborationMode: 'default' | 'plan'
    }
    | {
        type: 'list-sessions'
        listScope: 'all' | 'bound'
        repoPathPrefix: string | null
    }
    | {
        type: 'show-session'
        sessionId: string | null
    }
    | {
        type: 'attach-session'
        sessionId: string
    }
    | {
        type: 'unattach-session'
        sessionId: string | null
    }
    | {
        type: 'set-delivery-mode'
        deliveryMode: 'foreground' | 'background'
    }
    | {
        type: 'set-collaboration-mode'
        collaborationMode: 'default' | 'plan'
    }
    | {
        type: 'set-permission-mode'
        permissionMode: FeishuPermissionMode
    }
    | {
        type: 'stop-session'
    }
    | {
        type: 'close-session'
    }
    | {
        type: 'resolve-request'
        requestToken: string | null
        decision: 'approved' | 'approved_for_session' | 'denied' | 'abort'
    }
    | {
        type: 'choose'
        requestToken: string | null
        value: FeishuChoiceValue
    }

export type FeishuChatInputParseResult =
    | {
        kind: 'command'
        command: FeishuChatCommand
    }
    | {
        kind: 'choice'
        value: FeishuChoiceValue
    }
    | {
        kind: 'text'
        text: string
    }
    | {
        kind: 'error'
        error: string
    }

export type FeishuChoiceReply = Extract<FeishuChatInputParseResult, { kind: 'choice' }>

export type FeishuChatInput = FeishuChatInputParseResult

export type FeishuCommandParseContext = {
    boundThread: boolean
}

export type FeishuRequestDecision = 'approved' | 'approved_for_session' | 'denied' | 'abort'

export type ParsedFeishuCommand =
    | {
        scope: 'chat'
        kind: 'status'
    }
    | {
        scope: 'global'
        kind: 'new-session'
        repoPath: string
        model: string
        sessionName: string | null
        permissionMode: FeishuPermissionMode
        machineId: string | null
        worktreeName: string | null
        startInPlanMode: boolean
    }
    | {
        scope: 'global'
        kind: 'list-sessions'
        listScope: 'all' | 'bound'
        repoPathPrefix: string | null
    }
    | {
        scope: 'global'
        kind: 'show-session'
        sessionId: string | null
    }
    | {
        scope: 'global'
        kind: 'attach-session'
        sessionId: string
    }
    | {
        scope: 'global'
        kind: 'unattach-session'
        sessionId: string | null
    }
    | {
        scope: 'thread'
        kind: 'set-delivery-mode'
        deliveryMode: 'foreground' | 'background'
    }
    | {
        scope: 'thread'
        kind: 'set-collaboration-mode'
        collaborationMode: 'default' | 'plan'
    }
    | {
        scope: 'thread'
        kind: 'set-permission-mode'
        permissionMode: FeishuPermissionMode
    }
    | {
        scope: 'thread'
        kind: 'stop-session'
    }
    | {
        scope: 'thread'
        kind: 'close-session'
    }
    | {
        scope: 'thread'
        kind: 'resolve-request'
        decision: FeishuRequestDecision
        requestToken: string | null
        approvalScope?: 'request' | 'session'
    }
    | {
        scope: 'thread'
        kind: 'choose-option'
        requestToken: string | null
        choice: FeishuChoiceValue
    }
    | {
        scope: 'error'
        message: string
    }

export type ParsedImplicitFeishuChoice = {
    choice: FeishuChoiceValue
}

export type FeishuWebhookConfig = {
    verificationToken: string | null
    encryptKey: string | null
}

export type FeishuInboundMessageEvent = {
    eventId: string
    openId: string
    chatId: string
    messageId: string
    rootMessageId: string | null
    parentMessageId: string | null
    threadRootMessageId: string
    messageType: string
    chatType: string
    content: string
    createTime: string | null
}
