import type { AdRule, CleanedChapter, ImportStats } from '../../core/model'
import { splitChapters } from '../../core/chapters'
import { BUILTIN_AD_RULES, cleanChapters } from '../../core/cleaning'
import { buildBookDocuments } from '../../core/compose'
import { chaptersFromLines } from '../../core/reprocess'
import type { ReprocessResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookFiles, BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export class ReprocessService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly userRules: () => AdRule[] = () => []
  ) {}

  async reclean(id: string): Promise<ReprocessResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const chapters = chaptersFromLines(book.sourceText, book.meta)
      return this.commit(id, book, chapters)
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
          warning: '没有识别到至少 3 个章节标题，已保持原章节'
        }
      }
      return this.commit(id, book, split.chapters)
    })
  }

  private async load(id: string): Promise<BookFiles> {
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书，可能已被删除')
    return this.books.readBook(id)
  }

  private async commit(
    id: string,
    book: BookFiles,
    chapters: CleanedChapter[]
  ): Promise<ReprocessResult> {
    const cleaned = cleanChapters(chapters, [...BUILTIN_AD_RULES, ...this.userRules()])
    if (cleaned.chapters.every((chapter) => chapter.paragraphs.length === 0)) {
      throw new Error('重新清洗后没有可阅读的正文，已取消')
    }

    const documents = buildBookDocuments({
      id,
      title: book.meta.title,
      encoding: book.meta.encoding,
      createdAt: book.meta.createdAt,
      sourceText: book.sourceText,
      chapters: cleaned.chapters
    })
    const stats: ImportStats = {
      adLinesRemoved: cleaned.adLinesRemoved,
      duplicateParagraphsMerged: cleaned.duplicateParagraphsMerged,
      suspectedDuplicateChapters: documents.meta.chapters.filter(
        (chapter) => chapter.flags.suspectedDuplicate
      ).length
    }

    const progress = await this.books.readProgress(id)
    await this.books.writeBook(documents)
    await this.books.writeProgress(id, progress)
    await this.library.save(
      (await this.library.list()).map((entry) =>
        entry.id === id
          ? { ...entry, chapterCount: documents.meta.chapters.length, stats }
          : entry
      )
    )

    return { id, chapterCount: documents.meta.chapters.length, stats }
  }
}
