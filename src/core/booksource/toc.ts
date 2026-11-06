import type { ChapterMeta } from '../model'
import { chapterTitleHash } from '../chapters'
import type { TocChapter } from './model'

export interface TocDiffResult {
  chapters: ChapterMeta[]
  added: number
  updated: number
  lastChapter?: string
}

export function diffToc(existing: ChapterMeta[], incoming: TocChapter[]): TocDiffResult {
  const chapters = existing.map((chapter) => ({ ...chapter }))
  const used = new Set<number>()
  let added = 0
  let updated = 0

  for (const entry of incoming) {
    let index = entry.url
      ? chapters.findIndex((chapter, i) => !used.has(i) && chapter.url === entry.url)
      : -1
    if (index < 0) {
      const hash = chapterTitleHash(entry.title)
      index = chapters.findIndex((chapter, i) => !used.has(i) && chapter.titleHash === hash)
    }
    if (index >= 0) {
      used.add(index)
      const chapter = chapters[index]
      const nextHash = chapterTitleHash(entry.title)
      if (chapter.title !== entry.title || chapter.url !== entry.url) updated++
      chapter.title = entry.title
      chapter.url = entry.url || chapter.url
      chapter.level = entry.level
      chapter.titleHash = nextHash
      continue
    }
    const chapter: ChapterMeta = {
      index: chapters.length,
      title: entry.title,
      level: entry.level,
      titleHash: chapterTitleHash(entry.title),
      startLine: 0,
      charCount: 0,
      simhash: '',
      flags: {},
      ...(entry.url ? { url: entry.url } : {})
    }
    chapters.push(chapter)
    used.add(chapter.index)
    added++
  }

  const last = [...incoming].reverse().find((entry) => entry.level !== 'volume')
  return {
    chapters,
    added,
    updated,
    ...(last ? { lastChapter: last.title } : {})
  }
}
