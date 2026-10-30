import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookRepository } from '../src/main/storage/book'
import type { BookFiles } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import type { BookMeta, LibraryEntry } from '../src/core/model'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-storage-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(id: string, title: string): LibraryEntry {
  return {
    id,
    title,
    normalizedTitle: title,
    sourceFileName: `${title}.txt`,
    fileHash: `hash-${id}`,
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount: 2,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

function meta(id: string): BookMeta {
  return {
    version: 1,
    id,
    title: id,
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'aaaaaaaa', startLine: 0, charCount: 10, simhash: '0000000000000001', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'bbbbbbbb', startLine: 5, charCount: 10, simhash: '0000000000000002', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('LibraryRepository', () => {
  it('adds, updates and removes entries', async () => {
    const library = new LibraryRepository(root)
    await library.add(entry('a', '甲书'))
    await library.add(entry('b', '乙书'))
    expect((await library.list()).map((e) => e.id)).toEqual(['a', 'b'])

    await library.update('a', { progressPercent: 42 })
    expect((await library.list())[0].progressPercent).toBe(42)

    await library.remove('a')
    expect((await library.list()).map((e) => e.id)).toEqual(['b'])
    expect(await library.findByFileHash('hash-b')).not.toBeNull()
    expect(await library.findByFileHash('hash-a')).toBeNull()
  })

  it('falls back to the backup file when the main index is corrupt', async () => {
    const library = new LibraryRepository(root)
    await library.add(entry('a', '甲书'))
    await library.add(entry('b', '乙书'))
    await writeFile(join(root, 'library.json'), '{ not valid json', 'utf8')
    expect((await library.list()).map((e) => e.id)).toEqual(['a'])
  })

  it('serializes concurrent additions without losing entries', async () => {
    const library = new LibraryRepository(root)
    await Promise.all(
      Array.from({ length: 8 }, (_, index) => library.add(entry(`book-${index}`, `书${index}`)))
    )
    expect((await library.list()).map((item) => item.id).sort()).toEqual(
      Array.from({ length: 8 }, (_, index) => `book-${index}`).sort()
    )
  })

  it('finds a book by any of its merged source hashes', async () => {
    const library = new LibraryRepository(root)
    await library.add({ ...entry('a', '甲书'), fileHashes: ['hash-a', 'hash-b'] })
    expect((await library.findByFileHash('hash-b'))?.id).toBe('a')
  })
})

describe('BookRepository', () => {
  it('writes a book and reads chapters back', async () => {
    const books = new BookRepository(root)
    const bookMeta = meta('book-1')
    await books.writeBook({
      meta: bookMeta,
      sourceText: '第一章\n第一段。\n第二章\n第二段。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。', '另一段。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
      ]
    })

    expect(await books.readMeta('book-1')).toEqual(bookMeta)
    expect(await books.readChapter('book-1', 0)).toBe('第一段。\n\n另一段。')
    expect(await books.readSource('book-1')).toContain('第一段。')
    expect(await readFile(join(root, 'books', 'book-1', 'chapters', '00000.txt'), 'utf8')).toBe('第一段。\n\n另一段。')
  })

  it('backs up the previous book directory on rewrite', async () => {
    const books = new BookRepository(root)
    const bookMeta = meta('book-1')
    const files: BookFiles = {
      meta: bookMeta,
      sourceText: '原文',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 1, paragraphs: ['第二段。'] }
      ]
    }
    await books.writeBook(files)
    await books.writeBook({ ...files, sourceText: '新的原文' })

    const backups = await readdir(join(root, 'books', 'book-1', 'backup'))
    expect(backups.length).toBe(1)
    expect(await books.readSource('book-1')).toBe('新的原文')
  })

  it('reads and writes progress with bookmarks', async () => {
    const books = new BookRepository(root)
    await books.writeBook({
      meta: meta('book-2'),
      sourceText: '原文',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 1, paragraphs: ['第二段。'] }
      ]
    })
    expect(await books.readProgress('book-2')).toEqual({ progress: null, bookmarks: [] })
    await books.writeProgress('book-2', {
      progress: { chapterKey: 'aaaaaaaa', chapterIndex: 0, paragraphIndex: 1, percent: 50, updatedAt: '2026-01-02T00:00:00.000Z' },
      bookmarks: []
    })
    const stored = await books.readProgress('book-2')
    expect(stored.progress?.percent).toBe(50)
  })

  it('removes a book directory', async () => {
    const books = new BookRepository(root)
    await books.writeBook({
      meta: meta('book-3'),
      sourceText: '第一章\n第一段。\n第二章\n第二段。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
      ]
    })
    await books.remove('book-3')
    await expect(books.readMeta('book-3')).rejects.toThrow('书籍数据缺失')
  })

  it('reads a whole book back for merge and reprocess', async () => {
    const books = new BookRepository(root)
    await books.writeBook({
      meta: meta('book-4'),
      sourceText: '第一章\n第一段。\n第二章\n第二段。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
      ]
    })

    const files = await books.readBook('book-4')
    expect(files.chapters.map((chapter) => chapter.paragraphs)).toEqual([['第一段。'], ['第二段。']])
    expect(files.sourceText).toContain('第一章')
  })
})
