import type { BookMeta } from '../../../core/model'

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

export function resolveChapterIndex(meta: BookMeta, chapterKey: string, fallback: number): number {
  const found = meta.chapters.findIndex((chapter) => chapter.titleHash === chapterKey)
  const index = found >= 0 ? found : fallback
  if (meta.chapters.length === 0) return 0
  return Math.min(Math.max(index, 0), meta.chapters.length - 1)
}
