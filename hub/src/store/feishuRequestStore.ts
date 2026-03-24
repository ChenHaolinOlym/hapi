import type { Database } from 'bun:sqlite'

import type { StoredFeishuRequest } from './types'
import {
    getFeishuRequest,
    listOpenFeishuRequestsForSession,
    markFeishuRequestResolved,
    markFeishuRequestStale,
    upsertFeishuRequest
} from './feishuRequests'

export class FeishuRequestStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getRequest(namespace: string, sessionId: string, requestId: string): StoredFeishuRequest | null {
        return getFeishuRequest(this.db, namespace, sessionId, requestId)
    }

    listOpenRequestsForSession(namespace: string, sessionId: string): StoredFeishuRequest[] {
        return listOpenFeishuRequestsForSession(this.db, namespace, sessionId)
    }

    upsertRequest(request: Omit<StoredFeishuRequest, 'createdAt' | 'resolvedAt'>): StoredFeishuRequest {
        return upsertFeishuRequest(this.db, request)
    }

    markResolved(namespace: string, sessionId: string, requestId: string): boolean {
        return markFeishuRequestResolved(this.db, namespace, sessionId, requestId)
    }

    markStale(namespace: string, sessionId: string, requestId: string): boolean {
        return markFeishuRequestStale(this.db, namespace, sessionId, requestId)
    }
}
