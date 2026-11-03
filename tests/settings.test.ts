import { readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsRepository } from '../src/main/storage/settings'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeSettings,
  resolveTheme
} from '../src/shared/settings'

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

  it('migrates a legacy dark theme to night mode', () => {
    const settings = normalizeSettings({ theme: 'dark' })
    expect(settings.theme).toBe('light')
    expect(settings.themeMode).toBe('night')
  })

  it('resolves day, night and system modes', () => {
    const settings = normalizeSettings({ theme: 'green', themeMode: 'system' })
    expect(resolveTheme(settings, false)).toBe('green')
    expect(resolveTheme(settings, true)).toBe('dark')
    expect(resolveTheme({ ...settings, themeMode: 'day' }, true)).toBe('green')
    expect(resolveTheme({ ...settings, themeMode: 'night' }, false)).toBe('dark')
  })

  it('keeps valid disabled built-in rule ids and drops junk', () => {
    const cleaned = normalizeSettings({
      cleaning: { enabled: false, disabledBuiltinIds: ['url', 42, '', 'site'] }
    })
    expect(cleaned.cleaning).toEqual({ enabled: false, disabledBuiltinIds: ['url', 'site'] })
  })

  it('clamps slacking opacity and validates the boss key', () => {
    const settings = normalizeSettings({
      slacking: { opacity: 0.1, bossKey: 'Ctrl+Shift+Q', bossKeyAction: 'explode' }
    })
    expect(settings.slacking.opacity).toBe(0.6)
    expect(settings.slacking.bossKey).toBe('Ctrl+Shift+H')
    expect(settings.slacking.bossKeyAction).toBe('hide')
  })

  it('merges slacking patches without losing siblings', () => {
    const merged = mergeSettings(DEFAULT_SETTINGS, { slacking: { opacity: 0.8 } })
    expect(merged.slacking.opacity).toBe(0.8)
    expect(merged.slacking.disguise).toBe(false)
    expect(merged.slacking.bossKey).toBe('Ctrl+Shift+H')
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
    await repo.update({ themeMode: 'night', typography: { lineHeight: 2 } })
    const stored = await repo.read()
    expect(stored.themeMode).toBe('night')
    expect(stored.theme).toBe('light')
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
