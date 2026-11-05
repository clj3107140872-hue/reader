import { parseChapterOrdinal } from './chapters'
import { removeDuplicateChapters } from './dedupe'
import type { BookMeta, CleanedChapter } from './model'
import { hammingBig, toBig, toHalfWidth } from './text'

export interface MergeSource {
  meta: BookMeta
  chapters: CleanedChapter[]
}

const NOISE_PATTERNS: RegExp[] = [
  /第?\s*\d+\s*[-~—至]\s*\d+\s*章?/g,
  /https?:\/\/\S+/gi,
  /www\.[a-z0-9.-]+/gi,
  /《|》/g,
  /[\[【（(][^\]】）)]*[\]】）)]/g,
  /(全本|完结|精校版|无错版|全集|txt|下载|小说|电子书|最新章节)/gi,
  /(笔趣阁|顶点小说|书趣阁)/g
]

const FRONT_MATTER = /^(前言|序言|序章|楔子|引子)/

function sortMergedChapters(chapters: CleanedChapter[]): CleanedChapter[] {
  let volumeOrdinal = -1
  let volumeIndex = -1
  const keyed = chapters.map((chapter, index) => {
    const ordinal = parseChapterOrdinal(chapter.title)
    if (chapter.level === 'volume' && ordinal !== null) {
      volumeOrdinal = ordinal
      volumeIndex = index
      return { chapter, index, group: 1, volumeOrdinal: ordinal, volumeIndex: index, kind: 0, ordinal }
    }
    if (chapter.level === 'chapter' && ordinal !== null) {
      return { chapter, index, group: 1, volumeOrdinal, volumeIndex, kind: 1, ordinal }
    }
    if (FRONT_MATTER.test(chapter.title)) {
      return { chapter, index, group: 0, volumeOrdinal: 0, volumeIndex: 0, kind: 0, ordinal: 0 }
    }
    return { chapter, index, group: 1, volumeOrdinal, volumeIndex, kind: 2, ordinal: 0 }
  })
  keyed.sort(
    (a, b) =>
      a.group - b.group ||
      a.volumeOrdinal - b.volumeOrdinal ||
      a.volumeIndex - b.volumeIndex ||
      a.kind - b.kind ||
      a.ordinal - b.ordinal ||
      a.index - b.index
  )
  return keyed.map((entry) => entry.chapter)
}

export function normalizeBookTitle(fileName: string): string {
  let title = toHalfWidth(fileName.replace(/\.txt$/i, ''))
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, '')
  return title.replace(/[\s_\-—]+/g, '').toLowerCase()
}

/** Strips volume ranges and quality noise for display, keeping case and spaces. */
export function displayBookTitle(fileName: string): string {
  let title = toHalfWidth(fileName.replace(/\.txt$/i, ''))
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, '')
  return (
    title
      .replace(/[\s_\-—]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || fileName.replace(/\.txt$/i, '')
  )
}

export interface ChapterIndex {
  count: number
  byTitle: Map<string, bigint[]>
}

export function indexChapters(meta: BookMeta): ChapterIndex {
  const eligible = meta.chapters.filter(
    (chapter) => chapter.level !== 'volume' && chapter.charCount > 0
  )
  const byTitle = new Map<string, bigint[]>()
  for (const chapter of eligible) {
    const list = byTitle.get(chapter.titleHash) ?? []
    list.push(toBig(chapter.simhash))
    byTitle.set(chapter.titleHash, list)
  }
  return { count: eligible.length, byTitle }
}

export function chapterMatchRateFromIndexes(a: ChapterIndex, b: ChapterIndex): number {
  const [small, large] = a.count <= b.count ? [a, b] : [b, a]
  if (small.count === 0) return 0
  let matched = 0
  for (const [titleHash, fingerprints] of small.byTitle) {
    const candidates = large.byTitle.get(titleHash)
    if (!candidates) continue
    for (const fingerprint of fingerprints) {
      if (candidates.some((candidate) => hammingBig(candidate, fingerprint) <= 3)) matched++
    }
  }
  return matched / small.count
}

export function chapterMatchRate(base: BookMeta, other: BookMeta): number {
  return chapterMatchRateFromIndexes(indexChapters(base), indexChapters(other))
}

export function shouldSuspectSameBook(
  incomingNormalizedTitle: string,
  incomingMeta: BookMeta,
  existingNormalizedTitle: string,
  existingMeta: BookMeta
): boolean {
  if (incomingNormalizedTitle && incomingNormalizedTitle === existingNormalizedTitle) return true
  return chapterMatchRate(incomingMeta, existingMeta) >= 0.05
}

export function planMerge(base: MergeSource, incoming: MergeSource): CleanedChapter[] {
  const chapters = [...base.chapters]
  const sims = base.meta.chapters.map((chapter) => toBig(chapter.simhash))
  const titleIndex = new Map<string, number[]>()
  base.meta.chapters.forEach((chapter, index) => {
    const list = titleIndex.get(chapter.titleHash) ?? []
    list.push(index)
    titleIndex.set(chapter.titleHash, list)
  })

  for (let j = 0; j < incoming.chapters.length; j++) {
    const chapter = incoming.chapters[j]
    const meta = incoming.meta.chapters[j]
    const sameTitle = titleIndex.get(meta.titleHash) ?? []
    const fingerprint = toBig(meta.simhash)

    let matched = false
    for (const index of sameTitle) {
      if (hammingBig(sims[index], fingerprint) <= 3) {
        matched = true
        const existingLength = chapters[index].paragraphs.join('').length
        if (meta.charCount > existingLength) {
          chapters[index] = chapter
          sims[index] = fingerprint
        }
        break
      }
    }

    if (!matched) {
      titleIndex.set(meta.titleHash, [...(titleIndex.get(meta.titleHash) ?? []), chapters.length])
      chapters.push(chapter)
      sims.push(fingerprint)
    }
  }

  // Overlapping source volumes often repeat a chapter under the same title
  // with one copy shortened; keep the fuller copy so the TOC stays clean.
  return sortMergedChapters(removeDuplicateChapters(chapters).chapters)
}
