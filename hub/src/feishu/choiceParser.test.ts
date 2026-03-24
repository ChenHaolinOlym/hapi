import { describe, expect, it } from 'bun:test'

import { parseImplicitChoice } from './choiceParser'

describe('parseImplicitChoice', () => {
    it('parses plain A/B/C replies', () => {
        expect(parseImplicitChoice('A')).toEqual({ choice: 'A' })
        expect(parseImplicitChoice(' b ')).toEqual({ choice: 'B' })
        expect(parseImplicitChoice('c')).toEqual({ choice: 'C' })
    })

    it('parses plain yes/no replies', () => {
        expect(parseImplicitChoice('yes')).toEqual({ choice: 'yes' })
        expect(parseImplicitChoice('No')).toEqual({ choice: 'no' })
    })

    it('does not parse numeric or free-text replies as implicit choices', () => {
        expect(parseImplicitChoice('1')).toBeNull()
        expect(parseImplicitChoice('option A')).toBeNull()
        expect(parseImplicitChoice('')).toBeNull()
    })
})
