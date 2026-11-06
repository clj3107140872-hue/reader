import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { NetworkSearchService } from '../src/main/services/network/searchService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { HttpClient } from '../src/main/services/network/httpClient'
import { LibraryRepository } from '../src/main/storage/library'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'
let root = ''
let close: (() => Promise<void>) | null = null
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-search-')) })
afterEach(async () => {
  if (close) {
    await close()
    close = null
  }
  await rm(root, { recursive: true, force: true })
})

describe('NetworkSearchService', () => {
  it('searches quality sources, groups results and records stats', async () => {
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div class="book"><a class="name" href="/b/1">斗破苍穹</a><span class="author">土豆</span></div>')
    })
    close = server.close
    const store = new SourceStore(root)
    await store.importParsed([{
      definition: {
        bookSourceName: '源A', bookSourceUrl: server.url, searchUrl: '/s?q={{key}}',
        ruleSearch: { bookList: '.book', name: '.name', author: '.author', bookUrl: '.name@href' },
        ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
        ruleContent: { content: '#c' }
      },
      name: '源A', url: server.url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
      compat: { level: 'full', issues: [] }
    }])
    const storeService = new SourceService(store, new HttpClient(), new LibraryRepository(root))
    const service = new NetworkSearchService(storeService, store, new SourceReader(new HttpClient()), new LibraryRepository(root))
    const [source] = await storeService.list()
    await store.setFlags(source.id, { starred: true })
    const done = await service.search(
      { requestId: 'r1', keyword: '斗破', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    expect(done.groups).toHaveLength(1)
    expect(done.groups[0].items[0].author).toBe('土豆')
    expect(done.succeeded).toBe(1)
    expect((await store.listItems())[0].searchSuccessRate).toBeGreaterThan(0)

    // A cancelled request stops without counting the aborted fetch as a
    // source failure.
    server.delayMs = 100
    const running = service.search(
      { requestId: 'r2', keyword: '斗破', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    setTimeout(() => service.cancel('r2'), 20)
    const cancelled = await running
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.failed).toBe(0)
    expect(cancelled.groups).toHaveLength(0)
    expect(cancelled.searched).toBe(0)
  })

  it('maps non-Chinese errors to a search failure message and keeps Chinese ones', async () => {
    const now = new Date().toISOString()
    const items = [
      {
        id: 'a', name: '源A', url: 'https://a.example', group: '', enabled: true,
        starred: false, blacklisted: false, compat: { level: 'full' as const, issues: [] },
        score: 60, searchSuccessRate: 0, avgMs: 0, importedAt: now, customOrder: 0
      },
      {
        id: 'b', name: '源B', url: 'https://b.example', group: '', enabled: true,
        starred: false, blacklisted: false, compat: { level: 'full' as const, issues: [] },
        score: 60, searchSuccessRate: 0, avgMs: 0, importedAt: now, customOrder: 0
      }
    ]
    const sources = {
      list: async () => items,
      require: async (id: string) => {
        if (id === 'a') throw new TypeError('boom')
        throw new Error('书源已删除，无法联网')
      }
    } as unknown as SourceService
    const store = new SourceStore(root)
    const service = new NetworkSearchService(
      sources,
      store,
      new SourceReader(new HttpClient()),
      new LibraryRepository(root)
    )
    const messages = new Map<string, string | undefined>()
    const done = await service.search(
      { requestId: 'r-errors', keyword: '书', scope: 'all' },
      { source: (event) => { messages.set(event.sourceId, event.message) }, results: () => {} }
    )
    expect(done.failed).toBe(2)
    expect(messages.get('a')).toBe('搜索失败')
    expect(messages.get('b')).toBe('书源已删除，无法联网')
  })
})
