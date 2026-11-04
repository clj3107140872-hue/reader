import { isChapterTitleLine } from './chapters'
import type { BookFormat, BookMeta, CleanedChapter } from './model'
import { buildChapterMetas } from './pipeline'

export interface BookDocumentsInput {
  id: string
  title: string
  encoding: string
  createdAt: string
  chapters: CleanedChapter[]
  /** Keep an existing source file; otherwise rebuild it from the chapters. */
  sourceText?: string
  /** Manual chapter markers to persist; omit for auto-split books. */
  chapterStarts?: number[]
  format?: BookFormat
  author?: string
  cover?: { mime: string }
}

export interface BookDocuments {
  meta: BookMeta
  sourceText: string
  chapters: CleanedChapter[]
}

export function buildBookDocuments(input: BookDocumentsInput): BookDocuments {
  const chapters =
    input.sourceText === undefined
      ? assignLines(input.chapters)
      : input.chapters

  return {
    meta: {
      version: 1,
      id: input.id,
      title: input.title,
      encoding: input.encoding,
      chapters: buildChapterMetas(chapters),
      ...(input.format ? { format: input.format } : {}),
      ...(input.author ? { author: input.author } : {}),
      ...(input.cover ? { cover: input.cover } : {}),
      ...(input.chapterStarts ? { chapterStarts: input.chapterStarts } : {}),
      createdAt: input.createdAt
    },
    sourceText: input.sourceText ?? serializeChapters(chapters),
    chapters
  }
}

/** Synthetic titles like 正文 were never a line in the original source. */
export function hasTitleLine(chapter: CleanedChapter): boolean {
  return isChapterTitleLine(chapter.title) !== null
}

function assignLines(chapters: CleanedChapter[]): CleanedChapter[] {
  let line = 0
  return chapters.map((chapter) => {
    const startLine = line
    if (hasTitleLine(chapter)) line += 1
    for (const paragraph of chapter.paragraphs) {
      line += 2
    }
    return { ...chapter, startLine }
  })
}

function serializeChapters(chapters: CleanedChapter[]): string {
  const lines: string[] = []
  for (const chapter of chapters) {
    if (hasTitleLine(chapter)) lines.push(chapter.title)
    for (const paragraph of chapter.paragraphs) {
      lines.push(paragraph, '')
    }
  }
  return lines.join('\n')
}
