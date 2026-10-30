import type { BookMeta, CleanedChapter } from './model'

/** Rebuilds chapter paragraphs from a stored source using saved start lines. */
export function chaptersFromLines(sourceText: string, meta: BookMeta): CleanedChapter[] {
  const lines = sourceText.split(/\r\n|\r|\n/)
  return meta.chapters.map((chapter, index) => {
    const start = Math.min(Math.max(chapter.startLine, 0), lines.length)
    const nextStart =
      index + 1 < meta.chapters.length ? meta.chapters[index + 1].startLine : lines.length
    const end = Math.min(Math.max(nextStart, start), lines.length)
    const paragraphs = lines
      .slice(start + 1, end)
      .map((line) => line.trim())
      .filter(Boolean)
    return {
      title: chapter.title,
      level: chapter.level,
      startLine: start,
      paragraphs
    }
  })
}
