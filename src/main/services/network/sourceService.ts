import type {
  ImportSourcesResult,
  SourceListItem,
  StoredSource
} from '../../../core/booksource/model'
import { parseHeader, parseSourceJson, parseSourceValue } from '../../../core/booksource/legado'
import type { ParsedSource } from '../../../core/booksource/legado'
import type { LibraryRepository } from '../../storage/library'
import type { HttpClient } from './httpClient'
import type { SourceStore } from './sourceStore'

export class SourceService {
  constructor(
    private readonly store: SourceStore,
    private readonly http: HttpClient,
    private readonly library: LibraryRepository
  ) {}

  async repair(): Promise<boolean> {
    return this.store.repair()
  }

  async list(): Promise<SourceListItem[]> {
    const [items, entries] = await Promise.all([this.store.listItems(), this.library.list()])
    const counts = new Map<string, number>()
    for (const entry of entries) {
      if (entry.format !== 'network' || !entry.sourceId) continue
      counts.set(entry.sourceId, (counts.get(entry.sourceId) ?? 0) + 1)
    }
    return items.map((item) => ({ ...item, bookCount: counts.get(item.id) ?? 0 }))
  }

  async get(id: string): Promise<StoredSource | null> {
    return this.store.get(id)
  }

  async require(id: string): Promise<ParsedSource> {
    const stored = await this.store.get(id)
    if (!stored) throw new Error('书源已删除，无法联网')
    if (!stored.enabled) throw new Error('书源已停用，无法联网')
    return {
      definition: stored.definition,
      name: String(stored.definition.bookSourceName ?? '未命名书源'),
      url: String(stored.definition.bookSourceUrl ?? ''),
      group: String(stored.definition.bookSourceGroup ?? ''),
      searchUrl: String(stored.definition.searchUrl ?? ''),
      header: parseHeader(stored.definition.header, []),
      ...(typeof stored.definition.charset === 'string'
        ? { charset: stored.definition.charset }
        : {}),
      customOrder: Number(stored.definition.customOrder ?? 0),
      compat: stored.compat
    }
  }

  private async applyImport(
    batch: ReturnType<typeof parseSourceValue>
  ): Promise<ImportSourcesResult> {
    const result = await this.store.importParsed(batch.sources)
    return {
      added: result.added,
      updated: result.updated,
      rejected: batch.rejected,
      warnings: batch.warnings
    }
  }

  async importJson(text: string, dryRun = false): Promise<ImportSourcesResult> {
    const batch = parseSourceJson(text)
    if (dryRun) {
      return { added: batch.sources.length, updated: 0, rejected: batch.rejected, warnings: batch.warnings }
    }
    return this.applyImport(batch)
  }

  async importUrl(url: string): Promise<ImportSourcesResult> {
    const response = await this.http.request({ url })
    return this.importJson(response.text)
  }

  async setFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<SourceListItem[]> {
    await this.store.setFlags(id, flags)
    return this.list()
  }

  async raw(id: string): Promise<Record<string, unknown> | null> {
    return this.store.raw(id)
  }

  async remove(id: string): Promise<void> {
    const removed = await this.store.remove(id)
    if (!removed) throw new Error('找不到这个书源')
    const url = removed.definition.bookSourceUrl
    if (typeof url === 'string') this.http.clearSourceCookies(url)
  }
}
