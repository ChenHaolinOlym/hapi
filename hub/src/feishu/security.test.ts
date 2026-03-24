import { describe, expect, it } from 'bun:test'
import { createHash, createCipheriv } from 'node:crypto'

import {
    computeFeishuSignature,
    decryptFeishuPayload,
    verifyFeishuSignature
} from './security'

describe('Feishu security helpers', () => {
    it('computes and verifies callback signatures from timestamp nonce key and raw body', () => {
        const timestamp = '1700000000'
        const nonce = 'nonce-123'
        const encryptKey = 'bridge-encrypt-key'
        const rawBody = JSON.stringify({
            encrypt: 'payload'
        })

        const expected = createHash('sha256')
            .update(timestamp)
            .update(nonce)
            .update(encryptKey)
            .update(rawBody)
            .digest('hex')

        expect(computeFeishuSignature({
            timestamp,
            nonce,
            encryptKey,
            rawBody
        })).toBe(expected)

        expect(verifyFeishuSignature({
            timestamp,
            nonce,
            encryptKey,
            rawBody,
            signature: expected
        })).toBe(true)

        expect(verifyFeishuSignature({
            timestamp,
            nonce,
            encryptKey,
            rawBody,
            signature: 'not-the-right-signature'
        })).toBe(false)
    })

    it('decrypts AES-256-CBC payloads using the Feishu encrypt key derivation', () => {
        const encryptKey = 'bridge-encrypt-key'
        const plaintext = JSON.stringify({
            type: 'url_verification',
            token: 'verify-token',
            challenge: 'challenge-123'
        })
        const iv = Buffer.from('0123456789abcdef')
        const key = createHash('sha256').update(encryptKey).digest()
        const cipher = createCipheriv('aes-256-cbc', key, iv)
        const encrypted = Buffer.concat([
            cipher.update(plaintext, 'utf8'),
            cipher.final()
        ])
        const payload = Buffer.concat([iv, encrypted]).toString('base64')

        expect(decryptFeishuPayload(payload, encryptKey)).toBe(plaintext)
    })
})
