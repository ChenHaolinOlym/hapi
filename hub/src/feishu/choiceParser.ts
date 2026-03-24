import type { FeishuChoiceReply, FeishuChoiceValue, ParsedImplicitFeishuChoice } from './types'

export function parseFeishuChoiceValue(input: string): FeishuChoiceValue | null {
    const normalized = input.trim().toLowerCase()
    if (!normalized) {
        return null
    }

    if (normalized === 'a' || normalized === '1') {
        return 'A'
    }
    if (normalized === 'b' || normalized === '2') {
        return 'B'
    }
    if (normalized === 'c' || normalized === '3') {
        return 'C'
    }
    if (normalized === 'yes') {
        return 'yes'
    }
    if (normalized === 'no') {
        return 'no'
    }

    return null
}

export const normalizeFeishuChoice = parseFeishuChoiceValue
export const parseExplicitChoiceValue = parseFeishuChoiceValue

export function parseDirectChoiceReply(input: string): FeishuChoiceValue | null {
    const trimmed = input.trim()
    if (!trimmed || /\s/.test(trimmed)) {
        return null
    }
    const normalized = trimmed.toLowerCase()
    if (normalized === 'a') return 'A'
    if (normalized === 'b') return 'B'
    if (normalized === 'c') return 'C'
    if (normalized === 'yes') return 'yes'
    if (normalized === 'no') return 'no'
    return null
}

export const parseBareChoiceValue = parseDirectChoiceReply

export function parsePlainFeishuChoiceReply(text: string): FeishuChoiceReply | null {
    const value = parseDirectChoiceReply(text)
    if (!value) {
        return null
    }

    return {
        kind: 'choice',
        value
    }
}

export function parseImplicitChoice(text: string): ParsedImplicitFeishuChoice | null {
    const value = parseDirectChoiceReply(text)
    if (!value) {
        return null
    }

    return {
        choice: value
    }
}

export function parseFeishuRequestToken(input: string): string | null {
    const trimmed = input.trim()
    if (!/^r:/i.test(trimmed)) {
        return null
    }

    const token = trimmed.slice(2).trim()
    return token ? token : null
}
