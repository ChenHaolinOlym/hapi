import type { Database } from 'bun:sqlite'

import {
    deleteFeishuItemsBySessionId,
    deleteFeishuItemsForRootMessage,
    reassignFeishuItemsForRootMessage,
    reassignFeishuItemsSessionId
} from './feishuItems'
import type { FeishuThreadUpsertInput, StoredFeishuThread } from './types'
import {
    deleteFeishuThread,
    deleteFeishuThreadsBySessionId,
    getFeishuThread,
    getFeishuThreadBySessionId,
    getFeishuThreadsBySessionId,
    getFeishuThreadsForChat,
    getFeishuThreadsByNamespace,
    reassignFeishuThreadsSessionId,
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

    upsertThread(binding: FeishuThreadUpsertInput): StoredFeishuThread {
        const existing = getFeishuThread(this.db, binding.namespace, binding.chatId, binding.rootMessageId)

        try {
            this.db.exec('BEGIN')
            const next = upsertFeishuThread(this.db, binding)
            if (existing && existing.sessionId !== next.sessionId) {
                reassignFeishuItemsForRootMessage(this.db, binding.namespace, binding.rootMessageId, next.sessionId)
            }
            this.db.exec('COMMIT')
            return next
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to upsert Feishu thread state: ${message}`)
        }
    }

    deleteThread(namespace: string, chatId: string, rootMessageId: string): number {
        const deleted = deleteFeishuThread(this.db, namespace, chatId, rootMessageId)
        deleteFeishuItemsForRootMessage(this.db, namespace, rootMessageId)
        return deleted
    }

    deleteThreadsBySessionId(namespace: string, sessionId: string): number {
        const deleted = deleteFeishuThreadsBySessionId(this.db, namespace, sessionId)
        deleteFeishuItemsBySessionId(this.db, namespace, sessionId)
        return deleted
    }

    reassignSession(namespace: string, fromSessionId: string, toSessionId: string): number {
        if (fromSessionId === toSessionId) {
            return 0
        }

        const sourceBinding = this.getThreadBySessionId(namespace, fromSessionId)
        if (sourceBinding && this.getThreadBySessionId(namespace, toSessionId)) {
            throw new Error(`Cannot reassign Feishu thread state to session ${toSessionId}; binding already exists.`)
        }

        try {
            this.db.exec('BEGIN')
            const movedThreads = reassignFeishuThreadsSessionId(this.db, namespace, fromSessionId, toSessionId)
            reassignFeishuItemsSessionId(this.db, namespace, fromSessionId, toSessionId)
            this.db.exec('COMMIT')
            return movedThreads
        } catch (error) {
            this.db.exec('ROLLBACK')
            const message = error instanceof Error ? error.message : String(error)
            throw new Error(`Failed to reassign Feishu thread state: ${message}`)
        }
    }
}
