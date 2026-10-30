import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CleanedChapter, LibraryEntry } from '../src/core/model'
import { buildChapterMetas } from '../src/core/pipeline'
import { ReprocessService } from '../src/main/services/reprocess'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: ReprocessService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-reprocess-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new ReprocessService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(chapterCount: number): LibraryEntry {
  return {
    id: 'book-1',
    title: '测试书',
    normalizedTitle: '测试书',
    sourceFileName: '测试书.txt',
    fileHash: 'hash',
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

async function seed(sourceText: string, chapters: CleanedChapter[]): Promise<void> {
  await books.writeBook({
    meta: {
      version: 1,
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      chapters: buildChapterMetas(chapters),
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    sourceText,
    chapters
  })
  await library.add(entry(chapters.length))
  await books.writeProgress('book-1', {
    progress: {
      chapterKey: 'old-key',
      chapterIndex: 0,
      paragraphIndex: 0,
      percent: 33,
      updatedAt: '2026-01-02T00:00:00.000Z'
    },
    bookmarks: [
      {
        id: 'mark-1',
        chapterKey: 'old-key',
        chapterIndex: 0,
        paragraphIndex: 0,
        excerpt: '正文。',
        createdAt: '2026-01-02T00:00:00.000Z'
      }
    ]
  })
}

const AD_SOURCE =
  '第一章\n正文。\n请记住本站\n第二章\n更多正文。\n请记住本站\n第三章\n结尾。\n请记住本站'
const AD_CHAPTERS: CleanedChapter[] = [
  { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['正文。', '请记住本站'] },
  { title: '第二章', level: 'chapter', startLine: 3, paragraphs: ['更多正文。', '请记住本站'] },
  { title: '第三章', level: 'chapter', startLine: 6, paragraphs: ['结尾。', '请记住本站'] }
]

describe('ReprocessService', () => {
  it('recleans chapters, keeps the source, backs up and preserves progress', async () => {
    await seed(AD_SOURCE, AD_CHAPTERS)

    const result = await service.reclean('book-1')

    expect(result.stats.adLinesRemoved).toBe(3)
    expect(await books.readChapter('book-1', 0)).toBe('正文。')
    expect(await books.readSource('book-1')).toBe(AD_SOURCE)
    expect((await books.readMeta('book-1')).chapters.map((chapter) => chapter.startLine)).toEqual([
      0, 3, 6
    ])

    const stored = await books.readProgress('book-1')
    expect(stored.progress?.percent).toBe(33)
    expect(stored.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mark-1'])
    expect((await library.list())[0].stats.adLinesRemoved).toBe(3)

    const backups = await readdir(join(root, 'books', 'book-1', 'backup'))
    expect(backups).toHaveLength(1)
    const oldChapter = await readFile(
      join(root, 'books', 'book-1', 'backup', backups[0], 'chapters', '00000.txt'),
      'utf8'
    )
    expect(oldChapter).toContain('请记住本站')
  })

  it('aborts when a cleaning rule removes all paragraphs', async () => {
    await seed(AD_SOURCE, AD_CHAPTERS)
    const strict = new ReprocessService(library, books, () => [
      { id: 'all', name: '全部删除', type: 'line', pattern: '.*', enabled: true }
    ])

    await expect(strict.reclean('book-1')).rejects.toThrow('没有可阅读的正文')
    expect(await books.readChapter('book-1', 0)).toContain('请记住本站')
    expect((await books.readMeta('book-1')).chapters).toHaveLength(3)
  })

  it('resplits by chapter titles and keeps progress', async () => {
    const sourceText = '第一章\n甲。\n第二章\n乙。\n第三章\n丙。'
    await seed(sourceText, [
      {
        title: '正文',
        level: 'chapter',
        startLine: 0,
        paragraphs: ['第一章', '甲。', '第二章', '乙。', '第三章', '丙。']
      }
    ])

    const result = await service.resplit('book-1')

    expect(result.chapterCount).toBe(3)
    expect(await books.readChapter('book-1', 0)).toBe('甲。')
    expect(await books.readChapter('book-1', 1)).toBe('乙。')
    expect(await books.readChapter('book-1', 2)).toBe('丙。')
    expect(await books.readSource('book-1')).toBe(sourceText)
    expect((await books.readProgress('book-1')).progress?.percent).toBe(33)
    expect((await library.list())[0].chapterCount).toBe(3)
  })

  it('keeps the book unchanged when no chapter titles are detected', async () => {
    const sourceText = '第一章\n甲。\n第二章\n乙。'
    await seed(sourceText, [
      { title: '正文', level: 'chapter', startLine: 0, paragraphs: ['第一章', '甲。', '第二章', '乙。'] }
    ])

    const result = await service.resplit('book-1')

    expect(result.warning).toContain('没有识别到')
    expect(result.chapterCount).toBe(1)
    expect((await books.readMeta('book-1')).chapters).toHaveLength(1)
    await expect(readdir(join(root, 'books', 'book-1', 'backup'))).rejects.toThrow()
  })
})
