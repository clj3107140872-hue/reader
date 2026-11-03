import { describe, expect, it } from 'vitest'
import { BUILTIN_AD_RULES, cleanChapterDetailed, cleanChapters } from '../src/core/cleaning'
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

  it('keeps ad lines when ad cleaning is disabled but still merges duplicates', () => {
    const result = cleanChapters(
      [chapter(['正文。', '正文。', 'www.example-novel.com'])],
      BUILTIN_AD_RULES,
      { adCleaning: false }
    )
    expect(result.chapters[0].paragraphs).toEqual(['正文。', 'www.example-novel.com'])
    expect(result.adLinesRemoved).toBe(0)
    expect(result.duplicateParagraphsMerged).toBe(1)
  })

  it('counts hits per rule and per chapter', () => {
    const rules = [
      { id: 'ad-line', name: '广告行', type: 'line' as const, pattern: '广告', enabled: true }
    ]
    const result = cleanChapters(
      [chapter(['广告一', '正文。', '广告二']), chapter(['正文。'])],
      rules
    )
    expect(result.ruleHits).toEqual({ 'ad-line': 2 })
    expect(result.chapterStats).toEqual([
      { adLinesRemoved: 2, duplicateParagraphsMerged: 0 },
      { adLinesRemoved: 0, duplicateParagraphsMerged: 0 }
    ])
  })

  it('reports a line-level removal in the chapter diff', () => {
    const detail = cleanChapterDetailed(
      chapter(['正文。', 'www.example-novel.com']),
      BUILTIN_AD_RULES
    )
    expect(detail.lines).toHaveLength(2)
    expect(detail.lines[1]).toMatchObject({
      original: 'www.example-novel.com',
      cleaned: '',
      removed: 'line'
    })
    expect(detail.lines[1].segments).toEqual([
      expect.objectContaining({ text: 'www.example-novel.com', removed: true, kind: 'line' })
    ])
  })

  it('marks only the removed sentence in the chapter diff', () => {
    const detail = cleanChapterDetailed(chapter(['请记住本站。正文很短。']), BUILTIN_AD_RULES)
    expect(detail.paragraphs).toEqual(['正文很短。'])
    expect(detail.lines[0].removed).toBe('sentence')
    expect(detail.lines[0].cleaned).toBe('正文很短。')
    expect(detail.lines[0].segments).toEqual([
      expect.objectContaining({ text: '请记住本站。', removed: true, kind: 'sentence' }),
      expect.objectContaining({ text: '正文很短。', removed: false })
    ])
    expect(detail.ruleHits.sentence).toBe(1)
  })

  it('marks a duplicate paragraph in the chapter diff', () => {
    const detail = cleanChapterDetailed(chapter(['重复段。', '重复段。']), BUILTIN_AD_RULES)
    expect(detail.lines[1]).toMatchObject({
      original: '重复段。',
      cleaned: '',
      removed: 'duplicate'
    })
    expect(detail.lines[1].segments[0]).toMatchObject({ removed: true, kind: 'duplicate' })
  })
})
