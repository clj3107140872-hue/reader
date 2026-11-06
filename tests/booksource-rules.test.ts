import { describe, expect, it } from 'vitest'
import {
  applyTemplate,
  evaluateRule,
  findUnsupportedRule,
  parseUrlOptions
} from '../src/core/booksource/rules'
import { htmlToParagraphs } from '../src/core/booksource/html'

const htmlDoc = {
  kind: 'html' as const,
  html: '<div class="book"><a href="/b/1">书名</a><span>作者</span></div>',
  url: 'https://example.com/search'
}

describe('booksource rules', () => {
  it('evaluates css, jsonpath, suffixes, fallbacks and regex replacement', () => {
    expect(evaluateRule('a@href', htmlDoc, { baseUrl: 'https://example.com' }).values).toEqual([
      '/b/1'
    ])
    expect(evaluateRule('a@href||span@text', htmlDoc, { baseUrl: 'https://example.com' }).values)
      .toEqual(['/b/1'])
    expect(evaluateRule('a@text&&span@text', htmlDoc, { baseUrl: 'https://example.com' }).values)
      .toEqual(['书名', '作者'])
    expect(
      evaluateRule('a@text##书##小##', htmlDoc, { baseUrl: 'https://example.com' }).values
    ).toEqual(['小名'])
    expect(
      evaluateRule('@json:$.books[*].name', {
        kind: 'json',
        value: { books: [{ name: 'A' }, { name: 'B' }] },
        url: 'https://example.com'
      }, { baseUrl: 'https://example.com' }).values
    ).toEqual(['A', 'B'])
  })

  it('renders templates and marks JS expressions unsupported', () => {
    const ctx = { baseUrl: 'https://example.com', searchKey: '斗破 苍穹', page: 2 }
    expect(applyTemplate('{{baseUrl}}/s?q={{key}}&p={{page}}', ctx, { encode: true }).text)
      .toBe('https://example.com/s?q=%E6%96%97%E7%A0%B4%20%E8%8B%8D%E7%A9%B9&p=2')
    expect(findUnsupportedRule('a@js:return x')).toContain('JS')
    expect(findUnsupportedRule('@json:$.a')).toBeNull()
    expect(findUnsupportedRule('{{(page-1)*20}}')).toContain('JS')
  })

  it('parses URL options from the right and falls back to a plain URL', () => {
    const parsed = parseUrlOptions(
      'https://example.com/s,{"method":"POST","body":"k={{key}}","charset":"gbk"}'
    )
    expect(parsed.url).toBe('https://example.com/s')
    expect(parsed.options.method).toBe('POST')
    expect(parsed.options.body).toBe('k={{key}}')
    expect(parseUrlOptions('https://example.com/s?a=1,2').url).toBe('https://example.com/s?a=1,2')
  })

  it('converts HTML into paragraphs without scripts or styles', () => {
    expect(
      htmlToParagraphs('<div>第一段<br>第二句</div><script>bad()</script><p>第二段</p><style>x{}</style>')
    ).toEqual(['第一段', '第二句', '第二段'])
  })
})
