import type {
  NetworkSearchGroup,
  NetworkSearchItem,
  SourceListItem
} from '../../../core/booksource/model'
import { mergeSearchResults, normalizeSearchTitle } from '../../../core/booksource/searchResults'
import { selectQualitySources } from '../../../core/booksource/quality'
import type {
  NetworkSearchDone,
  NetworkSearchRequest,
  NetworkSearchSourceEvent
} from '../../../shared/api'
import type { LibraryRepository } from '../../storage/library'
import { NetworkError } from './httpClient'
import type { SourceReader } from './sourceReader'
import type { SourceService } from './sourceService'
import type { SourceStore } from './sourceStore'

const CONCURRENCY = 6
const PER_SOURCE_LIMIT = 100

const CHINESE = /[㐀-鿿]/

/** The renderer has its own error formatter; the main process keeps a local one. */
function messageOf(error: unknown): string {
  if (error instanceof NetworkError) return error.message
  const message = error instanceof Error ? error.message : ''
  return CHINESE.test(message) ? message : '搜索失败'
}

export interface SearchEmitter {
  source(event: NetworkSearchSourceEvent): void
  results(payload: { groups: NetworkSearchGroup[]; searched: number; succeeded: number; empty: number; failed: number; remaining: number }): void
}

export class NetworkSearchService {
  private readonly jobs = new Map<string, { controller: AbortController; cancelled: boolean }>()
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly sources: SourceService,
    private readonly store: SourceStore,
    private readonly reader: SourceReader,
    private readonly library: LibraryRepository
  ) {}

  cancel(requestId: string): void {
    const job = this.jobs.get(requestId)
    if (job) {
      job.cancelled = true
      job.controller.abort()
    }
  }

  async search(request: NetworkSearchRequest, emit: SearchEmitter): Promise<NetworkSearchDone> {
    const key = `${request.requestId}`
    if (this.inFlight.has(key)) throw new Error('这个搜索已经在进行')
    this.inFlight.add(key)
    const job = { controller: new AbortController(), cancelled: false }
    this.jobs.set(request.requestId, job)
    const keyword = request.keyword.trim()
    const emptyDone: NetworkSearchDone = {
      requestId: request.requestId,
      cancelled: false,
      searched: 0,
      succeeded: 0,
      empty: 0,
      failed: 0,
      groups: []
    }
    if (!keyword) {
      this.inFlight.delete(key)
      this.jobs.delete(request.requestId)
      return emptyDone
    }

    try {
      const all = await this.sources.list()
      const pool = request.scope === 'all'
        ? all.filter((source) => source.enabled)
        : selectQualitySources(all)
      if (pool.length === 0) throw new Error('没有可用的书源，请先导入或启用书源')
      const entries = await this.library.list()
      const shelfTitles = new Set(
        entries
          .filter((entry) => entry.format === 'network')
          .map((entry) => normalizeSearchTitle(entry.title))
      )
      const queue = [...pool]
      const collected: NetworkSearchItem[] = []
      let searched = 0
      let succeeded = 0
      let empty = 0
      let failed = 0
      let remaining = queue.length

      const runOne = async (item: SourceListItem): Promise<void> => {
        if (job.cancelled) return
        const started = Date.now()
        try {
          const source = await this.sources.require(item.id)
          const page = await this.reader.search(source, keyword, 1, job.controller.signal)
          // A retried fetch can resolve after cancellation; drop its results
          // instead of recording a success for a search the user cancelled.
          if (job.cancelled) return
          const results = page.slice(0, PER_SOURCE_LIMIT).map((entry) => ({
            sourceId: item.id,
            sourceName: item.name,
            title: entry.title,
            author: entry.author,
            ...(entry.intro ? { intro: entry.intro } : {}),
            ...(entry.kind ? { kind: entry.kind } : {}),
            ...(entry.coverUrl ? { coverUrl: entry.coverUrl } : {}),
            bookUrl: entry.bookUrl,
            ...(entry.lastChapter ? { lastChapter: entry.lastChapter } : {}),
            qualityScore: item.score,
            starred: item.starred,
            inShelf: shelfTitles.has(normalizeSearchTitle(entry.title)),
            avgMs: item.avgMs,
            importedAt: item.importedAt
          }))
          await this.store.record(item.id, 'search', results.length ? 'success' : 'empty', Date.now() - started)
          if (results.length === 0) empty++
          else succeeded++
          collected.push(...results)
          emit.source({
            requestId: request.requestId,
            sourceId: item.id,
            sourceName: item.name,
            status: results.length ? 'success' : 'empty',
            count: results.length,
            ms: Date.now() - started
          })
        } catch (error) {
          if (job.cancelled) return
          failed++
          const message = messageOf(error)
          await this.store.record(item.id, 'search', 'error', Date.now() - started, message)
          emit.source({
            requestId: request.requestId,
            sourceId: item.id,
            sourceName: item.name,
            status: 'error',
            count: 0,
            ms: Date.now() - started,
            message
          })
        } finally {
          // A cancelled source was not searched; do not count it.
          if (!job.cancelled) {
            searched++
            remaining--
          }
        }
        emit.results({
          groups: mergeSearchResults(collected),
          searched,
          succeeded,
          empty,
          failed,
          remaining
        })
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !job.cancelled) {
          const item = queue.shift()
          if (!item) break
          await runOne(item)
        }
      })
      await Promise.all(workers)
      return {
        requestId: request.requestId,
        cancelled: job.cancelled,
        searched,
        succeeded,
        empty,
        failed,
        groups: mergeSearchResults(collected)
      }
    } finally {
      this.inFlight.delete(key)
      this.jobs.delete(request.requestId)
    }
  }
}
