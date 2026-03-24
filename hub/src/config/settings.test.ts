import { describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { getSettingsFile, persistFeishuOperatorOpenId, readSettingsOrThrow, writeSettings } from './settings'

describe('persistFeishuOperatorOpenId', () => {
    it('writes the claimed operator open id while preserving existing settings fields', async () => {
        const dataDir = mkdtempSync(join(tmpdir(), 'hapi-settings-'))
        try {
            const settingsFile = getSettingsFile(dataDir)
            await writeSettings(settingsFile, {
                feishuAppId: 'cli_test',
                feishuAppSecret: 'secret_test',
                feishuNamespace: 'default'
            })

            await persistFeishuOperatorOpenId(settingsFile, 'ou_claimed')

            await expect(readSettingsOrThrow(settingsFile)).resolves.toMatchObject({
                feishuAppId: 'cli_test',
                feishuAppSecret: 'secret_test',
                feishuNamespace: 'default',
                feishuOperatorOpenId: 'ou_claimed'
            })
        } finally {
            rmSync(dataDir, { recursive: true, force: true })
        }
    })
})
