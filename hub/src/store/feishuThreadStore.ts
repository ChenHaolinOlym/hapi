import type { Database } from 'bun:sqlite'

import type { StoredFeishuThread } from './types'
import {
    deleteFeishuThread,
    deleteFeishuThreadsBySessionId,
    getFeishuThread,
    getFeishuThreadBySessionId,
    getFeishuThreadsBySessionId,
    getFeishuThreadsForChat,
    getFeishuThreadsByNamespace,
    upsertFeishuThread
} from './feishuThreads'

export class FeishuThreadStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getThread(namespace: string, chatId: string, rootMessageId: string): StoredFeishuThread | null {
        return getFeishuThread(this.db, namespace, chatId, rootMessageId)
    }

    getThreadBySessionId(namespace: string, sessionId: string): StoredFeishuThread | null {
        return getFeishuThreadBySessionId(this.db, namespace, sessionId)
    }

    getThreadsBySessionId(namespace: string, sessionId: string): StoredFeishuThread[] {
        return getFeishuThreadsBySessionId(this.db, namespace, sessionId)
    }

    getThreadsByNamespace(namespace: string): StoredFeishuThread[] {
        return getFeishuThreadsByNamespace(this.db, namespace)
    }

    getThreadsForChat(namespace: string, chatId: string, operatorOpenId: string): StoredFeishuThread[] {
        return getFeishuThreadsForChat(this.db, namespace, chatId, operatorOpenId)
    }

    upsertThread(binding: Omit<StoredFeishuThread, 'createdAt' | 'updatedAt'>): StoredFeishuThread {
        return upsertFeishuThread(this.db, binding)
    }

    deleteThread(namespace: string, chatId: string, rootMessageId: string): number {
        return deleteFeishuThread(this.db, namespace, chatId, rootMessageId)
    }

    deleteThreadsBySessionId(namespace: string, sessionId: string): number {
        return deleteFeishuThreadsBySessionId(this.db, namespace, sessionId)
    }
}
