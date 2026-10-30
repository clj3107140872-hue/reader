import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReaderService } from '../src/main/services/reader'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import type { BookMeta, LibraryEntry } from '../src/core/model'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: ReaderService

const bookId = 'book-1'

function meta(): BookMeta {
  return {
    version: 1,
    id: bookId,
    title: '测试书',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'hash-1', startLine: 0, charCount: 6, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'hash-2', startLine: 2, charCount: 6, simhash: '2', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function entry(): LibraryEntry {
  return {
    id: bookId,
    title: '测试书',
    normalizedTitle: '测试书',
    sourceFileName: '测试书.txt',
    fileHash: 'hash',
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount: 2,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-reader-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new ReaderService(library, books)
  await books.writeBook({
    meta: meta(),
    sourceText: '第一章\n第一段。\n第二章\n第二段。',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。', '另一段。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
    ]
  })
  await library.add(entry())
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ReaderService', () => {
  it('opens a book with aligned chapter text and empty progress', async () => {
    const payload = await service.open(bookId)
    expect(payload.meta.title).toBe('测试书')
    expect(payload.chapters).toEqual(['第一段。\n\n另一段。', '第二段。'])
    expect(payload.progress).toBeNull()
    expect(payload.bookmarks).toEqual([])
  })

  it('saves progress and updates the library entry', async () => {
    await service.saveProgress(bookId, {
      chapterKey: 'hash-2',
      chapterIndex: 1,
      paragraphIndex: 0,
      percent: 66.67,
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    expect((await books.readProgress(bookId)).progress?.percent).toBe(66.67)
    const stored = (await library.list())[0]
    expect(stored.progressPercent).toBe(66.67)
    expect(stored.lastReadAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('adds and removes bookmarks without losing progress', async () => {
    await service.saveProgress(bookId, {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      percent: 10,
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    const bookmarks = await service.addBookmark(bookId, {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      excerpt: '另一段。'
    })
    expect(bookmarks).toHaveLength(1)
    expect((await service.open(bookId)).progress?.percent).toBe(10)

    const remaining = await service.removeBookmark(bookId, bookmarks[0].id)
    expect(remaining).toEqual([])
    expect((await service.open(bookId)).bookmarks).toEqual([])
  })

  it('deduplicates bookmarks at the same position when two writes race', async () => {
    const input = {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      excerpt: '另一段。'
    }

    await Promise.all([service.addBookmark(bookId, input), service.addBookmark(bookId, input)])

    const stored = await service.open(bookId)
    expect(stored.bookmarks).toHaveLength(1)
    expect(stored.bookmarks[0].chapterKey).toBe('hash-1')
    expect(stored.bookmarks[0].paragraphIndex).toBe(1)
  })

  it('rejects a missing chapter file with a readable error', async () => {
    const payload = await service.open(bookId)
    await rm(join(root, 'books', bookId, 'chapters', '00001.txt'))
    expect(payload.chapters).toHaveLength(2)
    await expect(service.open(bookId)).rejects.toThrow('章节文件缺失')
  })
})
