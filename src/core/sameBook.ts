import { parseChapterOrdinal } from './chapters'
import type { BookMeta, CleanedChapter } from './model'
import { hammingBig, toBig } from './text'

export interface MergeSource {
  meta: BookMeta
  chapters: CleanedChapter[]
}

const NOISE_PATTERNS: RegExp[] = [
  /\d+\s*[-~—至]\s*\d+\s*章?/g,
  /https?:\/\/\S+/gi,
  /www\.[a-z0-9.-]+/gi,
  /《|》/g,
  /[\[【（(][^\]】）)]*[\]】）)]/g,
  /(全本|完结|精校版|无错版|全集|txt|下载|小说|电子书|最新章节)/gi,
  /(笔趣阁|顶点小说|书趣阁)/g
]

export function normalizeBookTitle(fileName: string): string {
  let title = fileName.replace(/\.txt$/i, '')
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, '')
  return title.replace(/[\s_\-—]+/g, '').toLowerCase()
}

export function chapterMatchRate(base: BookMeta, other: BookMeta): number {
  const small = base.chapters.length <= other.chapters.length ? base.chapters : other.chapters
  const large = base.chapters.length <= other.chapters.length ? other.chapters : base.chapters
  if (small.length === 0) return 0

  const index = new Map<string, bigint[]>()
  for (const chapter of large) {
    const list = index.get(chapter.titleHash) ?? []
    list.push(toBig(chapter.simhash))
    index.set(chapter.titleHash, list)
  }

  let matched = 0
  for (const chapter of small) {
    const candidates = index.get(chapter.titleHash)
    if (!candidates) continue
    const fingerprint = toBig(chapter.simhash)
    if (candidates.some((candidate) => hammingBig(candidate, fingerprint) <= 3)) matched++
  }
  return matched / small.length
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

  const ordinals = chapters.map((chapter) => parseChapterOrdinal(chapter.title))
  if (ordinals.every((ordinal) => ordinal !== null)) {
    const order = chapters
      .map((_, index) => index)
      .sort((a, b) => ordinals[a]! - ordinals[b]! || a - b)
    return order.map((index) => chapters[index])
  }
  return chapters
}
