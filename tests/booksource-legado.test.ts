import { describe, expect, it } from 'vitest'
import {
  normalizeSourceDefinition,
  parseSourceJson,
  parseSourceValue,
  resolveSourceImportUrl
} from '../src/core/booksource/legado'

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    bookSourceName: '测试源',
    bookSourceUrl: 'https://example.com',
    bookSourceType: 0,
    searchUrl: '/search?q={{key}}',
    ruleSearch: { bookList: '.book', name: '.name@text', bookUrl: '.name@href' },
    ruleToc: { chapterList: '.chapter', chapterName: 'a@text', chapterUrl: 'a@href' },
    ruleContent: { content: '#content@html' },
    ...overrides
  }
}

describe('legado source parsing', () => {
  it('accepts a single object and an array, deduplicating by URL', () => {
    const single = parseSourceValue(raw())
    expect(single.rejected).toEqual([])
    expect(single.sources[0].name).toBe('测试源')

    const batch = parseSourceValue([
      raw(),
      raw({ bookSourceName: '更新后的源' }),
      raw({ bookSourceUrl: 'https://other.example.com', bookSourceName: '另一个' })
    ])
    expect(batch.sources.map((source) => source.name)).toEqual(['更新后的源', '另一个'])
  })

  it('rejects missing required fields, non-text sources and bad JSON', () => {
    const missing = normalizeSourceDefinition(raw({ ruleToc: {} }))
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.rejected.reason).toContain('chapterList')

    const audio = normalizeSourceDefinition(raw({ bookSourceType: 1 }))
    expect(audio.ok).toBe(false)
    expect(() => parseSourceJson('{bad')).toThrow()
  })

  it('marks JS, XPath and WebView sources partial with issues', () => {
    const js = normalizeSourceDefinition(raw({ ruleContent: { content: '<js>load()</js>' } }))
    expect(js.ok).toBe(true)
    if (js.ok) {
      expect(js.source.compat.level).toBe('partial')
      expect(js.source.compat.issues.join('')).toContain('JS')
    }
    const xpath = normalizeSourceDefinition(
      raw({ ruleToc: { chapterList: '@xpath://a', chapterName: 'a@text', chapterUrl: 'a@href' } })
    )
    expect(xpath.ok).toBe(true)
    if (xpath.ok) expect(xpath.source.compat.issues.join('')).toContain('XPath')
  })

  it('marks login configuration and WebView flags partial', () => {
    const result = normalizeSourceDefinition(
      raw({
        loginUrl: 'https://example.com/login',
        ruleContent: { content: '#c', webView: true }
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.source.compat.level).toBe('partial')
      expect(result.source.compat.issues).toHaveLength(2)
      expect(result.source.compat.issues).toContain('不支持登录相关配置：loginUrl')
      expect(result.source.compat.issues).toContain('不支持 WebView 配置：webView')
    }
  })

  it('keeps a source with a malformed header full and reports a batch warning', () => {
    const batch = parseSourceValue(raw({ header: '{bad' }))
    expect(batch.rejected).toEqual([])
    expect(batch.sources[0].compat.level).toBe('full')
    expect(batch.sources[0].warnings?.join('')).toContain('header')
    expect(batch.warnings.join('')).toContain('header')
  })

  it('honors a source-provided enabled flag and defaults to true', () => {
    const disabled = normalizeSourceDefinition(raw({ enabled: false }))
    expect(disabled.ok && disabled.source.enabled).toBe(false)
    const missing = normalizeSourceDefinition(raw())
    expect(missing.ok && missing.source.enabled).toBe(true)
    const notBoolean = normalizeSourceDefinition(raw({ enabled: 'no' }))
    expect(notBoolean.ok && notBoolean.source.enabled).toBe(true)
  })

  it('decodes legado share links and rejects private schemes', () => {
    expect(
      resolveSourceImportUrl(
        'legado://import/bookSource?src=https%3A%2F%2Fexample.com%2Fsource.json'
      )
    ).toBe('https://example.com/source.json')
    expect(resolveSourceImportUrl('https://example.com/source.json')).toBe(
      'https://example.com/source.json'
    )

    expect(() => resolveSourceImportUrl('file:///etc/passwd')).toThrow(/http/)
    expect(() =>
      resolveSourceImportUrl('legado://import/bookSource?src=file%3A%2F%2F%2Fetc%2Fpasswd')
    ).toThrow(/http/)
    expect(() => resolveSourceImportUrl('legado://import/other?src=https%3A%2F%2Fx.com'))
      .toThrow(/分享链接/)
    expect(() => resolveSourceImportUrl('legado://import/bookSource?src=')).toThrow(/缺少/)
    expect(() => resolveSourceImportUrl('not a url')).toThrow(/地址无效/)
  })
})
