import { chapterTitleHash } from './chapters'
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

export interface ChapterDedupeResult {
  chapters: CleanedChapter[]
  removed: number
}

const CONTAINMENT_THRESHOLD = 0.75
/** Below this many characters a 4-gram overlap is too noisy to judge by. */
const MIN_COMPARE_LENGTH = 100
/** Bodies this short are site placeholders, not chapter text. */
const PLACEHOLDER_LENGTH = 10

function bodyGramHits(smaller: string, larger: Set<string>): number {
  let grams = 0
  let hits = 0
  for (let i = 0; i + 4 <= smaller.length; i++) {
    grams++
    if (larger.has(smaller.slice(i, i + 4))) hits++
  }
  return grams === 0 ? 0 : hits / grams
}

/**
 * Drops chapters whose body is largely contained in a longer chapter with
 * the same title. Merging overlapping source files leaves two copies of a
 * chapter — usually a full one and a truncated or abridged one — and both
 * would otherwise appear in the table of contents. Only same-title chapters
 * are compared so unrelated chapters are never merged.
 */
export function removeDuplicateChapters(chapters: CleanedChapter[]): ChapterDedupeResult {
  const bodies = new Map<number, string>()
  const groups = new Map<string, number[]>()
  chapters.forEach((chapter, index) => {
    if (chapter.level !== 'chapter') return
    bodies.set(index, normalizeForHash(chapter.paragraphs.join('\n')))
    const key = chapterTitleHash(chapter.title)
    const list = groups.get(key) ?? []
    list.push(index)
    groups.set(key, list)
  })

  const remove = new Set<number>()
  for (const list of groups.values()) {
    if (list.length < 2) continue
    let keep = list[0]
    for (const index of list) {
      if ((bodies.get(index)?.length ?? 0) > (bodies.get(keep)?.length ?? 0)) keep = index
    }
    const keepBody = bodies.get(keep) ?? ''
    const keepGrams = new Set<string>()
    for (let i = 0; i + 4 <= keepBody.length; i++) keepGrams.add(keepBody.slice(i, i + 4))

    for (const index of list) {
      if (index === keep) continue
      const body = bodies.get(index) ?? ''
      if (body.length < PLACEHOLDER_LENGTH) {
        remove.add(index)
        continue
      }
      if (body.length < MIN_COMPARE_LENGTH) {
        if (body === keepBody) remove.add(index)
        continue
      }
      if (bodyGramHits(body, keepGrams) >= CONTAINMENT_THRESHOLD) remove.add(index)
    }
  }

  if (remove.size === 0) return { chapters, removed: 0 }
  return {
    chapters: chapters.filter((_chapter, index) => !remove.has(index)),
    removed: remove.size
  }
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
