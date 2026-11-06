import { mkdtemp, rm } from 'node:fs/promises'
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

describe('NetworkBookService conversion', () => {
  it('refuses conversion before the whole book is downloaded', async () => {
    const { service, server } = await setup()
    const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    await expect(service.convertToLocal(entry.id)).rejects.toThrow('未下载全本')
  })

  it('converts a complete network book to a local book and keeps progress', async () => {
    const { service, server, books, library, networkBooks } = await setup()
    const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    await service.downloadAll(entry.id, () => {})
    // raw 首行与章节标题相同时，转换后只保留一行标题。
    await networkBooks.writeChapter(entry.id, 1, '第二章\n正文二', '正文二')
    await books.writeProgress(entry.id, {
      progress: { chapterKey: 'x', chapterIndex: 1, paragraphIndex: 0, percent: 50, updatedAt: new Date().toISOString() },
      bookmarks: []
    })
    const result = await service.convertToLocal(entry.id)
    expect(result.chapterCount).toBe(2)
    expect(result.warnings).toEqual([])
    const meta = await books.readMeta(entry.id)
    expect(meta.format).toBe('txt')
    expect(meta.network).toBeUndefined()
    expect(meta.chapters[1].url).toBeUndefined()
    // startLine 对齐 source.txt，charCount/simhash 用清洗后正文回填。
    const lines = (await books.readSource(entry.id)).split(/\r?\n/)
    expect(lines[meta.chapters[1].startLine]).toBe('第二章')
    expect(lines.filter((line) => line === '第二章')).toHaveLength(1)
    expect(meta.chapters[1].charCount).toBe('正文二'.length)
    expect(meta.chapters[1].simhash).not.toBe('')
    const updated = (await library.list()).find((item) => item.id === entry.id)!
    expect(updated.format).toBe('txt')
    expect(updated.sourceName).toBe('源A')
    expect(updated.downloadState).toBeUndefined()
    expect(updated.progressPercent).toBe(0)
    expect((await books.readProgress(entry.id)).progress?.chapterIndex).toBe(1)
    expect(await books.readChapter(entry.id, 1)).toContain('正文二')
  })

  it('keeps cached chapters readable after the source is deleted', async () => {
    const { service, server } = await setup()
    const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
    await service.readChapter(entry.id, 0)
    await service.sources.remove((await service.sources.list())[0].id)
    expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('书源已删除')
  })

  it('relinks a network book when the same source URL is imported again', async () => {
    const { service, server, library } = await setup()
    const sourceId = (await service.sources.list())[0].id
    const entry = await service.add({ sourceId, bookUrl: `${server.url}/info` })
    const raw = await service.sources.raw(sourceId)
    await service.sources.remove(sourceId)
    expect((await library.list())[0].sourceId).toBe(sourceId)

    await service.sources.importJson(JSON.stringify(raw))
    const fresh = (await service.sources.list()).find((item) => item.url === server.url)!
    expect(fresh.id).not.toBe(sourceId)
    await service.relinkSources()
    expect((await library.list())[0].sourceId).toBe(fresh.id)
    expect((await service.updateToc(entry.id)).total).toBe(2)
  })
})
