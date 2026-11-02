import type { ChapterMeta } from './model'

/**
 * Resolve a saved chapter key to an index. When the title hash occurs more
 * than once, prefer the occurrence nearest the remembered index.
 */
export function resolveChapterIndex(
  chapters: ChapterMeta[],
  chapterKey: string,
  fallback: number
): number {
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
