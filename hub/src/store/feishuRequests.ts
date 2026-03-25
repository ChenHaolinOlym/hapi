import type { Database } from 'bun:sqlite'

import type { StoredFeishuRequest } from './types'

type DbFeishuRequestRow = {
    namespace: string
    session_id: string
    request_id: string
    short_token: string
    kind: string
    decision_scope: string
    answer_shape: string
    feishu_message_id: string | null
    request_json: string
    status: string
    created_at: number
    resolved_at: number | null
}

function toStoredFeishuRequest(row: DbFeishuRequestRow): StoredFeishuRequest {
    return {
        namespace: row.namespace,
        sessionId: row.session_id,
        requestId: row.request_id,
        shortToken: row.short_token,
        kind: row.kind as StoredFeishuRequest['kind'],
        decisionScope: row.decision_scope as StoredFeishuRequest['decisionScope'],
        answerShape: row.answer_shape as StoredFeishuRequest['answerShape'],
        feishuMessageId: row.feishu_message_id,
        requestJson: row.request_json,
        status: row.status as StoredFeishuRequest['status'],
        createdAt: row.created_at,
        resolvedAt: row.resolved_at
    }
}

export function getFeishuRequest(
    db: Database,
    namespace: string,
    sessionId: string,
    requestId: string
): StoredFeishuRequest | null {
    const row = db.prepare(`
        SELECT * FROM feishu_requests
        WHERE namespace = ? AND session_id = ? AND request_id = ?
        LIMIT 1
    `).get(namespace, sessionId, requestId) as DbFeishuRequestRow | undefined
    return row ? toStoredFeishuRequest(row) : null
}

export function listOpenFeishuRequestsForSession(
    db: Database,
    namespace: string,
    sessionId: string
): StoredFeishuRequest[] {
    const rows = db.prepare(`
        SELECT * FROM feishu_requests
        WHERE namespace = ? AND session_id = ? AND status = 'open'
        ORDER BY created_at ASC
    `).all(namespace, sessionId) as DbFeishuRequestRow[]
    return rows.map(toStoredFeishuRequest)
}

export function findFeishuRequestByShortToken(
    db: Database,
    namespace: string,
    shortToken: string
): StoredFeishuRequest | null {
    const row = db.prepare(`
        SELECT * FROM feishu_requests
        WHERE namespace = ? AND short_token = ?
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT 1
    `).get(namespace, shortToken) as DbFeishuRequestRow | undefined
    return row ? toStoredFeishuRequest(row) : null
}

export function findFeishuRequestByMessageId(
    db: Database,
    namespace: string,
    feishuMessageId: string
): StoredFeishuRequest | null {
    const row = db.prepare(`
        SELECT * FROM feishu_requests
        WHERE namespace = ? AND feishu_message_id = ?
        ORDER BY (status = 'open') DESC, created_at DESC
        LIMIT 1
    `).get(namespace, feishuMessageId) as DbFeishuRequestRow | undefined
    return row ? toStoredFeishuRequest(row) : null
}

export function upsertFeishuRequest(
    db: Database,
    request: Omit<StoredFeishuRequest, 'createdAt' | 'resolvedAt'>
): StoredFeishuRequest {
    const now = Date.now()
    const resolvedAt = request.status === 'resolved' ? now : null
    db.prepare(`
        INSERT INTO feishu_requests (
            namespace, session_id, request_id, short_token, kind,
            decision_scope, answer_shape, feishu_message_id, request_json,
            status, created_at, resolved_at
        ) VALUES (
            @namespace, @session_id, @request_id, @short_token, @kind,
            @decision_scope, @answer_shape, @feishu_message_id, @request_json,
            @status, @created_at, @resolved_at
        )
        ON CONFLICT(namespace, session_id, request_id) DO UPDATE SET
            short_token = excluded.short_token,
            kind = excluded.kind,
            decision_scope = excluded.decision_scope,
            answer_shape = excluded.answer_shape,
            feishu_message_id = excluded.feishu_message_id,
            request_json = excluded.request_json,
            status = excluded.status,
            resolved_at = excluded.resolved_at
    `).run({
        namespace: request.namespace,
        session_id: request.sessionId,
        request_id: request.requestId,
        short_token: request.shortToken,
        kind: request.kind,
        decision_scope: request.decisionScope,
        answer_shape: request.answerShape,
        feishu_message_id: request.feishuMessageId,
        request_json: request.requestJson,
        status: request.status,
        created_at: now,
        resolved_at: resolvedAt
    })

    const row = getFeishuRequest(db, request.namespace, request.sessionId, request.requestId)
    if (!row) {
        throw new Error('Failed to upsert Feishu request')
    }
    return row
}

export function markFeishuRequestResolved(
    db: Database,
    namespace: string,
    sessionId: string,
    requestId: string
): boolean {
    const result = db.prepare(`
        UPDATE feishu_requests
        SET status = 'resolved',
            resolved_at = @resolved_at
        WHERE namespace = @namespace
          AND session_id = @session_id
          AND request_id = @request_id
          AND status = 'open'
    `).run({
        namespace,
        session_id: sessionId,
        request_id: requestId,
        resolved_at: Date.now()
    })
    return result.changes === 1
}

export function markFeishuRequestStale(
    db: Database,
    namespace: string,
    sessionId: string,
    requestId: string
): boolean {
    const result = db.prepare(`
        UPDATE feishu_requests
        SET status = 'stale',
            resolved_at = NULL
        WHERE namespace = @namespace
          AND session_id = @session_id
          AND request_id = @request_id
          AND status = 'open'
    `).run({
        namespace,
        session_id: sessionId,
        request_id: requestId
    })
    return result.changes === 1
}
