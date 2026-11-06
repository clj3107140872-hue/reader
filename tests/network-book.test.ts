import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import type { CleaningRunConfig } from '../src/core/cleaning'
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

function parsedSource(url: string, tocRule: Record<string, string> = {}): ParsedSource {
  return {
    definition: {
      bookSourceName: '源A', bookSourceUrl: url, searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.book', name: '.name', bookUrl: '.name@href' },
      ruleBookInfo: { name: 'h1', author: '.author', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href', ...tocRule },
      ruleContent: { content: '#content@html' }
    },
    name: '源A', url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
    compat: { level: 'full', issues: [] }
  }
}

const DEFAULT_TOC = '<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>'

interface SetupOptions {
  allowNetwork?: () => boolean
  tocHtml?: string
  tocRule?: Record<string, string>
  cleaning?: () => CleaningRunConfig
  /** Return true when the hook handled the request itself. */
  handle?: (req: IncomingMessage, res: ServerResponse) => boolean
}

async function setup(options: SetupOptions = {}) {
  const server = await startFakeServer((req, res) => {
    if (options.handle?.(req, res)) return
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url?.startsWith('/info')) {
      res.end('<h1>网络书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (req.url === '/toc') {
      res.end(options.tocHtml ?? DEFAULT_TOC)
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
  await store.importParsed([parsedSource(server.url, options.tocRule)])
  const library = new LibraryRepository(root)
  const books = new BookRepository(root)
  const networkBooks = new NetworkBookRepository(root)
  const sources = new SourceService(store, new HttpClient(), library)
  const service = new NetworkBookService({
    root, sources, reader: new SourceReader(new HttpClient()), networkBooks, books, library,
    cleaning: options.cleaning ?? (() => ({ adCleaning: true, rules: [] })),
    allowNetwork: options.allowNetwork
  })
  const [source] = await sources.list()
  return { server, service, library, books, networkBooks, store, source }
}

describe('NetworkBookService', () => {
  it('adds a network book with toc and reads a chapter on demand', async () => {
    const { server, service, library, books } = await setup()
    const { entry } = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    expect(entry.title).toBe('网络书')
    expect(entry.format).toBe('network')
    expect(entry.chapterCount).toBe(2)
    expect(entry.downloadState).toBe('none')
    expect((await library.list())).toHaveLength(1)

    const meta = await books.readMeta(entry.id)
    expect(meta.network?.tocUrl).toBe(`${server.url}/toc`)
    const chapter = await service.readChapter(entry.id, 0)
    expect(chapter.text).toContain('正文一')
    expect((await service.networkCacheOf(entry.id)).cached).toBe(1)
    const again = await service.readChapter(entry.id, 0)
    expect(again.cached).toBe(true)
  })

  it('requests a chapter once for concurrent readers', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    const before = server.requestCount
    const [a, b] = await Promise.all([
      service.readChapter(entry.id, 0),
      service.readChapter(entry.id, 0)
    ])
    expect(a.text).toBe(b.text)
    expect(server.requestCount - before).toBe(1)
  })

  it('rejects a source that was deleted', async () => {
    const { service } = await setup()
    const sourceId = (await service.sources.list())[0].id
    await service.sources.remove(sourceId)
    await expect(service.add({ sourceId, bookUrl: 'https://example.com/b' })).rejects.toThrow('书源已删除')
  })

  it('refuses network work when networking is off but still reads cached chapters', async () => {
    let enabled = true
    const { service, server } = await setup({ allowNetwork: () => enabled })
    const { entry } = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    await service.readChapter(entry.id, 0)
    enabled = false
    expect((await service.readChapter(entry.id, 0)).cached).toBe(true)
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('已关闭联网功能')
  })

  it('rejects invalid chapter indexes before reading from disk', async () => {
    const { service, server } = await setup()
    const { entry } = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    // A traversal-shaped index must not be able to read this file through
    // chapters/../escape.txt (the repository appends ".txt" to the index).
    await writeFile(join(root, 'books', entry.id, 'escape.txt'), 'SECRET', 'utf8')
    await expect(service.readChapter(entry.id, -1)).rejects.toThrow('章节不存在')
    await expect(
      service.readChapter(entry.id, '../escape' as unknown as number)
    ).rejects.toThrow('章节不存在')
  })

  it('relinks surviving books when another book meta is corrupt', async () => {
    const { service, server, library, store } = await setup()
    const oldSourceId = (await service.sources.list())[0].id
    const { entry: healthy } = await service.add({ sourceId: oldSourceId, bookUrl: `${server.url}/info` })
    const { entry: broken } = await service.add({ sourceId: oldSourceId, bookUrl: `${server.url}/info?b=broken` })
    await rm(join(root, 'books', broken.id, 'meta.json'))

    await service.sources.remove(oldSourceId)
    await store.importParsed([parsedSource(server.url)])
    const replacement = (await service.sources.list())[0]
    expect(replacement.id).not.toBe(oldSourceId)

    await expect(service.relinkSources()).resolves.toBeUndefined()
    const entries = await library.list()
    expect(entries.find((entry) => entry.id === healthy.id)?.sourceId).toBe(replacement.id)
  })

  it('returns empty cached text for volume rows without any network request', async () => {
    const { service, server } = await setup({
      tocRule: { isVolume: '[data-volume]' },
      tocHtml:
        '<a class="c" href="" data-volume="1">第一卷</a>' +
        '<a class="c" href="/c/1">第一章</a>'
    })
    const sourceId = (await service.sources.list())[0].id
    const { entry } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    expect(entry.chapterCount).toBe(2)
    const before = server.requestCount
    await expect(service.readChapter(entry.id, 0)).resolves.toEqual({ text: '', cached: true })
    expect(server.requestCount).toBe(before)
  })

  it('reads chapters of different books in parallel instead of one global slot', async () => {
    let active = 0
    let peak = 0
    const { service, server } = await setup({
      handle: (req, res) => {
        if (!req.url?.startsWith('/c/')) return false
        active++
        peak = Math.max(peak, active)
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'text/html' })
          res.end('<div id="content">正文</div>')
          active--
        }, 80)
        return true
      }
    })
    const sourceId = (await service.sources.list())[0].id
    const ids: string[] = []
    for (const id of [1, 2, 3]) {
      ids.push((await service.add({ sourceId, bookUrl: `${server.url}/info?b=${id}` })).entry.id)
    }
    peak = 0
    await Promise.all(ids.map((id) => service.readChapter(id, 0)))
    expect(peak).toBe(3)
  })

  it('adds the book from the search result when the info page fails', async () => {
    const { service, server, networkBooks } = await setup()
    const sourceId = (await service.sources.list())[0].id
    // The first request (book info) answers 500; the TOC page then loads.
    server.failNext = true
    const { entry, warnings } = await service.add({
      sourceId,
      bookUrl: `${server.url}/toc`,
      title: '搜索书名',
      author: '搜索作者',
      intro: '搜索简介',
      kind: '玄幻',
      lastChapter: '第二章'
    })
    expect(warnings.join('')).toContain('书籍信息获取失败，已用搜索结果补齐')
    expect(entry.title).toBe('搜索书名')
    expect(entry.author).toBe('搜索作者')
    expect(entry.intro).toBe('搜索简介')
    expect(entry.kind).toBe('玄幻')
    expect(entry.chapterCount).toBe(2)
    const meta = await networkBooks.readMeta(entry.id)
    expect(meta.network?.bookUrl).toBe(`${server.url}/toc`)
    expect(meta.network?.lastChapter).toBe('第二章')
  })

  it('treats a failed toc fetch as fatal even when the info page works', async () => {
    const { service, server } = await setup({
      handle: (req, res) => {
        if (req.url !== '/toc') return false
        res.writeHead(500)
        res.end()
        return true
      }
    })
    const sourceId = (await service.sources.list())[0].id
    await expect(service.add({ sourceId, bookUrl: `${server.url}/info` })).rejects.toThrow(
      '目录获取失败，换一个书源试试'
    )
  })

  it('keeps the raw text when cleaning removes everything', async () => {
    const { service, server, library } = await setup({
      cleaning: () => ({
        adCleaning: true,
        rules: [{ id: 'all', name: '全部', type: 'line', pattern: '.+', enabled: true }]
      })
    })
    const sourceId = (await service.sources.list())[0].id
    const { entry } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    const chapter = await service.readChapter(entry.id, 0)
    expect(chapter.text).toContain('正文一')
    expect(chapter.warnings?.join('')).toContain('清洗后正文为空')
    expect((await service.networkCacheOf(entry.id)).cached).toBe(1)
    const file = await readFile(join(root, 'books', entry.id, 'chapters', '00000.txt'), 'utf8')
    expect(file.trim()).not.toBe('')

    const done = await service.downloadAll(entry.id, () => {})
    expect(done.failedChapters).toEqual([])
    expect((await library.list())[0].downloadState).toBe('complete')
  })

  it('deduplicates an add by source and book url without fetching again', async () => {
    const { service, server, library } = await setup()
    const sourceId = (await service.sources.list())[0].id
    const { entry: first } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    const before = server.requestCount
    const { entry: second } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    expect(second.id).toBe(first.id)
    expect(server.requestCount).toBe(before)
    expect(await library.list()).toHaveLength(1)
  })

  it('records info, toc and content operations and keeps content errors in lastError', async () => {
    const { service, server, store, source } = await setup()
    const { entry } = await service.add({ sourceId: source.id, bookUrl: `${server.url}/info` })
    await service.readChapter(entry.id, 0)
    await store.flush()
    const stats = JSON.parse(
      await readFile(join(root, 'sources', 'stats.json'), 'utf8')
    ) as { bySource: Record<string, Record<string, { attempts: number }>> }
    const recorded = stats.bySource[source.id]
    expect(recorded.info.attempts).toBe(1)
    expect(recorded.toc.attempts).toBe(1)
    expect(recorded.content.attempts).toBe(1)

    server.failNext = true
    const message = await service.readChapter(entry.id, 1).catch((error: Error) => error.message)
    expect(message).toContain('站点暂时不可用（500）')
    expect(message).not.toContain('HTTP ')
    const [item] = await store.listItems()
    expect(item.lastError?.operation).toBe('content')
    expect(item.lastError?.message).toContain('500')
  })

  it('maps http errors with the source name when updating the toc', async () => {
    let failToc = false
    const { service, server } = await setup({
      handle: (req, res) => {
        if (!failToc || req.url !== '/toc') return false
        res.writeHead(403)
        res.end()
        return true
      }
    })
    const sourceId = (await service.sources.list())[0].id
    const { entry } = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    failToc = true
    const message = await service.updateToc(entry.id).catch((error: Error) => error.message)
    expect(message).toContain('《源A》拒绝访问（403）')
    expect(message).not.toContain('HTTP ')
  })
})
