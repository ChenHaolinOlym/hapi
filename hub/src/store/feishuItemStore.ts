import type { Database } from 'bun:sqlite'

import type { FeishuItemUpsertInput, StoredFeishuItem } from './types'
import { getFeishuItem, listFeishuItemsForRootMessage, upsertFeishuItem } from './feishuItems'

export class FeishuItemStore {
    private readonly db: Database

    constructor(db: Database) {
        this.db = db
    }

    getItem(namespace: string, rootMessageId: string, itemKey: string): StoredFeishuItem | null {
        return getFeishuItem(this.db, namespace, rootMessageId, itemKey)
    }

    listItemsForRootMessage(namespace: string, rootMessageId: string): StoredFeishuItem[] {
        return listFeishuItemsForRootMessage(this.db, namespace, rootMessageId)
    }

    upsertItem(item: FeishuItemUpsertInput): StoredFeishuItem {
        return upsertFeishuItem(this.db, item)
    }
}
