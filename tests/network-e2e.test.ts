import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import type { FakeServer } from './helpers/networkServer'
import { HttpClient } from '../src/main/services/network/httpClient'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { NetworkSearchService } from '../src/main/services/network/searchService'
import { NetworkBookService } from '../src/main/services/network/bookService'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import { ReaderService } from '../src/main/services/reader'
import { SearchService } from '../src/main/services/search'
import { ReprocessService } from '../src/main/services/reprocess'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'

let root = ''
let close: (() => Promise<void>) | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-net-e2e-'))
})

afterEach(async () => {
  if (close) await close()
  close = null
  await rm(root, { recursive: true, force: true })
})

function sourceJson(url: string): Record<string, unknown> {
  return {
    bookSourceName: '假书源',
    bookSourceUrl: url,
    bookSourceGroup: '验收',
    searchUrl: '/s?q={{key}}',
    ruleSearch: {
      bookList: '.book',
      name: '.name',
      author: '.author',
      bookUrl: '.name@href',
      intro: '.intro'
    },
    ruleBookInfo: { name: 'h1', author: '.author', intro: '.intro', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
    ruleContent: { content: '#content@html' }
  }
}

async function setupFull() {
  const server: FakeServer = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const url = req.url ?? ''
    if (url.startsWith('/s?')) {
      res.end(
        '<div class="book"><a class="name" href="/info">测试书</a><span class="author">作者</span><p class="intro">简介</p></div>'
      )
    } else if (url.startsWith('/info')) {
      res.end('<h1>测试书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  close = server.close
  const library = new LibraryRepository(root)
  const books = new BookRepository(root)
  const networkBooks = new NetworkBookRepository(root)
  const http = new HttpClient()
  const store = new SourceStore(root)
  const sources = new SourceService(store, http, library)
  const reader = new SourceReader(http)
  const service = new NetworkBookService({
    root,
    sources,
    reader,
    networkBooks,
    books,
    library,
    cleaning: () => ({ adCleaning: true, rules: [] })
  })
  const search = new NetworkSearchService(sources, store, reader, library)
  const readerService = new ReaderService(library, books, networkBooks)
  const bookSearch = new SearchService(books, networkBooks)
  const reprocess = new ReprocessService(library, books)
  return { server, sources, search, service, readerService, bookSearch, reprocess, books }
}

describe('network book lifecycle', () => {
  it('runs import -> search -> add -> read -> relink -> download -> convert -> reclean', async () => {
    const { server, sources, search, service, readerService, bookSearch, reprocess, books } =
      await setupFull()

    const imported = await sources.importJson(JSON.stringify(sourceJson(server.url)))
    expect(imported.added).toBe(1)

    const found = await search.search(
      { requestId: 'e2e', keyword: '测试书', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    const item = found.groups[0].items[0]
    expect(item.title).toBe('测试书')

    const entry = await service.add({ sourceId: item.sourceId, bookUrl: item.bookUrl })
    expect(entry.format).toBe('network')

    const opened = await readerService.open(entry.id)
    expect(opened.contentMode).toBe('lazy')
    expect(opened.chapters).toEqual([])

    expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
    const cachedSearch = await bookSearch.search(entry.id, '正文一', 'e2e-search', () => {})
    expect(cachedSearch.cachedOnly).toBe(true)
    expect(cachedSearch.skippedUncached).toBe(1)
    expect(cachedSearch.hits.length).toBeGreaterThan(0)

    await sources.remove(item.sourceId)
    expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('书源已删除')

    await sources.importJson(JSON.stringify(sourceJson(server.url)))
    await service.relinkSources()
    expect((await service.updateToc(entry.id)).total).toBe(2)

    const download = await service.downloadAll(entry.id, () => {})
    expect(download.failedChapters).toEqual([])
    expect(download.done).toBe(download.total)

    const converted = await service.convertToLocal(entry.id)
    expect(converted.chapterCount).toBe(2)
    const meta = await books.readMeta(entry.id)
    expect(meta.format).toBe('txt')
    expect(meta.chapters.every((chapter) => chapter.simhash && chapter.charCount > 0)).toBe(true)

    const after = await readerService.open(entry.id)
    expect(after.contentMode).toBe('eager')
    expect(after.chapters.join('\n')).toContain('正文一')

    const recleaned = await reprocess.reclean(entry.id)
    expect(recleaned.chapterCount).toBe(2)
  })
})
