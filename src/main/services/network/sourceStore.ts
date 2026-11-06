import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ImportSourcesResult,
  SourceListItem,
  SourceStats,
  SourcesFile,
  StatsFile,
  StoredSource
} from '../../../core/booksource/model'
import { computeScore, emptySourceStats } from '../../../core/booksource/quality'
import type { ParsedSource } from '../../../core/booksource/legado'
import { atomicWriteJson, readJson } from '../../storage/fsUtil'
import { Mutex } from '../../storage/mutex'

export type SourceOperation = 'search' | 'info' | 'toc' | 'content'
export type OperationOutcome = 'success' | 'empty' | 'error'

export class SourceStore {
  private readonly mutex = new Mutex()
  private statsCache: StatsFile | null = null
  private statsTimer: NodeJS.Timeout | null = null

  constructor(private readonly root: string) {}

  private get sourcesFile(): string { return join(this.root, 'sources', 'sources.json') }
  private get statsFile(): string { return join(this.root, 'sources', 'stats.json') }

  async repair(): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const main = await readJson<SourcesFile>(this.sourcesFile)
      if (main?.version === 1 && Array.isArray(main.sources)) return false
      const backup = await readJson<SourcesFile>(`${this.sourcesFile}.bak`)
      if (!backup?.version || !Array.isArray(backup.sources)) return false
      await atomicWriteJson(this.sourcesFile, backup, false)
      return true
    })
  }

  async read(): Promise<SourcesFile> {
    const main = await readJson<SourcesFile>(this.sourcesFile)
    if (main?.version === 1 && Array.isArray(main.sources)) return main
    const backup = await readJson<SourcesFile>(`${this.sourcesFile}.bak`)
    return backup?.version === 1 && Array.isArray(backup.sources)
      ? backup
      : { version: 1, sources: [] }
  }

  async listStored(): Promise<StoredSource[]> {
    return (await this.read()).sources
  }

  async get(id: string): Promise<StoredSource | null> {
    return (await this.read()).sources.find((source) => source.id === id) ?? null
  }

  async listItems(): Promise<SourceListItem[]> {
    const stats = await this.readStats()
    return (await this.listStored()).map((stored) => this.toItem(stored, stats.bySource[stored.id]))
  }

  private toItem(stored: StoredSource, stats?: SourceStats): SourceListItem {
    const value = stats ?? emptySourceStats()
    const score = computeScore(value, stored.compat)
    const attempts = value.search.attempts
    const definition = stored.definition as Record<string, unknown>
    return {
      id: stored.id,
      name: String(definition.bookSourceName ?? '未命名书源'),
      url: String(definition.bookSourceUrl ?? ''),
      group: typeof definition.bookSourceGroup === 'string' ? definition.bookSourceGroup : '',
      enabled: stored.enabled,
      starred: stored.starred,
      blacklisted: stored.blacklisted,
      compat: stored.compat,
      score,
      searchSuccessRate: attempts > 0 ? value.search.successes / attempts : 0,
      avgMs: attempts > 0 ? Math.round(value.search.totalMs / attempts) : 0,
      importedAt: stored.importedAt,
      customOrder: Number.isFinite(Number(definition.customOrder)) ? Number(definition.customOrder) : 0,
      ...(value.lastError ? { lastError: value.lastError } : {})
    }
  }

  async importParsed(sources: ParsedSource[]): Promise<ImportSourcesResult> {
    return this.mutex.runExclusive(async () => {
      const file = await this.read()
      const byUrl = new Map(file.sources.map((source, index) => [String((source.definition as Record<string, unknown>).bookSourceUrl), index]))
      let added = 0
      let updated = 0
      const now = new Date().toISOString()
      for (const parsed of sources) {
        const index = byUrl.get(parsed.url)
        if (index !== undefined) {
          const old = file.sources[index]
          file.sources[index] = {
            ...old,
            definition: parsed.definition,
            compat: parsed.compat,
            updatedAt: now
          }
          updated++
        } else {
          file.sources.push({
            id: randomUUID(),
            definition: parsed.definition,
            // 尊重书源自带 enabled（spec 5.1）；更新时保留已存状态。
            enabled: parsed.enabled ?? true,
            starred: false,
            blacklisted: false,
            compat: parsed.compat,
            importedAt: now,
            updatedAt: now
          })
          added++
        }
      }
      await atomicWriteJson(this.sourcesFile, file)
      return { added, updated, rejected: [], warnings: [] }
    })
  }

  async setFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const file = await this.read()
      const source = file.sources.find((item) => item.id === id)
      if (!source) throw new Error('找不到这个书源')
      if (typeof flags.enabled === 'boolean') source.enabled = flags.enabled
      if (typeof flags.starred === 'boolean') source.starred = flags.starred
      if (typeof flags.blacklisted === 'boolean') source.blacklisted = flags.blacklisted
      source.updatedAt = new Date().toISOString()
      await atomicWriteJson(this.sourcesFile, file)
    })
  }

  async raw(id: string): Promise<Record<string, unknown> | null> {
    return (await this.get(id))?.definition ?? null
  }

  async remove(id: string): Promise<StoredSource | null> {
    return this.mutex.runExclusive(async () => {
      const file = await this.read()
      const source = file.sources.find((item) => item.id === id) ?? null
      if (!source) return null
      file.sources = file.sources.filter((item) => item.id !== id)
      await atomicWriteJson(this.sourcesFile, file)
      const stats = await this.readStats()
      delete stats.bySource[id]
      await atomicWriteJson(this.statsFile, stats)
      return source
    })
  }

  private async readStats(): Promise<StatsFile> {
    if (this.statsCache) return this.statsCache
    const stored = await readJson<StatsFile>(this.statsFile)
    this.statsCache =
      stored?.version === 1 && stored.bySource && typeof stored.bySource === 'object'
        ? stored
        : { version: 1, bySource: {} }
    return this.statsCache
  }

  async record(
    sourceId: string,
    operation: SourceOperation,
    outcome: OperationOutcome,
    ms: number,
    message?: string
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const stats = await this.readStats()
      const value = (stats.bySource[sourceId] ??= emptySourceStats())
      const target = value[operation]
      target.attempts++
      target.totalMs += Math.max(0, Math.round(ms))
      if (outcome === 'success') target.successes++
      else if (outcome === 'empty') target.empties++
      else target.errors++
      value.lastUsedAt = new Date().toISOString()
      if (outcome === 'error' && message) {
        value.lastError = { operation, message, at: value.lastUsedAt }
      }
      const stored = await this.get(sourceId)
      if (stored) value.score = computeScore(value, stored.compat)
    })
    this.scheduleStatsFlush()
  }

  private scheduleStatsFlush(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      void this.flush().catch(() => undefined)
    }, 2000)
    this.statsTimer.unref?.()
  }

  async flush(): Promise<void> {
    await this.mutex.runExclusive(async () => {
      if (!this.statsCache) return
      if (this.statsTimer) {
        clearTimeout(this.statsTimer)
        this.statsTimer = null
      }
      await atomicWriteJson(this.statsFile, this.statsCache)
    })
  }
}
