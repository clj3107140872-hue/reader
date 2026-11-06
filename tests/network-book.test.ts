import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
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
  await store.importParsed([{
    definition: {
      bookSourceName: '源A', bookSourceUrl: server.url, searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.book', name: '.name', bookUrl: '.name@href' },
      ruleBookInfo: { name: 'h1', author: '.author', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
      ruleContent: { content: '#content@html' }
    },
    name: '源A', url: server.url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
    compat: { level: 'full', issues: [] }
  }])
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
  return { server, service, library, books, networkBooks, source }
}

describe('NetworkBookService', () => {
  it('adds a network book with toc and reads a chapter on demand', async () => {
    const { server, service, library, books } = await setup()
    const entry = await service.add({
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
    const entry = await service.add({
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
    const { service, server } = await setup(() => enabled)
    const entry = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    await service.readChapter(entry.id, 0)
    enabled = false
    expect((await service.readChapter(entry.id, 0)).cached).toBe(true)
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('已关闭联网功能')
  })
})
