import { basename } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { CleanedChapter, ChapterMeta, ImportStats } from '../../core/model'
import { splitAtMarkerLines, splitChapters } from '../../core/chapters'
import { BUILTIN_AD_RULES, cleanChapters } from '../../core/cleaning'
import type { CleaningRunConfig } from '../../core/cleaning'
import { buildBookDocuments } from '../../core/compose'
import { decodeWithEncoding, isSupportedEncoding } from '../../core/encoding'
import type { SupportedEncoding } from '../../core/encoding'
import { repairMojibake } from '../../core/mojibake'
import { chaptersFromLines } from '../../core/reprocess'
import type { ChapterLinesPayload, EncodingPreview, ReprocessResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookFiles, BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

interface CommitOptions {
  reason: 'reclean' | 'resplit' | 'encoding'
  chapterStarts?: number[]
  encoding?: string
  sourceText?: string
}

function lineStarts(chapters: ChapterMeta[], lines: string[]): number[] {
  return chapters
    .filter((chapter) => lines[chapter.startLine]?.trim() === chapter.title)
    .map((chapter) => chapter.startLine)
}

export class ReprocessService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly cleaning: () => CleaningRunConfig = () => ({
      adCleaning: true,
      rules: BUILTIN_AD_RULES
    })
  ) {}

  async reclean(id: string): Promise<ReprocessResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const chapters = chaptersFromLines(book.sourceText, book.meta)
      return this.commit(id, book, chapters, {
        reason: 'reclean',
        chapterStarts: book.meta.chapterStarts
      })
    })
  }

  async resplit(id: string): Promise<ReprocessResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const split = splitChapters(book.sourceText)
      if (!split.detected) {
        return {
          id,
          chapterCount: book.meta.chapters.length,
          stats: (await this.library.list()).find((entry) => entry.id === id)?.stats ?? {
            adLinesRemoved: 0,
            duplicateParagraphsMerged: 0,
            suspectedDuplicateChapters: 0
          },
          warning: '没有识别到至少 3 个章节标题，已保持原样'
        }
      }
      // A fresh automatic split replaces any earlier manual markers.
      return this.commit(id, book, split.chapters, { reason: 'resplit' })
    })
  }

  /** Source lines plus the markers currently in effect, for the marker dialog. */
  async chapterLines(id: string): Promise<ChapterLinesPayload> {
    assertBookId(id)
    const book = await this.load(id)
    const lines = book.sourceText.split(/\r\n|\r|\n/)
    return {
      lines,
      starts: book.meta.chapterStarts ?? lineStarts(book.meta.chapters, lines)
    }
  }

  async applyChapterStarts(id: string, starts: number[]): Promise<ReprocessResult> {
    assertBookId(id)
    if (!Array.isArray(starts) || !starts.every((line) => Number.isInteger(line))) {
      throw new Error('无效的章节标记')
    }
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const lines = book.sourceText.split(/\r\n|\r|\n/)
      const unique = [...new Set(starts)].sort((a, b) => a - b)
      if (unique.length === 0) throw new Error('请至少标记一个章节标题')
      if (unique.some((line) => line < 0 || line >= lines.length)) {
        throw new Error('无效的章节标记')
      }
      if (unique.some((line) => lines[line].trim() === '')) {
        throw new Error('不能把空行标记为章节标题')
      }
      const split = splitAtMarkerLines(book.sourceText, unique)
      return this.commit(id, book, split.chapters, {
        reason: 'resplit',
        chapterStarts: unique
      })
    })
  }

  async encodingPreview(id: string, encoding: SupportedEncoding): Promise<EncodingPreview> {
    assertBookId(id)
    if (!isSupportedEncoding(encoding)) throw new Error('不支持的编码')
    const book = await this.load(id)
    if (book.meta.format === 'epub') throw new Error('EPUB 书籍无需切换编码')
    if (!book.original) throw new Error('缺少原始文件数据，无法切换编码')
    const decoded = decodeWithEncoding(book.original, encoding)
    const repair = repairMojibake(decoded.text, decoded.encoding)
    const all = repair.text.split(/\r\n|\r|\n/)
    return {
      encoding,
      lines: all.slice(0, 60),
      totalLines: all.length,
      warnings: repair.warnings
    }
  }

  async applyEncoding(id: string, encoding: SupportedEncoding): Promise<ReprocessResult> {
    assertBookId(id)
    if (!isSupportedEncoding(encoding)) throw new Error('不支持的编码')
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      if (book.meta.format === 'epub') throw new Error('EPUB 书籍无需切换编码')
      if (!book.original) throw new Error('缺少原始文件数据，无法切换编码')
      const decoded = decodeWithEncoding(book.original, encoding)
      const repair = repairMojibake(decoded.text, decoded.encoding)
      const split = book.meta.chapterStarts
        ? splitAtMarkerLines(repair.text, book.meta.chapterStarts)
        : splitChapters(repair.text)
      return this.commit(id, book, split.chapters, {
        reason: 'encoding',
        encoding,
        chapterStarts: book.meta.chapterStarts,
        sourceText: repair.text
      })
    })
  }

  /** Attach the original file to books imported before raw bytes were kept. */
  async attachOriginal(id: string, filePath: string): Promise<{ fileName: string }> {
    assertBookId(id)
    await this.load(id)
    const bytes = await readFile(filePath)
    if (bytes.length === 0) throw new Error('空文件')
    await this.books.writeOriginal(id, bytes)
    return { fileName: basename(filePath) }
  }

  private async load(id: string): Promise<BookFiles> {
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书，可能已被删除')
    return this.books.readBook(id)
  }

  private async commit(
    id: string,
    book: BookFiles,
    chapters: CleanedChapter[],
    options: CommitOptions
  ): Promise<ReprocessResult> {
    const config = this.cleaning()
    const cleaned = cleanChapters(chapters, config.rules, { adCleaning: config.adCleaning })
    if (cleaned.chapters.every((chapter) => chapter.paragraphs.length === 0)) {
      throw new Error('重新清洗后没有可阅读的正文，已取消')
    }

    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书，可能已被删除')

    const documents = buildBookDocuments({
      id,
      title: book.meta.title,
      encoding: options.encoding ?? book.meta.encoding,
      createdAt: book.meta.createdAt,
      sourceText: options.sourceText ?? book.sourceText,
      chapterStarts: options.chapterStarts,
      chapters: cleaned.chapters,
      ...(book.meta.format ? { format: book.meta.format } : {}),
      ...(book.meta.author ? { author: book.meta.author } : {}),
      ...(book.meta.cover ? { cover: book.meta.cover } : {})
    })
    const stats: ImportStats = {
      adLinesRemoved: cleaned.adLinesRemoved,
      duplicateParagraphsMerged: cleaned.duplicateParagraphsMerged,
      suspectedDuplicateChapters: documents.meta.chapters.filter(
        (chapter) => chapter.flags.suspectedDuplicate
      ).length
    }

    const progress = await this.books.readProgress(id)
    const { backupDir } = await this.books.writeBook(documents)
    if (backupDir) {
      try {
        await this.books.annotateBackup(backupDir, { reason: options.reason, targetEntry: entry })
      } catch {
        // The backup is still restorable; only its label is missing.
      }
    }
    await this.books.writeProgress(id, progress)
    await this.library.save(
      (await this.library.list()).map((entry) =>
        entry.id === id
          ? {
              ...entry,
              encoding: documents.meta.encoding,
              chapterCount: documents.meta.chapters.length,
              stats
            }
          : entry
      )
    )

    return { id, chapterCount: documents.meta.chapters.length, stats }
  }
}
