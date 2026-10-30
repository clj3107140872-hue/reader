import { randomUUID } from 'node:crypto'
import type { Bookmark, BookProgress } from '../../core/model'
import type { NewBookmark, OpenBookPayload } from '../../shared/api'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

function assertBookId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('无效的书籍编号')
}

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
    for (const chapter of meta.chapters) {
      try {
        chapters.push(await this.books.readChapter(id, chapter.index))
      } catch {
        throw new Error(`章节文件缺失：${chapter.title}`)
      }
    }
    const stored = await this.books.readProgress(id)
    return { meta, chapters, progress: stored.progress, bookmarks: stored.bookmarks }
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
