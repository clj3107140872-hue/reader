import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import type { ParsedSource } from '../src/core/booksource/legado'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { NetworkBookService } from '../src/main/services/network/bookService'
import { HttpClient } from '../src/main/services/network/httpClient'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'
let root = ''
let close: (() => Promise<void>) | null = null
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-netbook-')) })
afterEach(async () => { if (close) await close(); await rm(root, { recursive: true, force: true }) })

function parsedSource(url: string): ParsedSource {
  return {
    definition: {
      bookSourceName: '源A', bookSourceUrl: url, searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.book', name: '.name', bookUrl: '.name@href' },
      ruleBookInfo: { name: 'h1', author: '.author', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
      ruleContent: { content: '#content@html' }
    },
    name: '源A', url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
    compat: { level: 'full', issues: [] }
  }
}

async function setup(allowNetwork: () => boolean = () => true) {
  const server = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url?.startsWith('/info')) {
      res.end('<h1>网络书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (req.url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (req.url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (req.url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  close = server.close
  const store = new SourceStore(root)
  await store.importParsed([parsedSource(server.url)])
  const library = new LibraryRepository(root)
  const books = new BookRepository(root)
  const networkBooks = new NetworkBookRepository(root)
  const sources = new SourceService(store, new HttpClient(), library)
  const service = new NetworkBookService({
    root, sources, reader: new SourceReader(new HttpClient()), networkBooks, books, library,
    cleaning: () => ({ adCleaning: true, rules: [] }),
    allowNetwork
  })
  const [source] = await sources.list()
  return { server, service, library, books, networkBooks, store, source }
}

describe('NetworkBookService downloads', () => {
  it('appends new toc chapters without dropping cached ones', async () => {
    const { service, server, library } = await setup()
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    const updatedAt = entry.lastUpdateAt
    await service.readChapter(entry.id, 0)
    const result = await service.updateToc(entry.id)
    expect(result.added).toBe(0)
    expect(result.total).toBe(2)
    expect((await service.networkCacheOf(entry.id)).cached).toBe(1)
    expect((await library.list())[0].lastUpdateAt).toBe(updatedAt)
  })

  it('downloads all uncached chapters and reports progress', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    const events: { done: number; total: number }[] = []
    const done = await service.downloadAll(entry.id, (event) => events.push(event))
    expect(done.failedChapters).toEqual([])
    expect(done.cancelled).toBe(false)
    expect((await service.networkCacheOf(entry.id)).cached).toBe(2)
    expect(events.at(-1)).toMatchObject({ done: 2, total: 2 })
  })

  it('cancels a running download and finishes from the cache next time', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    server.delayMs = 100
    const running = service.downloadAll(entry.id, () => {})
    setTimeout(() => service.cancelDownload(entry.id), 20)
    const first = await running
    expect(first.cancelled).toBe(true)
    server.delayMs = 0
    const second = await service.downloadAll(entry.id, () => {})
    expect(second.cancelled).toBe(false)
    expect(second.failedChapters).toEqual([])
    expect((await service.networkCacheOf(entry.id)).cached).toBe(2)
  })

  it('marks remaining chapters failed when the source disappears mid-download', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    const running = service.downloadAll(entry.id, () => {})
    // KeyedLocks schedules the download body on a microtask, so the abort lands before any chapter starts.
    service.cancelBookTasks(entry.id, 'source-deleted')
    const done = await running
    expect(done.cancelled).toBe(false)
    expect(done.failedChapters).toHaveLength(2)
    expect(done.failedChapters.every((item) => item.message === '书源已删除')).toBe(true)
    expect((await service.networkCacheOf(entry.id)).cached).toBe(0)
  })

  it('stops a running toc update when the source is deleted', async () => {
    const { service, server, networkBooks } = await setup()
    const sourceId = (await service.sources.list())[0].id
    const { entry } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    const before = await networkBooks.readMeta(entry.id)
    server.delayMs = 100
    const running = service.updateToc(entry.id)
    setTimeout(() => void service.cancelSourceTasks(sourceId, 'source-deleted'), 20)
    await expect(running).rejects.toThrow('书源已删除')
    const after = await networkBooks.readMeta(entry.id)
    expect(after.network?.lastTocAt).toBe(before.network?.lastTocAt)
  })

  it('keeps state partial when some chapters fail', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    server.failNext = true
    const done = await service.downloadAll(entry.id, () => {})
    expect(done.failedChapters.length).toBeGreaterThan(0)
    expect((await service.networkCacheOf(entry.id)).cached).toBeLessThan(2)
  })

  it('refuses to update the toc when networking is off', async () => {
    let enabled = true
    const { service, server } = await setup(() => enabled)
    const { entry } = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    enabled = false
    await expect(service.updateToc(entry.id)).rejects.toThrow('已关闭联网功能')
  })
})
