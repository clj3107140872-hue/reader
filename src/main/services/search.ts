import type { SearchHit, SearchProgress, SearchResults } from '../../shared/api'
import { splitParagraphs } from '../../core/paragraphs'
import { chapterFromLines } from '../../core/reprocess'
import type { BookRepository } from '../storage/book'
import type { NetworkBookRepository } from '../storage/networkBook'
import { assertBookId } from '../bookId'

const MAX_HITS = 300

export class SearchService {
  private readonly cancelled = new Set<string>()

  constructor(
    private readonly books: BookRepository,
    private readonly networkBooks?: NetworkBookRepository
  ) {}

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
    const network = meta.format === 'network'
    const cached =
      network && this.networkBooks
        ? new Set(await this.networkBooks.listCachedChapters(id))
        : null
    const searchable = network
      ? meta.chapters.filter(
          (chapter) => chapter.level !== 'volume' && chapter.url && cached?.has(chapter.index)
        )
      : meta.chapters
    const indexes = searchable.map((chapter) => chapter.index)
    const contentCount = network
      ? meta.chapters.filter((chapter) => chapter.level !== 'volume' && chapter.url).length
      : meta.chapters.length
    const skippedUncached = network ? contentCount - indexes.length : 0
    const warnings: string[] = []
    if (network) {
      warnings.push(`仅搜索已缓存章节（${indexes.length}/${contentCount} 章）`)
    }
    const base = { token, warnings, cachedOnly: network, skippedUncached }
    const needle = query.trim().toLowerCase()
    const hits: SearchHit[] = []
    if (!needle) return { ...base, hits, truncated: false, cancelled: false }

    // Loaded only when a chapter file is unusable; null means it is gone too.
    let sourceText: string | null | undefined
    for (let position = 0; position < indexes.length; position++) {
      if (this.cancelled.delete(token)) {
        return { ...base, hits, truncated: false, cancelled: true }
      }
      const index = indexes[position]

      let text: string | null
      try {
        text = await this.books.readChapter(id, index)
      } catch {
        if (network) {
          // 网络书没有 source.txt，缓存文件读失败就跳过这一章。
          warnings.push(`第 ${index + 1} 章《${meta.chapters[index].title}》读取失败，已跳过`)
          text = null
        } else {
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
      }

      if (text !== null) {
        const paragraphs = splitParagraphs(text)

        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
          const paragraph = paragraphs[paragraphIndex]
          const at = paragraph.toLowerCase().indexOf(needle)
          if (at < 0) continue
          // Truncated means a 301st match exists; keep scanning until one is found.
          if (hits.length >= MAX_HITS) {
            return { ...base, hits, truncated: true, cancelled: false }
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

      if ((position + 1) % 10 === 0 || position === indexes.length - 1) {
        onProgress({ token, scanned: position + 1, total: indexes.length })
      }
    }

    return { ...base, hits, truncated: false, cancelled: false }
  }
}
