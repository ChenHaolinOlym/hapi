import type { Database } from 'bun:sqlite'

import { hasSeenFeishuEvent, markFeishuEventSeen } from './feishuEvents'
import type { StoredFeishuSeenEvent } from './types'

export class FeishuEventStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    hasSeen(source: StoredFeishuSeenEvent['source'], externalEventId: string): boolean {
        return hasSeenFeishuEvent(this.db, source, externalEventId)
    }

    markSeen(source: StoredFeishuSeenEvent['source'], externalEventId: string): boolean {
        return markFeishuEventSeen(this.db, source, externalEventId)
    }
}
