import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BookMeta, LibraryEntry } from '../src/core/model'
import { LibraryService } from '../src/main/services/library'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: LibraryService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-library-service-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new LibraryService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function meta(id: string, title: string): BookMeta {
  return {
    version: 1,
    id,
    title,
    encoding: 'utf8',
    chapters: [
      {
        index: 0,
        title: '第一章',
        level: 'chapter',
        titleHash: `${id}-hash`,
        startLine: 0,
        charCount: 3,
        simhash: '1',
        flags: {}
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

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
    chapterCount: 1,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

async function seed(id: string, title: string): Promise<void> {
  await books.writeBook({
    meta: meta(id, title),
    sourceText: `第一章\n${title}正文。`,
    chapters: [{ title: '第一章', level: 'chapter', startLine: 0, paragraphs: [`${title}正文。`] }]
  })
  await library.add(entry(id, title))
}

describe('LibraryService', () => {
  it('removes the entry and the book files', async () => {
    await seed('book-1', '甲书')

    await service.remove('book-1')

    expect(await library.list()).toEqual([])
    await expect(books.readMeta('book-1')).rejects.toThrow('书籍数据缺失')
  })

  it('keeps other books and ignores an unknown id', async () => {
    await seed('book-1', '甲书')
    await seed('book-2', '乙书')

    await service.remove('missing')
    expect((await library.list()).map((item) => item.id)).toEqual(['book-1', 'book-2'])

    await service.remove('book-1')
    expect((await library.list()).map((item) => item.id)).toEqual(['book-2'])
    expect((await books.readMeta('book-2')).title).toBe('乙书')
  })

  it('rejects an invalid id', async () => {
    await expect(service.remove('../escape')).rejects.toThrow('无效的书籍编号')
  })
})
