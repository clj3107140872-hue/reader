import { join } from 'node:path'
import type { AppSettings } from '../../core/model'
import { mergeSettings, normalizeSettings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import { atomicWriteJson, readJson } from './fsUtil'

export class SettingsRepository {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'settings.json')
  }

  async read(): Promise<AppSettings> {
    return normalizeSettings(await readJson<unknown>(this.file))
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const next = mergeSettings(await this.read(), patch)
    await atomicWriteJson(this.file, next)
    return next
  }
}
