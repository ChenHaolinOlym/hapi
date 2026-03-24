import type { Database } from 'bun:sqlite'

import type { StoredFeishuSeenEvent } from './types'

type DbFeishuSeenEventRow = {
    source: string
    external_event_id: string
    seen_at: number
}

function toStoredFeishuSeenEvent(row: DbFeishuSeenEventRow): StoredFeishuSeenEvent {
    return {
        source: row.source as StoredFeishuSeenEvent['source'],
        externalEventId: row.external_event_id,
        seenAt: row.seen_at
    }
}

export function getFeishuSeenEvent(
    db: Database,
    source: StoredFeishuSeenEvent['source'],
    externalEventId: string
): StoredFeishuSeenEvent | null {
    const row = db.prepare(`
        SELECT * FROM feishu_seen_events
        WHERE source = ? AND external_event_id = ?
        LIMIT 1
    `).get(source, externalEventId) as DbFeishuSeenEventRow | undefined
    return row ? toStoredFeishuSeenEvent(row) : null
}

export function hasSeenFeishuEvent(
    db: Database,
    source: StoredFeishuSeenEvent['source'],
    externalEventId: string
): boolean {
    return getFeishuSeenEvent(db, source, externalEventId) !== null
}

export function markFeishuEventSeen(
    db: Database,
    source: StoredFeishuSeenEvent['source'],
    externalEventId: string
): boolean {
    const result = db.prepare(`
        INSERT OR IGNORE INTO feishu_seen_events (
            source, external_event_id, seen_at
        ) VALUES (
            @source, @external_event_id, @seen_at
        )
    `).run({
        source,
        external_event_id: externalEventId,
        seen_at: Date.now()
    })
    return result.changes === 1
}
