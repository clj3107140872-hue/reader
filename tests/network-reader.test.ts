import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { ReaderService } from '../src/main/services/reader'
import { SearchService } from '../src/main/services/search'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-netread-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('network book reading', () => {
  it('opens a network book lazily and only lists cached chapter indexes', async () => {
    const books = new BookRepository(root)
    const network = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const, id: 'b1', title: '网络书', encoding: 'utf-8', format: 'network' as const,
      chapters: [
        { index: 0, title: '一', level: 'chapter' as const, titleHash: 'a', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'https://example.com/1' },
        { index: 1, title: '二', level: 'chapter' as const, titleHash: 'b', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'https://example.com/2' }
      ],
      createdAt: new Date().toISOString(),
      network: { sourceId: 's1', sourceUrl: 'https://example.com', sourceName: '源', bookUrl: 'https://example.com/b', tocUrl: 'https://example.com/toc', lastTocAt: null, lastCheckAt: null }
    }
    await network.create(meta)
    await network.writeChapter('b1', 1, '原始', '清洗后')
    const payload = await new ReaderService(new LibraryRepository(root), books, network).open('b1')
    expect(payload.contentMode).toBe('lazy')
    expect(payload.chapters).toEqual([])
    expect(payload.cachedChapters).toEqual([1])

    const localMeta = { ...meta, id: 'b2', format: 'txt' as const, network: undefined, chapters: [{ ...meta.chapters[0], url: undefined }] }
    await books.writeBook({ meta: localMeta, sourceText: '一\n\n正文', chapters: [{ title: '一', level: 'chapter', startLine: 0, paragraphs: ['正文'] }] })
    const local = await new ReaderService(new LibraryRepository(root), books, network).open('b2')
    expect(local.contentMode).toBe('eager')
    expect(local.chapters).toEqual(['正文'])
    expect(local.cachedChapters).toEqual([])

    // A book imported before `format` existed has no field at all and must
    // keep the eager local path.
    const legacyMeta = { ...localMeta, id: 'b3', format: undefined }
    await books.writeBook({
      meta: legacyMeta,
      sourceText: '一\n\n旧正文',
      chapters: [{ title: '一', level: 'chapter', startLine: 0, paragraphs: ['旧正文'] }]
    })
    const legacy = await new ReaderService(new LibraryRepository(root), books, network).open('b3')
    expect(legacy.contentMode).toBe('eager')
    expect(legacy.chapters).toEqual(['旧正文'])
  })

  it('searches only cached network chapters and says so', async () => {
    const books = new BookRepository(root)
    const network = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const, id: 'b1', title: '网络书', encoding: 'utf-8', format: 'network' as const,
      chapters: [0, 1].map((index) => ({ index, title: `第${index + 1}章`, level: 'chapter' as const, titleHash: `h${index}`, startLine: 0, charCount: 0, simhash: '', flags: {}, url: `https://example.com/${index}` })),
      createdAt: new Date().toISOString(),
      network: { sourceId: 's1', sourceUrl: 'https://example.com', sourceName: '源', bookUrl: 'https://example.com/b', tocUrl: 'https://example.com/toc', lastTocAt: null, lastCheckAt: null }
    }
    await network.create(meta)
    await network.writeChapter('b1', 0, '原始', '这里有关键词')
    const result = await new SearchService(books, network).search('b1', '关键词', 't1', () => {})
    expect(result.hits).toHaveLength(1)
    expect(result.cachedOnly).toBe(true)
    expect(result.skippedUncached).toBe(1)
    expect(result.warnings.join('')).toContain('仅搜索已缓存')
  })
})
