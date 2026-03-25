import { describe, expect, it } from 'bun:test'

import type { FeishuItemCardModel } from './types'
import { renderItemCard } from './cardRenderer'

function getTextBlocks(card: Record<string, unknown>): string[] {
    const elements = Array.isArray(card.elements) ? card.elements : []
    const blocks: string[] = []

    for (const element of elements) {
        if (!element || typeof element !== 'object') {
            continue
        }

        const text = (element as { text?: { content?: unknown } }).text
        if (typeof text?.content === 'string') {
            blocks.push(text.content)
        }

        const fields = Array.isArray((element as { fields?: Array<{ text?: { content?: unknown } }> }).fields)
            ? (element as { fields: Array<{ text?: { content?: unknown } }> }).fields
            : []
        for (const field of fields) {
            if (typeof field?.text?.content === 'string') {
                blocks.push(field.text.content)
            }
        }
    }

    return blocks
}

function render(model: FeishuItemCardModel): { header: string; template: string | null; textBlocks: string[] } {
    const card = renderItemCard(model) as Record<string, unknown>
    const header = (((card.header as Record<string, unknown> | undefined)?.title as Record<string, unknown> | undefined)?.content)
    const template = ((card.header as Record<string, unknown> | undefined)?.template)

    return {
        header: typeof header === 'string' ? header : '',
        template: typeof template === 'string' ? template : null,
        textBlocks: getTextBlocks(card)
    }
}

describe('renderItemCard', () => {
    it('renders reasoning cards differently for brief and detailed modes', () => {
        const longReasoning = 'First think through the repository structure, then map the runtime, then verify restart semantics.'

        const brief = render({
            itemKey: 'turn1:reasoning:1',
            itemType: 'reasoning',
            status: 'completed',
            reasoningSummary: 'brief',
            text: longReasoning
        })
        const detailed = render({
            itemKey: 'turn1:reasoning:1',
            itemType: 'reasoning',
            status: 'completed',
            reasoningSummary: 'detailed',
            text: longReasoning
        })

        expect(brief.header).toContain('Reasoning')
        expect(brief.textBlocks.join('\n')).not.toContain(longReasoning)
        expect(brief.textBlocks.join('\n')).toContain('First think through')

        expect(detailed.header).toContain('Reasoning')
        expect(detailed.textBlocks.join('\n')).toContain(longReasoning)
    })

    it('renders tool cards differently for important and all visibility', () => {
        const important = render({
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'completed',
            toolVisibility: 'important',
            toolName: 'rg',
            summary: 'Repository search completed.',
            input: {
                pattern: 'FeishuBridgeRuntime'
            },
            output: {
                matches: 12
            }
        })
        const all = render({
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'completed',
            toolVisibility: 'all',
            toolName: 'rg',
            summary: 'Repository search completed.',
            input: {
                pattern: 'FeishuBridgeRuntime'
            },
            output: {
                matches: 12
            }
        })

        expect(important.header).toContain('rg')
        expect(important.textBlocks.join('\n')).toContain('Repository search completed.')
        expect(important.textBlocks.join('\n')).not.toContain('pattern')

        expect(all.header).toContain('rg')
        expect(all.textBlocks.join('\n')).toContain('Repository search completed.')
        expect(all.textBlocks.join('\n')).toContain('pattern')
        expect(all.textBlocks.join('\n')).toContain('matches')
    })

    it('renders response cards with a response layout', () => {
        const response = render({
            itemKey: 'turn1:response:3',
            itemType: 'response',
            status: 'completed',
            text: 'First response block'
        })

        expect(response.header).toContain('Response')
        expect(response.textBlocks.join('\n')).toContain('First response block')
    })

    it('renders different status treatments for active completed and failed items', () => {
        const active = render({
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'active',
            toolVisibility: 'all',
            toolName: 'bash',
            summary: 'Running command'
        })
        const completed = render({
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'completed',
            toolVisibility: 'all',
            toolName: 'bash',
            summary: 'Command finished'
        })
        const failed = render({
            itemKey: 'turn1:tool:2',
            itemType: 'tool',
            status: 'failed',
            toolVisibility: 'all',
            toolName: 'bash',
            summary: 'Command failed'
        })

        expect(active.template).not.toBe(completed.template)
        expect(completed.template).not.toBe(failed.template)
        expect(active.textBlocks.join('\n')).toContain('active')
        expect(completed.textBlocks.join('\n')).toContain('completed')
        expect(failed.textBlocks.join('\n')).toContain('failed')
    })
})
