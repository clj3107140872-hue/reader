import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsRepository } from '../src/main/storage/settings'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../src/shared/settings'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-settings-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('normalizeSettings', () => {
  it('returns defaults for missing or invalid input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ theme: 'neon', typography: { fontSize: 999 } })).toMatchObject({
      theme: 'light',
      typography: { fontSize: 36 }
    })
  })

  it('keeps a null max width and merges nested patches', () => {
    expect(normalizeSettings({ typography: { maxContentWidth: null } }).typography.maxContentWidth).toBeNull()
    const merged = mergeSettings(DEFAULT_SETTINGS, { typography: { fontSize: 22 } })
    expect(merged.typography.fontSize).toBe(22)
    expect(merged.typography.lineHeight).toBe(DEFAULT_SETTINGS.typography.lineHeight)
  })
})

describe('SettingsRepository', () => {
  it('persists updates and merges nested patches', async () => {
    const repo = new SettingsRepository(root)
    expect(await repo.read()).toEqual(DEFAULT_SETTINGS)
    await repo.update({ theme: 'dark', typography: { lineHeight: 2 } })
    const stored = await repo.read()
    expect(stored.theme).toBe('dark')
    expect(stored.typography.lineHeight).toBe(2)
    expect(stored.typography.fontSize).toBe(DEFAULT_SETTINGS.typography.fontSize)
  })

  it('writes updates synchronously so they survive app exit', async () => {
    const repo = new SettingsRepository(root)
    await repo.read()
    repo.updateSync({ window: { width: 1100, height: 750, maximized: false } })
    const stored = JSON.parse(readFileSync(join(root, 'settings.json'), 'utf8'))
    expect(stored.window).toMatchObject({ width: 1100, height: 750, maximized: false })
  })
})
