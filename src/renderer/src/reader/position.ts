import type { BookMeta } from '../../../core/model'
import { resolveChapterIndex as resolveCoreChapterIndex } from '../../../core/position'

export function chapterCharStarts(meta: BookMeta): number[] {
  const starts: number[] = []
  let total = 0
  for (const chapter of meta.chapters) {
    starts.push(total)
    total += chapter.charCount
  }
  return starts
}

export function totalChars(meta: BookMeta): number {
  return meta.chapters.reduce((sum, chapter) => sum + chapter.charCount, 0)
}

export function charsBefore(
  meta: BookMeta,
  chapterIndex: number,
  paragraphIndex: number,
  paragraphs: string[][]
): number {
  const start = chapterCharStarts(meta)[chapterIndex] ?? 0
  const within = (paragraphs[chapterIndex] ?? [])
    .slice(0, paragraphIndex)
    .reduce((sum, text) => sum + text.length, 0)
  return start + within
}

export function percentAt(
  meta: BookMeta,
  chapterIndex: number,
  paragraphIndex: number,
  paragraphs: string[][]
): number {
  const total = totalChars(meta)
  if (total <= 0) return 0
  const percent = (charsBefore(meta, chapterIndex, paragraphIndex, paragraphs) / total) * 100
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100))
}

export function chapterIndexForPercent(meta: BookMeta, percent: number): number {
  const total = totalChars(meta)
  if (total <= 0) return 0
  const target = (Math.min(100, Math.max(0, percent)) / 100) * total
  const starts = chapterCharStarts(meta)
  let index = 0
  while (index + 1 < starts.length && starts[index + 1] <= target) index++
  return index
}

/** Index of the last top at or above `y`; 0 when none (or empty). */
export function nearestIndexByTop(tops: number[], y: number): number {
  let index = 0
  for (let i = 0; i < tops.length; i++) {
    if (tops[i] <= y) index = i
  }
  return index
}

/**
 * Resolve a percent to a chapter and paragraph. The flow position of a percent
 * is the paragraph whose character span contains the within-chapter offset.
 */
export function positionForPercent(
  meta: BookMeta,
  percent: number,
  paragraphs: string[][]
): { chapterIndex: number; paragraphIndex: number } {
  const total = totalChars(meta)
  if (total <= 0) return { chapterIndex: 0, paragraphIndex: 0 }
  const clamped = Math.min(100, Math.max(0, percent))
  const chapterIndex = chapterIndexForPercent(meta, clamped)
  const chapter = meta.chapters[chapterIndex]
  const starts = chapterCharStarts(meta)
  const target = (clamped / 100) * total
  const offset = Math.max(0, Math.min(chapter.charCount, target - starts[chapterIndex]))
  const chapterParagraphs = paragraphs[chapterIndex] ?? []
  if (chapterParagraphs.length === 0) return { chapterIndex, paragraphIndex: 0 }

  let cumulative = 0
  for (let i = 0; i < chapterParagraphs.length; i++) {
    cumulative += chapterParagraphs[i].length
    if (offset < cumulative) return { chapterIndex, paragraphIndex: i }
  }
  return { chapterIndex, paragraphIndex: chapterParagraphs.length - 1 }
}

export function resolveChapterIndex(meta: BookMeta, chapterKey: string, fallback: number): number {
  return resolveCoreChapterIndex(meta.chapters, chapterKey, fallback)
}
