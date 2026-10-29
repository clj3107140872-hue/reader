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
    pattern: '请记住本站|最新章节|一秒记住|加入书签|投推荐票',
    enabled: true
  }
]

export interface CleanResult {
  chapters: CleanedChapter[]
  adLinesRemoved: number
  duplicateParagraphsMerged: number
}

export function cleanChapters(chapters: SplittedChapter[], rules: AdRule[]): CleanResult {
  const lineRules: RegExp[] = []
  const sentenceRules: RegExp[] = []
  for (const rule of rules) {
    if (!rule.enabled) continue
    try {
      const compiled = new RegExp(rule.pattern)
      if (rule.type === 'line') lineRules.push(compiled)
      else if (rule.type === 'sentence') sentenceRules.push(compiled)
    } catch {
      // Malformed user rules are skipped instead of aborting the import.
    }
  }

  let adLinesRemoved = 0
  let duplicateParagraphsMerged = 0

  const cleaned = chapters.map((chapter): CleanedChapter => {
    const paragraphs: string[] = []
    let previous = ''

    for (const raw of chapter.paragraphs) {
      const line = stripZeroWidth(raw).replace(/\u3000/g, ' ').trim()
      if (!line) continue

      if (lineRules.some((re) => re.test(line))) {
        adLinesRemoved++
        continue
      }

      let text = line
      if (line.length <= 30) {
        const sentences = line.split(/(?<=[。！？!?…])(?![。！？!?…])/)
        const kept = sentences.filter((sentence) => !sentenceRules.some((re) => re.test(sentence)))
        if (kept.length !== sentences.length) {
          adLinesRemoved++
          text = kept.join('').trim()
        }
      }
      if (!text) continue

      const normalized = normalizeForHash(text)
      if (normalized && normalized === previous) {
        duplicateParagraphsMerged++
        continue
      }
      previous = normalized
      paragraphs.push(text)
    }

    return {
      title: chapter.title,
      level: chapter.level,
      startLine: chapter.startLine,
      paragraphs
    }
  })

  return { chapters: cleaned, adLinesRemoved, duplicateParagraphsMerged }
}
