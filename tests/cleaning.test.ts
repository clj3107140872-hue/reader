import { describe, expect, it } from 'vitest'
import { BUILTIN_AD_RULES, cleanChapters } from '../src/core/cleaning'
import type { SplittedChapter } from '../src/core/chapters'

function chapter(paragraphs: string[]): SplittedChapter {
  return { title: '第一章', level: 'chapter', startLine: 0, paragraphs }
}

describe('cleanChapters', () => {
  it('removes built-in ad lines but keeps story paragraphs', () => {
    const result = cleanChapters(
      [chapter(['萧炎推门而入。', 'www.example-novel.com', '请记住本站笔趣阁', '他看到了药老。'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['萧炎推门而入。', '他看到了药老。'])
    expect(result.adLinesRemoved).toBe(2)
  })

  it('merges consecutive duplicate paragraphs', () => {
    const result = cleanChapters(
      [chapter(['第一段内容。', '第一段内容。', '第二段内容。'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['第一段内容。', '第二段内容。'])
    expect(result.duplicateParagraphsMerged).toBe(1)
  })

  it('removes ad sentences inside short paragraphs only', () => {
    const short = cleanChapters([chapter(['请记住本站。正文很短。'])], BUILTIN_AD_RULES)
    expect(short.chapters[0].paragraphs).toEqual(['正文很短。'])

    const long = '这是一段足够长的正文内容，用来验证短句广告规则不会误伤超过三十字的段落，请记住本站。'
    const kept = cleanChapters([chapter([long])], BUILTIN_AD_RULES)
    expect(kept.chapters[0].paragraphs).toEqual([long])
  })

  it('applies user rules', () => {
    const rules = [
      ...BUILTIN_AD_RULES,
      { id: 'user-1', name: '求收藏', type: 'line' as const, pattern: '求收藏', enabled: true }
    ]
    const result = cleanChapters([chapter(['正文。', '求收藏求推荐票'])], rules)
    expect(result.chapters[0].paragraphs).toEqual(['正文。'])
  })

  it('drops empty chapters content but keeps chapter records', () => {
    const result = cleanChapters([chapter(['www.biquge.com', ''])], BUILTIN_AD_RULES)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].paragraphs).toEqual([])
  })

  it('skips rules whose pattern is invalid instead of failing', () => {
    const rules = [
      ...BUILTIN_AD_RULES,
      { id: 'bad', name: '坏规则', type: 'line' as const, pattern: '求收藏(', enabled: true }
    ]
    const result = cleanChapters([chapter(['正文。', 'www.example.com'])], rules)
    expect(result.chapters[0].paragraphs).toEqual(['正文。'])
  })

  it('removes ad sentences separated by ellipses too', () => {
    const result = cleanChapters([chapter(['请记住本站……正文很短。'])], BUILTIN_AD_RULES)
    expect(result.chapters[0].paragraphs).toEqual(['正文很短。'])
  })

  it('merges only consecutive duplicates', () => {
    const result = cleanChapters([chapter(['甲段。', '乙段。', '甲段。'])], BUILTIN_AD_RULES)
    expect(result.chapters[0].paragraphs).toEqual(['甲段。', '乙段。', '甲段。'])
  })

  it('removes the site reminder fragment found in real books', () => {
    const result = cleanChapters(
      [chapter(['正文结束。记住我们网'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['正文结束。'])
    expect(result.adLinesRemoved).toBe(1)
  })
})
