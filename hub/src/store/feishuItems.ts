import type { Database } from 'bun:sqlite'

import type { FeishuItemUpsertInput, StoredFeishuItem } from './types'

type DbFeishuItemRow = {
    namespace: string
    chat_id: string
    root_message_id: string
    session_id: string
    item_key: string
    item_type: string
    status: string
    source_id: string | null
    feishu_message_id: string | null
    render_state_json: string | null
    render_version: number
    created_at: number
    updated_at: number
}

function toStoredFeishuItem(row: DbFeishuItemRow): StoredFeishuItem {
    return {
        namespace: row.namespace,
        chatId: row.chat_id,
        rootMessageId: row.root_message_id,
        sessionId: row.session_id,
        itemKey: row.item_key,
        itemType: row.item_type as StoredFeishuItem['itemType'],
        status: row.status as StoredFeishuItem['status'],
        sourceId: row.source_id,
        feishuMessageId: row.feishu_message_id,
        renderStateJson: row.render_state_json,
        renderVersion: row.render_version,
        createdAt: row.created_at,
        updatedAt: row.updated_at
    }
}

function getFeishuItemStatusRank(status: StoredFeishuItem['status']): number {
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

function mergeSameVersionItem(
    existing: StoredFeishuItem,
    incoming: FeishuItemUpsertInput
): FeishuItemUpsertInput {
    const sameOwner = incoming.chatId === existing.chatId && incoming.sessionId === existing.sessionId

    return {
        ...incoming,
        chatId: existing.chatId,
        sessionId: existing.sessionId,
        itemType: existing.itemType,
        status: getFeishuItemStatusRank(incoming.status) >= getFeishuItemStatusRank(existing.status)
            ? incoming.status
            : existing.status,
        sourceId: existing.sourceId ?? incoming.sourceId ?? null,
        feishuMessageId: sameOwner
            ? incoming.feishuMessageId ?? existing.feishuMessageId
            : existing.feishuMessageId,
        renderStateJson: sameOwner
            ? incoming.renderStateJson ?? existing.renderStateJson
            : existing.renderStateJson
    }
}

export function getFeishuItem(
    db: Database,
    namespace: string,
    rootMessageId: string,
    itemKey: string
): StoredFeishuItem | null {
    const row = db.prepare(`
        SELECT * FROM feishu_items
        WHERE namespace = ? AND root_message_id = ? AND item_key = ?
        LIMIT 1
    `).get(namespace, rootMessageId, itemKey) as DbFeishuItemRow | undefined
    return row ? toStoredFeishuItem(row) : null
}

export function listFeishuItemsForRootMessage(
    db: Database,
    namespace: string,
    rootMessageId: string
): StoredFeishuItem[] {
    const rows = db.prepare(`
        SELECT * FROM feishu_items
        WHERE namespace = ? AND root_message_id = ?
        ORDER BY created_at ASC, item_key ASC
    `).all(namespace, rootMessageId) as DbFeishuItemRow[]
    return rows.map(toStoredFeishuItem)
}

export function deleteFeishuItemsForRootMessage(
    db: Database,
    namespace: string,
    rootMessageId: string
): number {
    const result = db.prepare(`
        DELETE FROM feishu_items
        WHERE namespace = ? AND root_message_id = ?
    `).run(namespace, rootMessageId)
    return Number(result.changes ?? 0)
}

export function deleteFeishuItemsBySessionId(
    db: Database,
    namespace: string,
    sessionId: string
): number {
    const result = db.prepare(`
        DELETE FROM feishu_items
        WHERE namespace = ? AND session_id = ?
    `).run(namespace, sessionId)
    return Number(result.changes ?? 0)
}

export function reassignFeishuItemsSessionId(
    db: Database,
    namespace: string,
    fromSessionId: string,
    toSessionId: string
): number {
    if (fromSessionId === toSessionId) {
        return 0
    }

    const result = db.prepare(`
        UPDATE feishu_items
        SET session_id = @to_session_id,
            updated_at = @updated_at
        WHERE namespace = @namespace
          AND session_id = @from_session_id
    `).run({
        namespace,
        from_session_id: fromSessionId,
        to_session_id: toSessionId,
        updated_at: Date.now()
    })
    return Number(result.changes ?? 0)
}

export function reassignFeishuItemsForRootMessage(
    db: Database,
    namespace: string,
    rootMessageId: string,
    toSessionId: string
): number {
    const result = db.prepare(`
        UPDATE feishu_items
        SET session_id = @to_session_id,
            updated_at = @updated_at
        WHERE namespace = @namespace
          AND root_message_id = @root_message_id
    `).run({
        namespace,
        root_message_id: rootMessageId,
        to_session_id: toSessionId,
        updated_at: Date.now()
    })
    return Number(result.changes ?? 0)
}

export function upsertFeishuItem(
    db: Database,
    item: FeishuItemUpsertInput
): StoredFeishuItem {
    const existing = getFeishuItem(db, item.namespace, item.rootMessageId, item.itemKey)
    if (existing && item.renderVersion < existing.renderVersion) {
        return existing
    }

    const nextItem = existing && item.renderVersion === existing.renderVersion
        ? mergeSameVersionItem(existing, item)
        : item
    const now = Date.now()
    const createdAt = existing?.createdAt
        ?? allocateFeishuItemCreatedAt(db, nextItem.namespace, nextItem.rootMessageId, now)
    db.prepare(`
        INSERT INTO feishu_items (
            namespace, chat_id, root_message_id, session_id,
            item_key, item_type, status, source_id, feishu_message_id, render_state_json,
            render_version, created_at, updated_at
        ) VALUES (
            @namespace, @chat_id, @root_message_id, @session_id,
            @item_key, @item_type, @status, @source_id, @feishu_message_id, @render_state_json,
            @render_version, @created_at, @updated_at
        )
        ON CONFLICT(namespace, root_message_id, item_key) DO UPDATE SET
            chat_id = excluded.chat_id,
            session_id = excluded.session_id,
            item_type = excluded.item_type,
            status = excluded.status,
            source_id = excluded.source_id,
            feishu_message_id = excluded.feishu_message_id,
            render_state_json = excluded.render_state_json,
            render_version = excluded.render_version,
            updated_at = excluded.updated_at
        WHERE excluded.render_version >= feishu_items.render_version
    `).run({
        namespace: nextItem.namespace,
        chat_id: nextItem.chatId,
        root_message_id: nextItem.rootMessageId,
        session_id: nextItem.sessionId,
        item_key: nextItem.itemKey,
        item_type: nextItem.itemType,
        status: nextItem.status,
        source_id: nextItem.sourceId ?? null,
        feishu_message_id: nextItem.feishuMessageId,
        render_state_json: nextItem.renderStateJson ?? null,
        render_version: nextItem.renderVersion,
        created_at: createdAt,
        updated_at: now
    })

    const row = getFeishuItem(db, nextItem.namespace, nextItem.rootMessageId, nextItem.itemKey)
    if (!row) {
        throw new Error('Failed to upsert Feishu item')
    }
    return row
}

function allocateFeishuItemCreatedAt(
    db: Database,
    namespace: string,
    rootMessageId: string,
    now: number
): number {
    const row = db.prepare(`
        SELECT MAX(created_at) AS max_created_at
        FROM feishu_items
        WHERE namespace = ? AND root_message_id = ?
    `).get(namespace, rootMessageId) as { max_created_at?: number | null } | undefined

    const maxCreatedAt = typeof row?.max_created_at === 'number' ? row.max_created_at : null
    if (maxCreatedAt === null) {
        return now
    }

    return Math.max(now, maxCreatedAt + 1)
}
