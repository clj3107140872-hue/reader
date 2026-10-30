import { join } from 'node:path'
import type { AppSettings } from '../../core/model'
import { mergeSettings, normalizeSettings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import { atomicWriteJsonSync, readJsonSync } from './fsUtil'

export class SettingsRepository {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'settings.json')
  }

  async read(): Promise<AppSettings> {
    return this.readSync()
  }

  readSync(): AppSettings {
    return normalizeSettings(readJsonSync<unknown>(this.file))
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    return this.updateSync(patch)
  }

  updateSync(patch: SettingsPatch): AppSettings {
    const next = mergeSettings(this.readSync(), patch)
    atomicWriteJsonSync(this.file, next)
    return next
  }
}
