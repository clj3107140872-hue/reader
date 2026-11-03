import type { SearchHit, SearchProgress, SearchResults } from '../../shared/api'
import { splitParagraphs } from '../../core/paragraphs'
import { chapterFromLines } from '../../core/reprocess'
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
    const warnings: string[] = []
    if (!needle) return { token, hits, warnings, truncated: false, cancelled: false }

    // Loaded only when a chapter file is unusable; null means it is gone too.
    let sourceText: string | null | undefined
    for (let index = 0; index < meta.chapters.length; index++) {
      if (this.cancelled.delete(token)) {
        return { token, hits, warnings, truncated: false, cancelled: true }
      }

      let text: string | null
      try {
        text = await this.books.readChapter(id, index)
      } catch {
        // Rebuild below from the pre-cleaning source that every book keeps.
        if (sourceText === undefined) {
          sourceText = await this.books.readSource(id).catch(() => null)
        }
        const title = meta.chapters[index].title
        const rebuilt =
          sourceText === null
            ? ''
            : chapterFromLines(sourceText, meta, index).paragraphs.join('\n\n').trim()
        if (rebuilt === '') {
          warnings.push(`第 ${index + 1} 章《${title}》文件缺失且无法从原文重建，已跳过`)
          text = null
        } else {
          warnings.push(`第 ${index + 1} 章《${title}》文件缺失，已从原文重建`)
          text = rebuilt
        }
      }

      if (text !== null) {
        const paragraphs = splitParagraphs(text)

        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
          const paragraph = paragraphs[paragraphIndex]
          const at = paragraph.toLowerCase().indexOf(needle)
          if (at < 0) continue
          // Truncated means a 301st match exists; keep scanning until one is found.
          if (hits.length >= MAX_HITS) {
            return { token, hits, warnings, truncated: true, cancelled: false }
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
      }

      if ((index + 1) % 10 === 0 || index === meta.chapters.length - 1) {
        onProgress({ token, scanned: index + 1, total: meta.chapters.length })
      }
    }

    return { token, hits, warnings, truncated: false, cancelled: false }
  }
}
