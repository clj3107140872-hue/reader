import type {
  Bookmark,
  BookMeta,
  BookProgress,
  ChapterMeta,
  ImportStats,
  LibraryEntry
} from '../../core/model'
import { buildBookDocuments } from '../../core/compose'
import { dedupeCrossChapterParagraphs } from '../../core/dedupe'
import { displayBookTitle, planMerge } from '../../core/sameBook'
import type { MergeResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

function bookmarkKey(bookmark: Bookmark): string {
  return `${bookmark.chapterKey}:${bookmark.paragraphIndex}`
}

function mergeBookmarks(target: Bookmark[], source: Bookmark[]): Bookmark[] {
  const seen = new Set(target.map(bookmarkKey))
  const merged = [...target]
  for (const bookmark of source) {
    const key = bookmarkKey(bookmark)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(bookmark)
  }
  return merged
}

/** Same rule as resolveChapterIndex in the reader: nearest chapter by title hash. */
function remapChapterIndex(chapters: ChapterMeta[], chapterKey: string, fallback: number): number {
  if (chapters.length === 0) return 0
  const matches: number[] = []
  chapters.forEach((chapter, index) => {
    if (chapter.titleHash === chapterKey) matches.push(index)
  })
  if (matches.length > 0) {
    return matches.reduce((best, index) =>
      Math.abs(index - fallback) < Math.abs(best - fallback) ? index : best
    )
  }
  return Math.min(Math.max(fallback, 0), chapters.length - 1)
}

function remapBookmark(bookmark: Bookmark, chapters: ChapterMeta[]): Bookmark {
  return {
    ...bookmark,
    chapterIndex: remapChapterIndex(chapters, bookmark.chapterKey, bookmark.chapterIndex)
  }
}

function remapProgress(
  progress: BookProgress | null,
  chapters: ChapterMeta[]
): BookProgress | null {
  if (!progress) return null
  return {
    ...progress,
    chapterIndex: remapChapterIndex(chapters, progress.chapterKey, progress.chapterIndex)
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function mergedFileHashes(target: LibraryEntry, source: LibraryEntry): string[] {
  return unique([
    target.fileHash,
    ...(target.fileHashes ?? []),
    source.fileHash,
    ...(source.fileHashes ?? [])
  ])
}

function mergedFileNames(target: LibraryEntry, source: LibraryEntry): string[] {
  return unique([
    target.sourceFileName,
    ...(target.sourceFileNames ?? []),
    source.sourceFileName,
    ...(source.sourceFileNames ?? [])
  ])
}

function mergedStats(
  target: LibraryEntry,
  source: LibraryEntry,
  chapters: BookMeta['chapters'],
  crossChapterRemoved: number
): ImportStats {
  return {
    adLinesRemoved: target.stats.adLinesRemoved + source.stats.adLinesRemoved,
    duplicateParagraphsMerged:
      target.stats.duplicateParagraphsMerged +
      source.stats.duplicateParagraphsMerged +
      crossChapterRemoved,
    suspectedDuplicateChapters: chapters.filter((chapter) => chapter.flags.suspectedDuplicate).length
  }
}

/** Coarse shelf percent from the merged position; the reader recomputes it exactly on open. */
function mergedEntryProgress(
  target: LibraryEntry,
  source: LibraryEntry,
  progress: BookProgress | null,
  chapterCount: number
): Pick<LibraryEntry, 'progressPercent' | 'lastReadAt'> {
  if (!progress) {
    return { progressPercent: target.progressPercent, lastReadAt: target.lastReadAt }
  }
  const percent =
    chapterCount > 0
      ? Math.min(100, Math.max(0, Math.round((progress.chapterIndex / chapterCount) * 100)))
      : 0
  const times = [target.lastReadAt, source.lastReadAt, progress.updatedAt].filter(
    (value): value is string => Boolean(value)
  )
  return {
    progressPercent: percent,
    lastReadAt: times.length > 0 ? times.sort()[times.length - 1] : null
  }
}

export class MergeService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async merge(targetId: string, sourceId: string): Promise<MergeResult> {
    assertBookId(targetId)
    assertBookId(sourceId)
    if (targetId === sourceId) throw new Error('不能把一本书合并到它自己')

    return this.library.runExclusive(async () => {
      const entries = await this.library.list()
      const target = entries.find((entry) => entry.id === targetId)
      if (!target) throw new Error('找不到要合并到的书，可能已被删除')
      const source = entries.find((entry) => entry.id === sourceId)
      if (!source) throw new Error('找不到要合并的书，可能已被删除')

      const targetBook = await this.books.readBook(targetId)
      const sourceBook = await this.books.readBook(sourceId)
      const title = displayBookTitle(target.sourceFileName) || target.title
      const merged = dedupeCrossChapterParagraphs(
        planMerge(
          { meta: targetBook.meta, chapters: targetBook.chapters },
          { meta: sourceBook.meta, chapters: sourceBook.chapters }
        )
      )
      const documents = buildBookDocuments({
        id: targetId,
        title,
        encoding: targetBook.meta.encoding,
        createdAt: targetBook.meta.createdAt,
        chapters: merged.chapters
      })

      const targetProgress = await this.books.readProgress(targetId)
      const sourceProgress = await this.books.readProgress(sourceId)
      const progress = remapProgress(
        targetProgress.progress ?? sourceProgress.progress,
        documents.meta.chapters
      )
      const bookmarks = mergeBookmarks(targetProgress.bookmarks, sourceProgress.bookmarks).map(
        (bookmark) => remapBookmark(bookmark, documents.meta.chapters)
      )

      await this.books.writeBook(documents)
      await this.books.writeProgress(targetId, { progress, bookmarks })

      const nextEntries = entries
        .filter((entry) => entry.id !== sourceId)
        .map((entry) =>
          entry.id === targetId
            ? {
                ...entry,
                title,
                chapterCount: documents.meta.chapters.length,
                fileHashes: mergedFileHashes(target, source),
                sourceFileNames: mergedFileNames(target, source),
                stats: mergedStats(target, source, documents.meta.chapters, merged.removed),
                ...mergedEntryProgress(target, source, progress, documents.meta.chapters.length)
              }
            : entry
        )
      await this.library.save(nextEntries)

      let warning: string | undefined
      try {
        await this.books.remove(sourceId)
      } catch {
        warning = '合并已完成，但旧书文件没有删除干净'
      }

      return {
        targetId,
        title,
        chapterCount: documents.meta.chapters.length,
        removedId: sourceId,
        warning
      }
    })
  }
}
