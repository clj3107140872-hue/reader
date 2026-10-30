import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../src/core/model'
import { splitChapters } from '../src/core/chapters'
import { parseBookFile } from '../src/core/pipeline'
import { normalizeBookTitle } from '../src/core/sameBook'
import { MergeService } from '../src/main/services/merge'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: MergeService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-merge-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new MergeService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function volumeText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(
      `第${i}章 风起`,
      `第${i}章正文第一段。`,
      `第${i}章正文第二段。`,
      ''
    )
  }
  return lines.join('\n')
}

async function importVolume(
  id: string,
  fileName: string,
  from: number,
  to: number
): Promise<LibraryEntry> {
  const parsed = parseBookFile(Buffer.from(volumeText(from, to), 'utf8'), fileName, {
    id,
    now: '2026-01-01T00:00:00.000Z'
  })
  await books.writeBook({
    meta: parsed.meta,
    sourceText: parsed.sourceText,
    chapters: parsed.chapters
  })
  const entry: LibraryEntry = {
    id,
    title: parsed.title,
    normalizedTitle: normalizeBookTitle(fileName),
    sourceFileName: fileName,
    fileHash: `hash-${id}`,
    fileHashes: [`hash-${id}`],
    sourceFileNames: [fileName],
    encoding: parsed.encoding,
    importedAt: parsed.meta.createdAt,
    lastReadAt: null,
    chapterCount: parsed.meta.chapters.length,
    progressPercent: 0,
    stats: parsed.stats
  }
  await library.add(entry)
  return entry
}

describe('MergeService', () => {
  it('merges two volumes into one book and deletes the source', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)

    const result = await service.merge('a', 'b')

    expect(result).toMatchObject({
      targetId: 'a',
      title: '测试书',
      chapterCount: 6,
      removedId: 'b'
    })
    const meta = await books.readMeta('a')
    expect(meta.title).toBe('测试书')
    expect(meta.chapters.map((chapter) => chapter.title)).toEqual([
      '第1章 风起',
      '第2章 风起',
      '第3章 风起',
      '第4章 风起',
      '第5章 风起',
      '第6章 风起'
    ])

    const entries = await library.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'a', title: '测试书', chapterCount: 6 })
    expect(entries[0].fileHashes).toEqual(['hash-a', 'hash-b'])
    expect(entries[0].sourceFileNames).toEqual(['测试书_1-3章.txt', '测试书_4-6章.txt'])
    expect(await library.findByFileHash('hash-b')).not.toBeNull()

    await expect(books.readMeta('b')).rejects.toThrow('书籍数据缺失')
  })

  it('keeps the rebuilt source aligned with the merged chapters', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)
    await service.merge('a', 'b')

    const source = await books.readSource('a')
    const split = splitChapters(source)
    expect(split.detected).toBe(true)
    expect(split.chapters.map((chapter) => chapter.title)).toEqual([
      '第1章 风起',
      '第2章 风起',
      '第3章 风起',
      '第4章 风起',
      '第5章 风起',
      '第6章 风起'
    ])
    expect(split.chapters[5].paragraphs).toEqual(['第6章正文第一段。', '第6章正文第二段。'])
  })

  it('keeps target progress and merges source bookmarks', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)

    const targetBook = await books.readBook('a')
    const targetKey = targetBook.meta.chapters[0].titleHash
    await books.writeProgress('a', {
      progress: {
        chapterKey: targetKey,
        chapterIndex: 0,
        paragraphIndex: 1,
        percent: 17,
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      bookmarks: [
        {
          id: 'mark-a',
          chapterKey: targetKey,
          chapterIndex: 0,
          paragraphIndex: 1,
          excerpt: '第一段',
          createdAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    })

    const sourceBook = await books.readBook('b')
    const sourceKey = sourceBook.meta.chapters[0].titleHash
    await books.writeProgress('b', {
      progress: null,
      bookmarks: [
        {
          id: 'mark-b',
          chapterKey: sourceKey,
          chapterIndex: 0,
          paragraphIndex: 0,
          excerpt: '第四段',
          createdAt: '2026-01-03T00:00:00.000Z'
        }
      ]
    })

    await service.merge('a', 'b')

    const stored = await books.readProgress('a')
    expect(stored.progress?.percent).toBe(17)
    expect(stored.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mark-a', 'mark-b'])
    expect(stored.bookmarks.find((bookmark) => bookmark.id === 'mark-b')?.chapterIndex).toBe(3)
  })

  it('remaps bookmark and progress chapter indexes after a reorder', async () => {
    await importVolume('a', '测试书_4-6章.txt', 4, 6)
    await importVolume('b', '测试书_1-3章.txt', 1, 3)

    const targetBook = await books.readBook('a')
    const targetKey = targetBook.meta.chapters[0].titleHash
    await books.writeProgress('a', {
      progress: {
        chapterKey: targetKey,
        chapterIndex: 0,
        paragraphIndex: 1,
        percent: 17,
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      bookmarks: [
        {
          id: 'mark-a',
          chapterKey: targetKey,
          chapterIndex: 0,
          paragraphIndex: 1,
          excerpt: '第四段',
          createdAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    })

    const sourceBook = await books.readBook('b')
    const sourceKey = sourceBook.meta.chapters[0].titleHash
    await books.writeProgress('b', {
      progress: null,
      bookmarks: [
        {
          id: 'mark-b',
          chapterKey: sourceKey,
          chapterIndex: 0,
          paragraphIndex: 0,
          excerpt: '第一段',
          createdAt: '2026-01-03T00:00:00.000Z'
        }
      ]
    })

    await service.merge('a', 'b')

    const stored = await books.readProgress('a')
    expect(stored.progress?.chapterIndex).toBe(3)
    expect(stored.bookmarks.find((bookmark) => bookmark.id === 'mark-a')?.chapterIndex).toBe(3)
    expect(stored.bookmarks.find((bookmark) => bookmark.id === 'mark-b')?.chapterIndex).toBe(0)
  })

  it('deduplicates overlapping chapters from the source', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_1-3章.txt', 1, 3)

    const result = await service.merge('a', 'b')
    expect(result.chapterCount).toBe(3)
  })

  it('backs up the target before rewriting', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)
    await service.merge('a', 'b')

    const backups = await readdir(join(root, 'books', 'a', 'backup'))
    expect(backups).toHaveLength(1)
  })

  it('leaves both books alone when the source is missing', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)

    await expect(service.merge('a', 'missing')).rejects.toThrow('找不到要合并的书')
    expect(await library.list()).toHaveLength(1)
    expect((await books.readMeta('a')).chapters).toHaveLength(3)
  })
})
