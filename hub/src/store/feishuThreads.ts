import type { Database } from 'bun:sqlite'

import type { StoredFeishuThread } from './types'

type DbFeishuThreadRow = {
    namespace: string
    chat_id: string
    root_message_id: string
    session_id: string
    operator_open_id: string
    machine_id: string | null
    repo_path: string
    session_name: string | null
    model: string | null
    permission_mode: string
    collaboration_mode: string
    delivery_mode: string
    phase: string
    attention: string
    last_forwarded_seq: number | null
    active_turn_seq: number | null
    last_seen_ready_at: number | null
    created_at: number
    updated_at: number
}

function toStoredFeishuThread(row: DbFeishuThreadRow): StoredFeishuThread {
    return {
        namespace: row.namespace,
        chatId: row.chat_id,
        rootMessageId: row.root_message_id,
        sessionId: row.session_id,
        operatorOpenId: row.operator_open_id,
        machineId: row.machine_id,
        repoPath: row.repo_path,
        sessionName: row.session_name,
        model: row.model,
        permissionMode: row.permission_mode as StoredFeishuThread['permissionMode'],
        collaborationMode: row.collaboration_mode as StoredFeishuThread['collaborationMode'],
        deliveryMode: row.delivery_mode as StoredFeishuThread['deliveryMode'],
        phase: row.phase as StoredFeishuThread['phase'],
        attention: row.attention as StoredFeishuThread['attention'],
        lastForwardedSeq: row.last_forwarded_seq,
        activeTurnSeq: row.active_turn_seq,
        lastSeenReadyAt: row.last_seen_ready_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

export function getFeishuThread(
    db: Database,
    namespace: string,
    chatId: string,
    rootMessageId: string
): StoredFeishuThread | null {
    const row = db.prepare(`
        SELECT * FROM feishu_threads
        WHERE namespace = ? AND chat_id = ? AND root_message_id = ?
        LIMIT 1
    `).get(namespace, chatId, rootMessageId) as DbFeishuThreadRow | undefined
    return row ? toStoredFeishuThread(row) : null
}

export function getFeishuThreadBySessionId(
    db: Database,
    namespace: string,
    sessionId: string
): StoredFeishuThread | null {
    const row = db.prepare(`
        SELECT * FROM feishu_threads
        WHERE namespace = ? AND session_id = ?
        ORDER BY updated_at DESC
        LIMIT 1
    `).get(namespace, sessionId) as DbFeishuThreadRow | undefined
    return row ? toStoredFeishuThread(row) : null
}

export function getFeishuThreadsBySessionId(
    db: Database,
    namespace: string,
    sessionId: string
): StoredFeishuThread[] {
    const rows = db.prepare(`
        SELECT * FROM feishu_threads
        WHERE namespace = ? AND session_id = ?
        ORDER BY updated_at DESC
    `).all(namespace, sessionId) as DbFeishuThreadRow[]
    return rows.map(toStoredFeishuThread)
}

export function getFeishuThreadsByNamespace(db: Database, namespace: string): StoredFeishuThread[] {
    const rows = db.prepare(`
        SELECT * FROM feishu_threads
        WHERE namespace = ?
        ORDER BY updated_at DESC
    `).all(namespace) as DbFeishuThreadRow[]
    return rows.map(toStoredFeishuThread)
}

export function getFeishuThreadsForChat(
    db: Database,
    namespace: string,
    chatId: string,
    operatorOpenId: string
): StoredFeishuThread[] {
    const rows = db.prepare(`
        SELECT * FROM feishu_threads
        WHERE namespace = ? AND chat_id = ? AND operator_open_id = ?
        ORDER BY updated_at DESC
    `).all(namespace, chatId, operatorOpenId) as DbFeishuThreadRow[]
    return rows.map(toStoredFeishuThread)
}

export function upsertFeishuThread(
    db: Database,
    binding: Omit<StoredFeishuThread, 'createdAt' | 'updatedAt'>
): StoredFeishuThread {
    const now = Date.now()
    db.prepare(`
        INSERT INTO feishu_threads (
            namespace, chat_id, root_message_id, session_id, operator_open_id,
            machine_id, repo_path, session_name, model, permission_mode,
            collaboration_mode, delivery_mode, phase, attention,
            last_forwarded_seq, active_turn_seq, last_seen_ready_at, created_at, updated_at
        ) VALUES (
            @namespace, @chat_id, @root_message_id, @session_id, @operator_open_id,
            @machine_id, @repo_path, @session_name, @model, @permission_mode,
            @collaboration_mode, @delivery_mode, @phase, @attention,
            @last_forwarded_seq, @active_turn_seq, @last_seen_ready_at, @created_at, @updated_at
        )
        ON CONFLICT(namespace, chat_id, root_message_id) DO UPDATE SET
            session_id = excluded.session_id,
            operator_open_id = excluded.operator_open_id,
            machine_id = excluded.machine_id,
            repo_path = excluded.repo_path,
            session_name = excluded.session_name,
            model = excluded.model,
            permission_mode = excluded.permission_mode,
            collaboration_mode = excluded.collaboration_mode,
            delivery_mode = excluded.delivery_mode,
            phase = excluded.phase,
            attention = excluded.attention,
            last_forwarded_seq = excluded.last_forwarded_seq,
            active_turn_seq = excluded.active_turn_seq,
            last_seen_ready_at = excluded.last_seen_ready_at,
            updated_at = excluded.updated_at
    `).run({
        namespace: binding.namespace,
        chat_id: binding.chatId,
        root_message_id: binding.rootMessageId,
        session_id: binding.sessionId,
        operator_open_id: binding.operatorOpenId,
        machine_id: binding.machineId,
        repo_path: binding.repoPath,
        session_name: binding.sessionName,
        model: binding.model,
        permission_mode: binding.permissionMode,
        collaboration_mode: binding.collaborationMode,
        delivery_mode: binding.deliveryMode,
        phase: binding.phase,
        attention: binding.attention,
        last_forwarded_seq: binding.lastForwardedSeq,
        active_turn_seq: binding.activeTurnSeq,
        last_seen_ready_at: binding.lastSeenReadyAt,
        created_at: now,
        updated_at: now
    })

    const row = getFeishuThread(db, binding.namespace, binding.chatId, binding.rootMessageId)
    if (!row) {
        throw new Error('Failed to upsert Feishu thread binding')
    }
    return row
}

export function deleteFeishuThread(
    db: Database,
    namespace: string,
    chatId: string,
    rootMessageId: string
): number {
    const result = db.prepare(`
        DELETE FROM feishu_threads
        WHERE namespace = ? AND chat_id = ? AND root_message_id = ?
    `).run(namespace, chatId, rootMessageId)
    return Number(result.changes ?? 0)
}

export function deleteFeishuThreadsBySessionId(
    db: Database,
    namespace: string,
    sessionId: string
): number {
    const result = db.prepare(`
        DELETE FROM feishu_threads
        WHERE namespace = ? AND session_id = ?
    `).run(namespace, sessionId)
    return Number(result.changes ?? 0)
}
