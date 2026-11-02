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

function chapterMetas(id: string, count: number): BookMeta['chapters'] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    title: `第${index + 1}章`,
    level: 'chapter' as const,
    titleHash: `${id}-h${index}`,
    startLine: index,
    charCount: 3,
    simhash: '1',
    flags: {}
  }))
}

async function seedBook(
  id: string,
  title: string,
  normalizedTitle: string,
  chapterCount: number,
  importedAt: string
): Promise<void> {
  const chapters = chapterMetas(id, chapterCount)
  await books.writeBook({
    meta: { ...meta(id, title), chapters },
    sourceText: '',
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      level: chapter.level,
      startLine: chapter.startLine,
      paragraphs: [`${title}正文。`]
    }))
  })
  await library.add({
    ...entry(id, title),
    normalizedTitle,
    importedAt,
    chapterCount
  })
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

  it('finds books with the same normalized title and keeps the longer one', async () => {
    await seedBook('book-1', '分卷书', '分卷书', 1, '2026-01-01T00:00:00.000Z')
    await seedBook('book-2', '分卷书', '分卷书', 3, '2026-01-02T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.warnings).toEqual([])
    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({
      targetId: 'book-2',
      targetTitle: '分卷书',
      sourceId: 'book-1',
      sourceTitle: '分卷书',
      overlap: 0
    })
  })

  it('finds overlap when normalized titles differ', async () => {
    const chapters = Array.from({ length: 3 }, (_, index) => ({
      index,
      title: `第${index + 1}章`,
      level: 'chapter' as const,
      titleHash: `shared-h${index}`,
      startLine: index,
      charCount: 3,
      simhash: '1',
      flags: {}
    }))
    const ids = ['book-1', 'book-2']
    const titles = ['甲书', '乙书']
    const importedAt = ['2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z']
    for (let index = 0; index < ids.length; index++) {
      await books.writeBook({
        meta: { ...meta(ids[index], titles[index]), chapters },
        sourceText: '',
        chapters: chapters.map((chapter) => ({
          title: chapter.title,
          level: chapter.level,
          startLine: chapter.startLine,
          paragraphs: ['完全相同的正文内容。']
        }))
      })
      await library.add({
        ...entry(ids[index], titles[index]),
        normalizedTitle: titles[index],
        importedAt: importedAt[index],
        chapterCount: 3
      })
    }

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.candidates).toHaveLength(1)
    expect(result.candidates[0]).toMatchObject({ overlap: 1 })
  })

  it('prefers the earlier import when chapter counts are equal', async () => {
    await seedBook('book-1', '同书', '同书', 2, '2026-01-02T00:00:00.000Z')
    await seedBook('book-2', '同书', '同书', 2, '2026-01-01T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.candidates[0]).toMatchObject({ targetId: 'book-2', sourceId: 'book-1' })
  })

  it('returns no candidates for unrelated books', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')
    await seedBook('book-2', '乙书', '乙书', 2, '2026-01-02T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.candidates).toEqual([])
  })

  it('returns empty candidates for fewer than two books', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')

    const result = await service.findMerges(['book-1'])

    expect(result.candidates).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('skips a book whose files are missing', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')
    await library.add(entry('book-2', '乙书'))

    const result = await service.findMerges(['book-1', 'book-2', 'missing'])

    expect(result.candidates).toEqual([])
    expect(result.warnings).toContain('《乙书》数据缺失，已跳过')
    expect(result.warnings).toContain('有 1 本书已不在书架，已跳过')
  })
})
