import { createDecipheriv, createHash, timingSafeEqual } from 'node:crypto'

export function computeFeishuSignature(args: {
    timestamp: string
    nonce: string
    encryptKey: string
    rawBody: string
}): string {
    return createHash('sha256')
        .update(args.timestamp)
        .update(args.nonce)
        .update(args.encryptKey)
        .update(args.rawBody)
        .digest('hex')
}

export function verifyFeishuSignature(args: {
    timestamp: string
    nonce: string
    encryptKey: string
    rawBody: string
    signature: string
}): boolean {
    const actual = computeFeishuSignature(args)
    const expectedBuffer = Buffer.from(args.signature.toLowerCase(), 'utf8')
    const actualBuffer = Buffer.from(actual, 'utf8')

    if (expectedBuffer.length !== actualBuffer.length) {
        return false
    }

    return timingSafeEqual(expectedBuffer, actualBuffer)
}

export function decryptFeishuPayload(payload: string, encryptKey: string): string {
    const decoded = Buffer.from(payload, 'base64')
    if (decoded.length <= 16) {
        throw new Error('Invalid Feishu encrypted payload')
    }

    const iv = decoded.subarray(0, 16)
    const encrypted = decoded.subarray(16)
    const key = createHash('sha256').update(encryptKey).digest()
    const decipher = createDecipheriv('aes-256-cbc', key, iv)
    const decrypted = Buffer.concat([
        decipher.update(encrypted),
        decipher.final()
    ])

    return decrypted.toString('utf8')
}
