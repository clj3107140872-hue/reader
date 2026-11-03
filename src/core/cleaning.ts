import type { SplittedChapter } from './chapters'
import type { AdRule, CleanedChapter } from './model'
import { normalizeForHash, stripZeroWidth } from './text'

export const BUILTIN_AD_RULES: AdRule[] = [
  { id: 'url', name: '网址', type: 'line', pattern: 'https?://|www\\.', enabled: true },
  {
    id: 'site',
    name: '站点与章节广告',
    type: 'line',
    pattern: '笔趣阁|顶点小说|书趣阁|天才一秒记住|一秒记住|本章未完',
    enabled: true
  },
  { id: 'contact', name: '引流联系方式', type: 'line', pattern: '公众号|qq群|QQ群|加群|加微信', enabled: true },
  { id: 'mobile', name: '手机阅读提示', type: 'line', pattern: '手机阅读|手机用户请浏览|手机版阅读', enabled: true },
  {
    id: 'sentence',
    name: '短句广告',
    type: 'sentence',
    pattern: '请记住本站|记住本站|记住我们网|最新章节|一秒记住|加入书签|投推荐票',
    enabled: true
  }
]

export interface CleaningRunOptions {
  /** When false, ad rules are skipped; hygiene and duplicate merging still run. */
  adCleaning?: boolean
}

export interface CleaningRunConfig {
  adCleaning: boolean
  rules: AdRule[]
}

export type CleanRemovalKind = 'line' | 'sentence' | 'duplicate'

export interface CleanLineSegment {
  text: string
  removed: boolean
  kind?: CleanRemovalKind
  ruleName?: string
}

export interface CleanLineDetail {
  original: string
  cleaned: string
  segments: CleanLineSegment[]
  removed: CleanRemovalKind | null
}

export interface CleanChapterDetail {
  paragraphs: string[]
  lines: CleanLineDetail[]
  adLinesRemoved: number
  duplicateParagraphsMerged: number
  ruleHits: Record<string, number>
}

export interface CleanChapterStats {
  adLinesRemoved: number
  duplicateParagraphsMerged: number
}

export interface CleanResult {
  chapters: CleanedChapter[]
  adLinesRemoved: number
  duplicateParagraphsMerged: number
  ruleHits: Record<string, number>
  chapterStats: CleanChapterStats[]
}

interface CompiledRule {
  rule: AdRule
  re: RegExp
}

interface CompiledRules {
  line: CompiledRule[]
  sentence: CompiledRule[]
}

interface ChapterRun extends CleanChapterDetail {}

const SENTENCE_SPLIT = /(?<=[。！？!?…])(?![。！？!?…])/

function compileRules(rules: AdRule[]): CompiledRules {
  const line: CompiledRule[] = []
  const sentence: CompiledRule[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      const re = new RegExp(rule.pattern)
      if (rule.type === 'line') line.push({ rule, re })
      else if (rule.type === 'sentence') sentence.push({ rule, re })
    } catch {
      // Malformed user rules are skipped instead of aborting the import.
    }
  }
  return { line, sentence }
}

function bump(hits: Record<string, number>, id: string): void {
  hits[id] = (hits[id] ?? 0) + 1
}

