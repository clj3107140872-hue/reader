import type { SearchHit, SearchProgress, SearchResults } from '../../shared/api'
import { splitParagraphs } from '../../core/paragraphs'
import type { BookRepository } from '../storage/book'
import { assertBookId } from '../bookId'

const MAX_HITS = 300

export class SearchService {
  private readonly cancelled = new Set<string>()

  constructor(private readonly books: BookRepository) {}

  cancel(token: string): void {
    this.cancelled.add(token)
  }

  async search(
    id: string,
    query: string,
    token: string,
    onProgress: (payload: SearchProgress) => void
  ): Promise<SearchResults> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const needle = query.trim().toLowerCase()
    const hits: SearchHit[] = []
    if (!needle) return { token, hits, truncated: false, cancelled: false }

    for (let index = 0; index < meta.chapters.length; index++) {
      if (this.cancelled.delete(token)) {
        return { token, hits, truncated: false, cancelled: true }
      }

      const text = await this.books.readChapter(id, index)
      const paragraphs = splitParagraphs(text)

      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const paragraph = paragraphs[paragraphIndex]
        const at = paragraph.toLowerCase().indexOf(needle)
        if (at < 0) continue
        // Truncated means a 301st match exists; keep scanning until one is found.
        if (hits.length >= MAX_HITS) {
          return { token, hits, truncated: true, cancelled: false }
        }

        const start = Math.max(0, at - 20)
        const end = Math.min(paragraph.length, at + needle.length + 40)
        hits.push({
          chapterIndex: index,
          chapterKey: meta.chapters[index].titleHash,
          paragraphIndex,
          excerpt: `${start > 0 ? '…' : ''}${paragraph.slice(start, end)}${end < paragraph.length ? '…' : ''}`
        })
      }

      if ((index + 1) % 10 === 0 || index === meta.chapters.length - 1) {
        onProgress({ token, scanned: index + 1, total: meta.chapters.length })
      }
    }

    return { token, hits, truncated: false, cancelled: false }
  }
}
