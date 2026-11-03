import { randomUUID } from 'node:crypto'
import type { Bookmark, BookProgress } from '../../core/model'
import { chapterFromLines } from '../../core/reprocess'
import type { NewBookmark, OpenBookPayload } from '../../shared/api'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'
import { assertBookId } from '../bookId'

const MISSING_CHAPTER_PLACEHOLDER =
  '（本章文件缺失，内容无法恢复。可从备份恢复或重新导入原文件。）'

export class ReaderService {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  private async locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const run = previous.then(task, task)
    this.locks.set(
      id,
      run.catch(() => undefined)
    )
    return run
  }

  async open(id: string): Promise<OpenBookPayload> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const chapters: string[] = []
    const warnings: string[] = []
    // Loaded only when a chapter file is unusable; null means it is gone too.
    let sourceText: string | null | undefined
    for (const chapter of meta.chapters) {
      try {
        chapters.push(await this.books.readChapter(id, chapter.index))
        continue
      } catch {
        // Rebuild below from the pre-cleaning source that every book keeps.
      }

      if (sourceText === undefined) {
        sourceText = await this.books.readSource(id).catch(() => null)
      }
      const rebuilt =
        sourceText === null
          ? ''
          : chapterFromLines(sourceText, meta, chapter.index).paragraphs.join('\n\n').trim()

      if (rebuilt === '') {
        chapters.push(MISSING_CHAPTER_PLACEHOLDER)
        warnings.push(
          `第 ${chapter.index + 1} 章《${chapter.title}》文件缺失且无法从原文重建，已显示占位内容`
        )
      } else {
        chapters.push(rebuilt)
        warnings.push(`第 ${chapter.index + 1} 章《${chapter.title}》文件缺失，已从原文重建`)
      }
    }
    const stored = await this.books.readProgress(id)
    return { meta, chapters, warnings, progress: stored.progress, bookmarks: stored.bookmarks }
  }

  async saveProgress(id: string, progress: BookProgress): Promise<void> {
    assertBookId(id)
    await this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      await this.books.writeProgress(id, { progress, bookmarks: stored.bookmarks })
      await this.library.update(id, {
        progressPercent: progress.percent,
        lastReadAt: progress.updatedAt
      })
    })
  }

  async addBookmark(id: string, input: NewBookmark): Promise<Bookmark[]> {
    assertBookId(id)
    return this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      const existing = stored.bookmarks.find(
        (item) =>
          item.chapterKey === input.chapterKey && item.paragraphIndex === input.paragraphIndex
      )
      if (existing) return stored.bookmarks
      const bookmark: Bookmark = {
        id: randomUUID(),
        chapterKey: input.chapterKey,
        chapterIndex: input.chapterIndex,
        paragraphIndex: input.paragraphIndex,
        excerpt: input.excerpt,
        createdAt: new Date().toISOString()
      }
      const bookmarks = [...stored.bookmarks, bookmark]
      await this.books.writeProgress(id, { progress: stored.progress, bookmarks })
      return bookmarks
    })
  }

  async removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]> {
    assertBookId(id)
    return this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      const bookmarks = stored.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
      await this.books.writeProgress(id, { progress: stored.progress, bookmarks })
      return bookmarks
    })
  }
}
