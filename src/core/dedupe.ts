import type { CleanedChapter } from './model'
import { hammingBig, normalizeForHash, toBig } from './text'

export interface DedupeItem {
  titleHash: string
  simhash: string
  charCount: number
}

export function markDuplicateChapters(items: DedupeItem[]): boolean[] {
  const flags = new Array<boolean>(items.length).fill(false)
  const sims = items.map((item) => toBig(item.simhash))

  const byTitle = new Map<string, number[]>()
  items.forEach((item, index) => {
    const list = byTitle.get(item.titleHash) ?? []
    list.push(index)
    byTitle.set(item.titleHash, list)
  })

  for (const list of byTitle.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a]
        const j = list[b]
        if (flags[j]) continue
        const ratio = items[i].charCount / Math.max(1, items[j].charCount)
        if (ratio < 0.8 || ratio > 1.25) continue
        if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (flags[j]) continue
      const ratio = items[i].charCount / Math.max(1, items[j].charCount)
      if (ratio < 0.8 || ratio > 1.25) continue
      if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
    }
  }

  return flags
}

export interface ParagraphDedupeResult {
  chapters: CleanedChapter[]
  removed: number
}

/**
 * Removes cross-chapter duplicates of paragraphs longer than 50 characters,
 * keeping the first copy. Only used when merging two volumes.
 */
export function dedupeCrossChapterParagraphs(chapters: CleanedChapter[]): ParagraphDedupeResult {
  const seen = new Set<string>()
  let removed = 0
  const deduped = chapters.map((chapter) => ({
    ...chapter,
    paragraphs: chapter.paragraphs.filter((paragraph) => {
      if (paragraph.length <= 50) return true
      const key = normalizeForHash(paragraph)
      if (!key) return true
      if (seen.has(key)) {
        removed += 1
        return false
      }
      seen.add(key)
      return true
    })
  }))
  return { chapters: deduped, removed }
}
