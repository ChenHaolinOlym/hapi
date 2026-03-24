import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { loadServerSettings } from './serverSettings'
import { getSettingsFile, writeSettings } from './settings'

const ORIGINAL_ENV = {
    FEISHU_APP_ID: process.env.FEISHU_APP_ID,
    FEISHU_APP_SECRET: process.env.FEISHU_APP_SECRET,
    FEISHU_VERIFICATION_TOKEN: process.env.FEISHU_VERIFICATION_TOKEN,
    FEISHU_ENCRYPT_KEY: process.env.FEISHU_ENCRYPT_KEY,
    FEISHU_OPERATOR_OPEN_ID: process.env.FEISHU_OPERATOR_OPEN_ID,
    FEISHU_NAMESPACE: process.env.FEISHU_NAMESPACE
}

describe('loadServerSettings Feishu config', () => {
    let dataDir: string

    beforeEach(() => {
        dataDir = mkdtempSync(join(tmpdir(), 'hapi-server-settings-'))
        delete process.env.FEISHU_APP_ID
        delete process.env.FEISHU_APP_SECRET
        delete process.env.FEISHU_VERIFICATION_TOKEN
        delete process.env.FEISHU_ENCRYPT_KEY
        delete process.env.FEISHU_OPERATOR_OPEN_ID
        delete process.env.FEISHU_NAMESPACE
    })

    afterEach(() => {
        if (ORIGINAL_ENV.FEISHU_APP_ID === undefined) {
            delete process.env.FEISHU_APP_ID
        } else {
            process.env.FEISHU_APP_ID = ORIGINAL_ENV.FEISHU_APP_ID
        }

        if (ORIGINAL_ENV.FEISHU_APP_SECRET === undefined) {
            delete process.env.FEISHU_APP_SECRET
        } else {
            process.env.FEISHU_APP_SECRET = ORIGINAL_ENV.FEISHU_APP_SECRET
        }

        if (ORIGINAL_ENV.FEISHU_VERIFICATION_TOKEN === undefined) {
            delete process.env.FEISHU_VERIFICATION_TOKEN
        } else {
            process.env.FEISHU_VERIFICATION_TOKEN = ORIGINAL_ENV.FEISHU_VERIFICATION_TOKEN
        }

        if (ORIGINAL_ENV.FEISHU_ENCRYPT_KEY === undefined) {
            delete process.env.FEISHU_ENCRYPT_KEY
        } else {
            process.env.FEISHU_ENCRYPT_KEY = ORIGINAL_ENV.FEISHU_ENCRYPT_KEY
        }

        if (ORIGINAL_ENV.FEISHU_OPERATOR_OPEN_ID === undefined) {
            delete process.env.FEISHU_OPERATOR_OPEN_ID
        } else {
            process.env.FEISHU_OPERATOR_OPEN_ID = ORIGINAL_ENV.FEISHU_OPERATOR_OPEN_ID
        }

        if (ORIGINAL_ENV.FEISHU_NAMESPACE === undefined) {
            delete process.env.FEISHU_NAMESPACE
        } else {
            process.env.FEISHU_NAMESPACE = ORIGINAL_ENV.FEISHU_NAMESPACE
        }

        rmSync(dataDir, { recursive: true, force: true })
    })

    it('loads Feishu callback secrets from settings.json when present', async () => {
        await writeSettings(getSettingsFile(dataDir), {
            feishuAppId: 'file-app-id',
            feishuAppSecret: 'file-app-secret',
            feishuVerificationToken: 'file-token',
            feishuEncryptKey: 'file-key',
            feishuOperatorOpenId: 'ou_file',
            feishuNamespace: 'ops'
        })

        const result = await loadServerSettings(dataDir)

        expect(result.settings.feishuAppId).toBe('file-app-id')
        expect(result.settings.feishuAppSecret).toBe('file-app-secret')
        expect(result.settings.feishuVerificationToken).toBe('file-token')
        expect(result.settings.feishuEncryptKey).toBe('file-key')
        expect(result.settings.feishuOperatorOpenId).toBe('ou_file')
        expect(result.settings.feishuNamespace).toBe('ops')
        expect(result.sources.feishuAppId).toBe('file')
        expect(result.sources.feishuAppSecret).toBe('file')
        expect(result.sources.feishuVerificationToken).toBe('file')
        expect(result.sources.feishuEncryptKey).toBe('file')
        expect(result.sources.feishuOperatorOpenId).toBe('file')
        expect(result.sources.feishuNamespace).toBe('file')
    })

    it('prefers env Feishu callback credentials and persists them when missing from settings.json', async () => {
        process.env.FEISHU_APP_ID = 'env-app-id'
        process.env.FEISHU_APP_SECRET = 'env-app-secret'
        process.env.FEISHU_VERIFICATION_TOKEN = 'env-token'
        process.env.FEISHU_ENCRYPT_KEY = 'env-key'
        process.env.FEISHU_OPERATOR_OPEN_ID = 'ou_env'
        process.env.FEISHU_NAMESPACE = 'team-alpha'

        const result = await loadServerSettings(dataDir)

        expect(result.settings.feishuAppId).toBe('env-app-id')
        expect(result.settings.feishuAppSecret).toBe('env-app-secret')
        expect(result.settings.feishuVerificationToken).toBe('env-token')
        expect(result.settings.feishuEncryptKey).toBe('env-key')
        expect(result.settings.feishuOperatorOpenId).toBe('ou_env')
        expect(result.settings.feishuNamespace).toBe('team-alpha')
        expect(result.sources.feishuAppId).toBe('env')
        expect(result.sources.feishuAppSecret).toBe('env')
        expect(result.sources.feishuVerificationToken).toBe('env')
        expect(result.sources.feishuEncryptKey).toBe('env')
        expect(result.sources.feishuOperatorOpenId).toBe('env')
        expect(result.sources.feishuNamespace).toBe('env')
        expect(result.savedToFile).toBe(true)
    })
})
