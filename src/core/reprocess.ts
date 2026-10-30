import { isChapterTitleLine } from './chapters'
import type { BookMeta, CleanedChapter } from './model'

/** Rebuilds chapter paragraphs from a stored source using saved start lines. */
export function chaptersFromLines(sourceText: string, meta: BookMeta): CleanedChapter[] {
  const lines = sourceText.split(/\r\n|\r|\n/)
  return meta.chapters.map((chapter, index) => {
    const start = Math.min(Math.max(chapter.startLine, 0), lines.length)
    const nextStart =
      index + 1 < meta.chapters.length ? meta.chapters[index + 1].startLine : lines.length
    const end = Math.min(Math.max(nextStart, start), lines.length)
    // Synthetic chapters (前言 / 正文) start at their first content line; only
    // skip the line at startLine when it really is this chapter's title.
    const startsAtTitle =
      lines[start] !== undefined &&
      lines[start].trim() === chapter.title &&
      isChapterTitleLine(lines[start]) !== null
    const paragraphs = lines
      .slice(startsAtTitle ? start + 1 : start, end)
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
