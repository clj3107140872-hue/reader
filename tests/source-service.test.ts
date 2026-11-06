import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { HttpClient } from '../src/main/services/network/httpClient'
import { LibraryRepository } from '../src/main/storage/library'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'
let root = ''
let close: (() => Promise<void>) | null = null
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-source-service-')) })
afterEach(async () => {
  if (close) {
    await close()
    close = null
  }
  await rm(root, { recursive: true, force: true })
})

function sourceJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookSourceName: '源A',
    bookSourceUrl: 'https://example.com',
    searchUrl: '/s?q={{key}}',
    ruleSearch: { bookList: '.b', name: '.n', bookUrl: '.l@href' },
    ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
    ruleContent: { content: '#c' },
    ...overrides
  }
}

function service(): SourceService {
  const store = new SourceStore(root)
  return new SourceService(store, new HttpClient(), new LibraryRepository(root))
}

describe('SourceService', () => {
  it('keeps object headers when building a parsed source', async () => {
    const store = new SourceStore(root)
    await store.importParsed([{
      definition: {
        bookSourceName: '源A',
        bookSourceUrl: 'https://example.com',
        searchUrl: '/s?q={{key}}',
        header: { 'User-Agent': 'ReaderTest/1.0', Referer: 'https://example.com' },
        ruleSearch: { bookList: '.b', name: '.n', bookUrl: '.l@href' },
        ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
        ruleContent: { content: '#c' }
      },
      name: '源A',
      url: 'https://example.com',
      group: '',
      searchUrl: '/s?q={{key}}',
      header: {},
      customOrder: 0,
      compat: { level: 'full', issues: [] }
    }])

    const [item] = await store.listItems()
    const sourceService = new SourceService(store, new HttpClient(), new LibraryRepository(root))
    const parsed = await sourceService.require(item.id)
    expect(parsed.header).toEqual({
      'User-Agent': 'ReaderTest/1.0',
      Referer: 'https://example.com'
    })
  })

  it('honors the enabled flag on first import and keeps stored flags on update', async () => {
    const store = new SourceStore(root)
    const sourceService = new SourceService(store, new HttpClient(), new LibraryRepository(root))
    await sourceService.importJson(JSON.stringify(sourceJson({ enabled: false })))
    expect((await store.listItems())[0].enabled).toBe(false)

    await sourceService.importJson(JSON.stringify(sourceJson({ enabled: true })))
    expect((await store.listItems())[0].enabled).toBe(false)
  })

  it('rejects oversized imports and too many sources', async () => {
    const sourceService = service()
    await expect(sourceService.importJson(' '.repeat(5 * 1024 * 1024 + 1))).rejects.toThrow(
      '5 MB'
    )
    const many = Array.from({ length: 501 }, (_, index) =>
      sourceJson({ bookSourceUrl: `https://example.com/${index}` })
    )
    await expect(sourceService.importJson(JSON.stringify(many))).rejects.toThrow('500')
  })

  it('imports a legado share link through its inner url', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(sourceJson({ bookSourceUrl: 'https://example.com/real' })))
    })
    close = server.close
    const sourceService = service()
    const result = await sourceService.importUrl(
      `legado://import/bookSource?src=${encodeURIComponent(`${server.url}/source.json`)}`
    )
    expect(result.added).toBe(1)
    expect((await sourceService.list())[0].url).toBe('https://example.com/real')
  })

  it('rejects a share link whose inner address is not http(s)', async () => {
    const sourceService = service()
    await expect(
      sourceService.importUrl('legado://import/bookSource?src=file%3A%2F%2F%2Fetc%2Fpasswd')
    ).rejects.toThrow('http')
  })
})