function cleanOneChapter(
  chapter: SplittedChapter,
  compiled: CompiledRules,
  adCleaning: boolean,
  recordLines: boolean
): ChapterRun {
  const paragraphs: string[] = []
  const lines: CleanLineDetail[] = []
  const ruleHits: Record<string, number> = {}
  let previous = ''
  let adLinesRemoved = 0
  let duplicateParagraphsMerged = 0

  for (const raw of chapter.paragraphs) {
    const line = stripZeroWidth(raw).replace(/　/g, ' ').trim()
    if (!line) continue

    if (adCleaning) {
      const lineHit = compiled.line.find(({ re }) => re.test(line))
      if (lineHit) {
        adLinesRemoved++
        bump(ruleHits, lineHit.rule.id)
        if (recordLines) {
          lines.push({
            original: line,
            cleaned: '',
            segments: [
              { text: line, removed: true, kind: 'line', ruleName: lineHit.rule.name }
            ],
            removed: 'line'
          })
        }
        continue
      }
    }

    let text = line
    let sentenceRemoved = false
    let segments: CleanLineSegment[] | null = null

    if (adCleaning && line.length <= 30 && compiled.sentence.length > 0) {
      const sentences = line.split(SENTENCE_SPLIT).filter(Boolean)
      const kept: string[] = []
      const detailSegments: CleanLineSegment[] | null = recordLines ? [] : null

      for (const sentence of sentences) {
        const sentenceHit = compiled.sentence.find(({ re }) => re.test(sentence))
        if (sentenceHit) {
          sentenceRemoved = true
          bump(ruleHits, sentenceHit.rule.id)
          detailSegments?.push({
            text: sentence,
            removed: true,
            kind: 'sentence',
            ruleName: sentenceHit.rule.name
          })
        } else {
          kept.push(sentence)
          detailSegments?.push({ text: sentence, removed: false })
        }
      }

      if (sentenceRemoved) {
        adLinesRemoved++
        text = kept.join('').trim()
        segments = detailSegments
      }
    }

    if (!text) {
      if (recordLines && segments) {
        lines.push({ original: line, cleaned: '', segments, removed: 'sentence' })
      }
      continue
    }

    const normalized = normalizeForHash(text)
    if (normalized && normalized === previous) {
      duplicateParagraphsMerged++
      if (recordLines) {
        lines.push({
          original: line,
          cleaned: '',
          segments: segments ?? [{ text: line, removed: true, kind: 'duplicate' }],
          removed: 'duplicate'
        })
      }
      continue
    }

    previous = normalized
    paragraphs.push(text)
    if (recordLines) {
      lines.push({
        original: line,
        cleaned: text,
        segments: segments ?? [{ text: line, removed: false }],
        removed: sentenceRemoved ? 'sentence' : null
      })
    }
  }

  return { paragraphs, lines, adLinesRemoved, duplicateParagraphsMerged, ruleHits }
}

export function cleanChapters(
  chapters: SplittedChapter[],
  rules: AdRule[],
  options: CleaningRunOptions = {}
): CleanResult {
  const adCleaning = options.adCleaning !== false
  const compiled = adCleaning ? compileRules(rules) : { line: [], sentence: [] }
  const ruleHits: Record<string, number> = {}
  const chapterStats: CleanChapterStats[] = []
  let adLinesRemoved = 0
  let duplicateParagraphsMerged = 0

  const cleaned = chapters.map((chapter) => {
    const run = cleanOneChapter(chapter, compiled, adCleaning, false)
    adLinesRemoved += run.adLinesRemoved
    duplicateParagraphsMerged += run.duplicateParagraphsMerged
    for (const [id, count] of Object.entries(run.ruleHits)) {
      ruleHits[id] = (ruleHits[id] ?? 0) + count
    }
    chapterStats.push({
      adLinesRemoved: run.adLinesRemoved,
      duplicateParagraphsMerged: run.duplicateParagraphsMerged
    })
    return {
      title: chapter.title,
      level: chapter.level,
      startLine: chapter.startLine,
      paragraphs: run.paragraphs
    }
  })

  return {
    chapters: cleaned,
    adLinesRemoved,
    duplicateParagraphsMerged,
    ruleHits,
    chapterStats
  }
}

export function cleanChapterDetailed(
  chapter: SplittedChapter,
  rules: AdRule[],
  options: CleaningRunOptions = {}
): CleanChapterDetail {
  const adCleaning = options.adCleaning !== false
  const compiled = adCleaning ? compileRules(rules) : { line: [], sentence: [] }
  return cleanOneChapter(chapter, compiled, adCleaning, true)
}
