import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import type { ParsedSource } from '../src/core/booksource/legado'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-network-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function parsed(url = 'https://example.com', name = '源A'): ParsedSource {
  return {
    definition: {
      bookSourceName: name,
      bookSourceUrl: url,
      searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.b', name: '.n', bookUrl: '.l@href' },
      ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
      ruleContent: { content: '#c' }
    },
    name,
    url,
    group: '',
    searchUrl: '/s?q={{key}}',
    header: {},
    customOrder: 0,
    compat: { level: 'full', issues: [] }
  }
}

describe('SourceStore', () => {
  it('imports new sources, updates by URL and keeps flags', async () => {
    const store = new SourceStore(root)
    expect(await store.importParsed([parsed()])).toMatchObject({ added: 1, updated: 0 })
    const [first] = await store.listStored()
    await store.setFlags(first.id, { starred: true })
    expect(await store.importParsed([parsed('https://example.com', '源A2')]))
      .toMatchObject({ added: 0, updated: 1 })
    const [updated] = await store.listStored()
    expect(updated.id).toBe(first.id)
    expect(updated.starred).toBe(true)
    expect((updated.definition as { bookSourceName: string }).bookSourceName).toBe('源A2')
  })

  it('falls back to .bak when sources.json is corrupt', async () => {
    const store = new SourceStore(root)
    await store.importParsed([parsed()])
    await store.importParsed([parsed()])
    await writeFile(join(root, 'sources', 'sources.json'), '{bad', 'utf8')
    expect((await store.listStored()).map((source) => (source.definition as { bookSourceName: string }).bookSourceName)).toEqual(['源A'])
  })

  it('records stats and flushes them', async () => {
    const store = new SourceStore(root)
    const [source] = (await store.importParsed([parsed()]), await store.listStored())
    await store.record(source.id, 'search', 'success', 120)
    await store.flush()
    const text = await readFile(join(root, 'sources', 'stats.json'), 'utf8')
    expect(text).toContain('"successes": 1')
  })

  it('serializes concurrent records without losing updates', async () => {
    const store = new SourceStore(root)
    const [source] = (await store.importParsed([parsed()]), await store.listStored())
    await Promise.all(
      Array.from({ length: 20 }, () => store.record(source.id, 'search', 'success', 10))
    )
    await store.flush()
    const stats = JSON.parse(await readFile(join(root, 'sources', 'stats.json'), 'utf8')) as {
      bySource: Record<string, { search: { attempts: number; successes: number } }>
    }
    expect(stats.bySource[source.id].search.attempts).toBe(20)
    expect(stats.bySource[source.id].search.successes).toBe(20)
  })
})

describe('NetworkBookRepository', () => {
  it('creates meta, writes raw and cleaned chapters, and lists only non-empty caches', async () => {
    const repo = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const,
      id: 'book-1',
      title: '书',
      encoding: 'utf-8',
      format: 'network' as const,
      chapters: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    await repo.create(meta)
    await repo.writeChapter('book-1', 0, '原始正文', '清洗正文')
    expect(await repo.readRawChapter('book-1', 0)).toBe('原始正文')
    expect(await repo.readChapterText('book-1', 0)).toBe('清洗正文')
    expect(await repo.listCachedChapters('book-1')).toEqual([0])
    await repo.writeChapter('book-1', 1, '', '')
    expect(await repo.listCachedChapters('book-1')).toEqual([0])
  })

  it('rejects book ids that could escape the books directory', async () => {
    const repo = new NetworkBookRepository(root)
    await expect(repo.writeChapter('../escape', 0, 'a', 'b')).rejects.toThrow('无效的书籍编号')
  })
})
