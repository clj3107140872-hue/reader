import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { parseBookFile } from '../src/core/pipeline'

function makeBookText(count: number): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(
      `第${i}章 风起云涌`,
      `这是第${i}章的正文内容，用来测试导入流程是否稳定。`,
      'www.example-ad.com',
      `第${i}章的更多正文，故事继续向前推进。`,
      ''
    )
  }
  return lines.join('\n')
}

describe('parseBookFile', () => {
  it('parses a 200-chapter GBK book end to end', () => {
    const buf = iconv.encode(makeBookText(200), 'gbk')
    const result = parseBookFile(buf, '斗罗大陆_1-200章.txt')

    expect(result.encoding).toBe('gb18030')
    expect(result.title).toBe('斗罗大陆_1-200章')
    expect(result.chapters).toHaveLength(200)
    expect(result.meta.chapters).toHaveLength(200)
    expect(result.stats.adLinesRemoved).toBe(200)
    expect(result.chapters[0].paragraphs).toEqual([
      '这是第1章的正文内容，用来测试导入流程是否稳定。',
      '第1章的更多正文，故事继续向前推进。'
    ])
  })

  it('keeps source text for later re-cleaning', () => {
    const buf = iconv.encode(makeBookText(3), 'utf8')
    const result = parseBookFile(buf, '测试小说.txt')
    expect(result.sourceText).toContain('www.example-ad.com')
    expect(result.chapters[0].paragraphs.join('')).not.toContain('www.example-ad.com')
  })

  it('rejects a whitespace-only file', () => {
    expect(() => parseBookFile(Buffer.from('   \n\n  \n'), '空白.txt')).toThrow('文件没有可阅读的正文')
  })

  it('assigns stable title hashes and fingerprints', () => {
    const buf = iconv.encode(makeBookText(3), 'utf8')
    const result = parseBookFile(buf, '测试小说.txt')
    expect(result.meta.chapters[0].titleHash).toHaveLength(8)
    expect(result.meta.chapters[0].simhash).toMatch(/^[0-9a-f]{16}$/)
    expect(result.meta.chapters[0].charCount).toBeGreaterThan(0)
  })

  it('skips ad rules when cleaning is disabled', () => {
    const buf = iconv.encode(makeBookText(3), 'utf8')
    const result = parseBookFile(buf, '测试小说.txt', { adCleaning: false })
    expect(result.stats.adLinesRemoved).toBe(0)
    expect(result.chapters[0].paragraphs).toContain('www.example-ad.com')
  })

  it('uses supplied ad rules instead of adding built-ins', () => {
    const text = makeBookText(3).replace(
      '这是第1章的正文内容，用来测试导入流程是否稳定。',
      '这是第1章的正文内容，广告字。'
    )
    const result = parseBookFile(iconv.encode(text, 'utf8'), '测试小说.txt', {
      adRules: [
        { id: 'custom', name: '自定义', type: 'line', pattern: '广告字', enabled: true }
      ]
    })
    expect(result.stats.adLinesRemoved).toBe(1)
    expect(result.chapters[0].paragraphs.join('')).not.toContain('广告字')
    expect(result.chapters[0].paragraphs).toContain('www.example-ad.com')
  })
})
