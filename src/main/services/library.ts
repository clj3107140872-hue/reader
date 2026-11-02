import type { BookMeta, LibraryEntry } from '../../core/model'
import { chapterMatchRateFromIndexes, indexChapters } from '../../core/sameBook'
import type { FindMergesResult, MergeCandidate } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

interface CandidateBook {
  entry: LibraryEntry
  meta: BookMeta
}

function pickDirection(a: CandidateBook, b: CandidateBook): [CandidateBook, CandidateBook] {
  const aCount = a.meta.chapters.length
  const bCount = b.meta.chapters.length
  if (aCount !== bCount) return aCount > bCount ? [a, b] : [b, a]
  const byImported = a.entry.importedAt.localeCompare(b.entry.importedAt)
  if (byImported !== 0) return byImported < 0 ? [a, b] : [b, a]
  return a.entry.id.localeCompare(b.entry.id) <= 0 ? [a, b] : [b, a]
}

export class LibraryService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async remove(id: string): Promise<void> {
    assertBookId(id)
    let removed = false
    await this.library.runExclusive(async () => {
      const entries = await this.library.list()
      if (!entries.some((entry) => entry.id === id)) return
      removed = true
      await this.library.save(entries.filter((entry) => entry.id !== id))
    })
    if (removed) await this.books.remove(id)
  }

  async findMerges(ids: string[]): Promise<FindMergesResult> {
    const unique = [...new Set(ids)]
    for (const id of unique) assertBookId(id)

    const warnings: string[] = []
    const entries = await this.library.list()
    const wanted = new Set(unique)
    const selected = new Map<string, LibraryEntry>()
    for (const entry of entries) {
      if (wanted.has(entry.id)) selected.set(entry.id, entry)
    }
    const missing = unique.filter((id) => !selected.has(id))
    if (missing.length > 0) warnings.push(`有 ${missing.length} 本书已不在书架，已跳过`)

    const books: CandidateBook[] = []
    for (const entry of selected.values()) {
      try {
        books.push({ entry, meta: await this.books.readMeta(entry.id) })
      } catch {
        warnings.push(`《${entry.title}》数据缺失，已跳过`)
      }
    }

    const indexed = books.map((book) => ({ ...book, index: indexChapters(book.meta) }))
    const candidates: MergeCandidate[] = []
    let checked = 0
    for (let i = 0; i < indexed.length; i++) {
      for (let j = i + 1; j < indexed.length; j++) {
        const a = indexed[i]
        const b = indexed[j]
        const overlap = chapterMatchRateFromIndexes(a.index, b.index)
        checked += 1
        if (checked % 200 === 0) await new Promise<void>((resolve) => setImmediate(resolve))
        const sameTitle =
          Boolean(a.entry.normalizedTitle) && a.entry.normalizedTitle === b.entry.normalizedTitle
        if (!sameTitle && overlap < 0.05) continue
        const [target, source] = pickDirection(a, b)
        candidates.push({
          targetId: target.entry.id,
          targetTitle: target.entry.title,
          sourceId: source.entry.id,
          sourceTitle: source.entry.title,
          overlap
        })
      }
    }

    candidates.sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.targetId.localeCompare(b.targetId) ||
        a.sourceId.localeCompare(b.sourceId)
    )
    return { candidates, warnings }
  }
}
