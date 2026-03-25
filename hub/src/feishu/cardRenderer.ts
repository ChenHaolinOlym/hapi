import type {
    FeishuCardViewModel,
    FeishuItemCardModel,
    FeishuReasoningSummary,
    FeishuToolVisibility
} from './types'

const BRIEF_REASONING_LIMIT = 72

export function renderItemCard(item: FeishuItemCardModel): FeishuCardViewModel {
    const statusLabel = item.status
    const headerTitle = getHeaderTitle(item)

    const elements: Array<Record<string, unknown>> = [
        {
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: `**Status:** ${statusLabel}`
            }
        }
    ]

    if (item.itemType === 'reasoning') {
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: formatReasoningText(item.reasoningSummary, item.text)
            }
        })
    } else if (item.itemType === 'tool') {
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: item.summary
            }
        })

        if (item.toolVisibility === 'all') {
            const fields: Array<Record<string, unknown>> = []
            if (item.input !== undefined) {
                fields.push({
                    is_short: false,
                    text: {
                        tag: 'lark_md',
                        content: `**Input**\n${formatUnknown(item.input)}`
                    }
                })
            }
            if (item.output !== undefined) {
                fields.push({
                    is_short: false,
                    text: {
                        tag: 'lark_md',
                        content: `**Output**\n${formatUnknown(item.output)}`
                    }
                })
            }
            if (fields.length > 0) {
                elements.push({
                    tag: 'column_set',
                    fields
                })
            }
        }
    } else {
        elements.push({
            tag: 'div',
            text: {
                tag: 'lark_md',
                content: item.text
            }
        })
    }

    return {
        config: {
            wide_screen_mode: true,
            update_multi: true
        },
        header: {
            title: {
                tag: 'plain_text',
                content: headerTitle
            },
            template: getHeaderTemplate(item.status)
        },
        elements
    }
}

function getHeaderTitle(item: FeishuItemCardModel): string {
    switch (item.itemType) {
        case 'reasoning':
            return 'Reasoning'
        case 'tool':
            return `Tool: ${item.toolName}`
        case 'response':
            return 'Response'
    }
}

function getHeaderTemplate(status: FeishuItemCardModel['status']): string {
    switch (status) {
        case 'active':
            return 'orange'
        case 'failed':
            return 'red'
        case 'completed':
        default:
            return 'green'
    }
}

function formatReasoningText(reasoningSummary: FeishuReasoningSummary, text: string): string {
    if (reasoningSummary === 'detailed') {
        return text
    }

    const normalized = text.trim()
    if (normalized.length <= BRIEF_REASONING_LIMIT) {
        return normalized
    }

    return `${normalized.slice(0, BRIEF_REASONING_LIMIT - 3)}...`
}

function formatUnknown(value: unknown): string {
    if (typeof value === 'string') {
        return value
    }

    try {
        return JSON.stringify(value, null, 2)
    } catch {
        return String(value)
    }
}
