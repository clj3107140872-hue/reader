import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BookMeta, LibraryEntry } from '../src/core/model'
import { parseBookFile } from '../src/core/pipeline'
import { normalizeBookTitle } from '../src/core/sameBook'
import { BackupService } from '../src/main/services/backup'
import { MergeService } from '../src/main/services/merge'
import { ReprocessService } from '../src/main/services/reprocess'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let backup: BackupService
let merger: MergeService
let reprocess: ReprocessService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-backup-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  backup = new BackupService(library, books)
  merger = new MergeService(library, books)
  reprocess = new ReprocessService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function volumeText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(`第${i}章 风起`, `第${i}章正文。`, '')
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

function singleChapterMeta(id: string): BookMeta {
  return {
    version: 1,
    id,
    title: '分章书',
    encoding: 'utf8',
    chapters: [
      {
        index: 0,
        title: '第一章',
        level: 'chapter',
        titleHash: 'old-hash',
        startLine: 0,
        charCount: 10,
        simhash: '0000000000000001',
        flags: {}
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('BackupService', () => {
  it('restores the target and the merged source book', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)
    const target = await books.readBook('a')
    await books.writeProgress('a', {
      progress: {
        chapterKey: target.meta.chapters[0].titleHash,
        chapterIndex: 0,
        paragraphIndex: 0,
        percent: 17,
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      bookmarks: [
        {
          id: 'mark-a',
          chapterKey: target.meta.chapters[0].titleHash,
          chapterIndex: 0,
          paragraphIndex: 0,
          excerpt: '第一段',
          createdAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    })

    await merger.merge('a', 'b')
    const [point] = await backup.list('a')
    expect(point).toMatchObject({
      reason: 'merge',
      sourceTitle: '测试书_4-6章',
      chapterCount: 3
    })

    const result = await backup.restore('a', point.name)

    expect(result.restoredSource).toBe(true)
    const entries = await library.list()
    expect(entries.map((entry) => entry.id).sort()).toEqual(['a', 'b'])
    expect(entries.find((entry) => entry.id === 'a')?.chapterCount).toBe(3)
    expect((await books.readMeta('a')).chapters).toHaveLength(3)
    expect((await books.readMeta('b')).chapters).toHaveLength(3)
    const restored = await books.readProgress('a')
    expect(restored.progress?.percent).toBe(17)
    expect(restored.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mark-a'])
  })

  it('restores a pre-resplit backup', async () => {
    const meta = singleChapterMeta('a')
    await books.writeBook({
      meta,
      sourceText: volumeText(1, 3),
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一章正文。'] }
      ]
    })
    const entry: LibraryEntry = {
      id: 'a',
      title: '分章书',
      normalizedTitle: '分章书',
      sourceFileName: '分章书.txt',
      fileHash: 'hash-a',
      encoding: 'utf8',
      importedAt: meta.createdAt,
      lastReadAt: null,
      chapterCount: 1,
      progressPercent: 0,
      stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
    }
    await library.add(entry)

    const result = await reprocess.resplit('a')
    expect(result.chapterCount).toBe(3)
    const [point] = await backup.list('a')
    expect(point).toMatchObject({ reason: 'resplit', chapterCount: 1 })

    await backup.restore('a', point.name)

    expect((await books.readMeta('a')).chapters).toHaveLength(1)
    expect((await library.list())[0].chapterCount).toBe(1)
  })
})
