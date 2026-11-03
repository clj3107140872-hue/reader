import type { ChapterLevel } from './model'
import { fnv1a, normalizeForHash } from './text'

export interface SplittedChapter {
  title: string
  level: ChapterLevel
  startLine: number
  paragraphs: string[]
}

export interface SplitResult {
  detected: boolean
  chapters: SplittedChapter[]
}

const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
}
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

export function cnNumberToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0
  let current = 0
  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch]
    } else if (ch in UNITS) {
      total += (current === 0 ? 1 : current) * UNITS[ch]
      current = 0
    } else if (ch === '万') {
      total = (total + current) * 10000
      current = 0
    } else {
      return null
    }
  }
  return total + current
}

const VOLUME_RE = /^第[零〇一二两三四五六七八九十百千万0-9]+[卷部集篇]/
const CHAPTER_RE = /^第[零〇一二两三四五六七八九十百千万0-9]+[章节回]/
const SPECIAL_RE = /^(序章|楔子|引子|前言|序言|尾声|终章|大结局|完本感言|后记|番外)/
const BRACKET_RE = /^[【\[（(]\s*第[^】\]）)]{1,24}[章节回][^】\]）)]{0,24}[】\]）)]/
const ENGLISH_RE = /^chapter\s+\d+/i

export function isChapterTitleLine(raw: string): { title: string; level: ChapterLevel } | null {
  const title = raw.trim()
  if (!title || title.length > 40) return null
  if (/[。！？…]$/.test(title)) return null
  if (/https?:\/\/|www\.|最新章节|请记住本站/.test(title)) return null
  if (VOLUME_RE.test(title)) return { title, level: 'volume' }
  if (CHAPTER_RE.test(title) || SPECIAL_RE.test(title) || BRACKET_RE.test(title) || ENGLISH_RE.test(title)) {
    return { title, level: 'chapter' }
  }
  return null
}

export function normalizeTitleForHash(title: string): string {
  const converted = title.replace(
    /第([零〇一二两三四五六七八九十百千万0-9]+)([章节回卷部集篇])/g,
    (match, num: string, unit: string) => {
      const n = cnNumberToInt(num)
      return n === null ? match : `第${n}${unit}`
    }
  )
  return normalizeForHash(converted)
}

export function chapterTitleHash(title: string): string {
  return fnv1a(normalizeTitleForHash(title))
}

export function parseChapterOrdinal(title: string): number | null {
  const match = /第([零〇一二两三四五六七八九十百千万0-9]+)[章节回卷部集篇]/.exec(title)
  if (!match) return null
  return cnNumberToInt(match[1])
}

interface Candidate {
  line: number
  title: string
  level: ChapterLevel
}

function buildFromCandidates(lines: string[], candidates: Candidate[]): SplitResult {
  const chapters: SplittedChapter[] = []
  const first = candidates[0]
  if (first && first.line > 0) {
    const preface = lines.slice(0, first.line).map((l) => l.trim()).filter(Boolean)
    if (preface.length > 0) {
      chapters.push({ title: '前言', level: 'chapter', startLine: 0, paragraphs: preface })
    }
  }
  candidates.forEach((candidate, index) => {
    const end = index + 1 < candidates.length ? candidates[index + 1].line : lines.length
    const paragraphs = lines.slice(candidate.line + 1, end).map((l) => l.trim()).filter(Boolean)
    chapters.push({ title: candidate.title, level: candidate.level, startLine: candidate.line, paragraphs })
  })
  return { detected: true, chapters }
}

export function splitChapters(text: string): SplitResult {
  const lines = text.split(/\r\n|\r|\n/)
  const candidates: Candidate[] = []
  lines.forEach((line, i) => {
    const hit = isChapterTitleLine(line)
    if (hit) candidates.push({ line: i, title: hit.title, level: hit.level })
  })

  if (candidates.length < 3) {
    const paragraphs = lines.map((l) => l.trim()).filter(Boolean)
    return {
      detected: false,
      chapters: [{ title: '正文', level: 'chapter', startLine: 0, paragraphs }]
    }
  }
  return buildFromCandidates(lines, candidates)
}

export function splitAtMarkerLines(text: string, markerLines: number[]): SplitResult {
  const lines = text.split(/\r\n|\r|\n/)
  const unique = [...new Set(markerLines)]
    .filter((line) => line >= 0 && line < lines.length && lines[line].trim() !== '')
    .sort((a, b) => a - b)
  const candidates: Candidate[] = unique.map((line) => {
    const hit = isChapterTitleLine(lines[line])
    return { line, title: lines[line].trim(), level: hit?.level ?? 'chapter' }
  })

  if (candidates.length === 0) return splitChapters(text)
  return buildFromCandidates(lines, candidates)
}
