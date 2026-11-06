import { afterEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { HttpClient } from '../src/main/services/network/httpClient'
import type { ParsedSource } from '../src/core/booksource/legado'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'

let close: (() => Promise<void>) | null = null
afterEach(async () => {
  if (close) await close()
  close = null
})

function source(
  definition: Record<string, unknown>,
  overrides: Partial<ParsedSource> = {}
): ParsedSource {
  return {
    definition,
    name: '源A',
    url: 'https://example.com',
    group: '',
    searchUrl: '',
    header: {},
    customOrder: 0,
    compat: { level: 'full', issues: [] },
    ...overrides
  }
}

describe('SourceReader', () => {
  it('parses JSON search with one rule group and HTML content with another', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url?.startsWith('/search')) {
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ books: [{ name: '斗破苍穹', author: '土豆', url: '/b/1' }] }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div id="content">正文<p>第二段</p></div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      {
        searchUrl: '/search?q={{key}}',
        ruleSearch: {
          bookList: '@json:$.books[*]',
          name: '$.name',
          author: '$.author',
          bookUrl: '$.url'
        },
        ruleContent: { content: '#content@html' }
      },
      { url: server.url }
    )

    const items = await reader.search(parsed, '斗破', 1)
    expect(items).toEqual([
      {
        title: '斗破苍穹',
        author: '土豆',
        intro: '',
        kind: '',
        coverUrl: '',
        bookUrl: `${server.url}/b/1`,
        lastChapter: ''
      }
    ])

    const content = await reader.content(parsed, {
      chapterUrl: `${server.url}/c/1`,
      chapterName: '第一章',
      bookUrl: `${server.url}/b/1`
    })
    expect(content.text).toBe('正文\n\n第二段')
  })

  it('truncates oversized content to 2 MB with a warning and stops paginating', async () => {
    const big = '字'.repeat(2 * 1024 * 1024 + 10)
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (req.url === '/c/1') {
        res.end(`<div id="content">${big}</div><a class="next" href="/c/2">下一页</a>`)
        return
      }
      res.end('<div id="content">不应该被请求</div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      { ruleContent: { content: '#content@html', nextContentUrl: '.next@href' } },
      { url: server.url }
    )

    const result = await reader.content(parsed, {
      chapterUrl: `${server.url}/c/1`,
      chapterName: '第一章',
      bookUrl: `${server.url}/b/1`
    })
    expect(result.text.length).toBe(2 * 1024 * 1024)
    expect(result.warnings).toContain('正文超过 2 MB，已截断')
    expect(server.requestCount).toBe(1)
  })

  it('surfaces rule evaluation warnings from toc and content', async () => {
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      if (req.url === '/toc') {
        res.end('<div class="chapter"><a href="/c/1">第一章</a></div>')
        return
      }
      res.end('<div id="content">正文</div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      {
        ruleToc: { chapterList: '.chapter a', chapterName: '@text##[##', chapterUrl: '@href' },
        ruleContent: { content: '#content@html##[##' }
      },
      { url: server.url }
    )

    const toc = await reader.toc(parsed, {
      bookUrl: `${server.url}/b/1`,
      tocUrl: `${server.url}/toc`
    })
    expect(toc.warnings.some((warning) => warning.includes('正则无效'))).toBe(true)

    const content = await reader.content(parsed, {
      chapterUrl: `${server.url}/c/1`,
      chapterName: '第一章',
      bookUrl: `${server.url}/b/1`
    })
    expect(content.warnings.some((warning) => warning.includes('正则无效'))).toBe(true)
  })

  it('merges template and decoding warnings into toc warnings', async () => {
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div class="chapter"><a href="/c/1">第一章</a></div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      {
        ruleToc: { chapterList: '.chapter a', chapterName: '@text', chapterUrl: '@href' }
      },
      {
        url: server.url,
        charset: 'bogus-charset',
        header: { 'X-Warn': '{{nope}}' }
      }
    )

    const toc = await reader.toc(parsed, {
      bookUrl: `${server.url}/b/1`,
      tocUrl: `${server.url}/toc?x={{nope}}`
    })
    expect(toc.warnings).toContain('未知模板变量 {{nope}}')
    expect(toc.warnings).toContain('未知字符集 bogus-charset，按 UTF-8 处理')
    expect(toc.chapters).toHaveLength(1)
  })

  it('prefers the charset from URL options over the source charset', async () => {
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div class="chapter"><a href="/c/1">正文</a></div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      { ruleToc: { chapterList: '.chapter a', chapterName: '@text', chapterUrl: '@href' } },
      { url: server.url, charset: 'gbk' }
    )

    const toc = await reader.toc(parsed, {
      bookUrl: `${server.url}/b/1`,
      tocUrl: `${server.url}/toc,{"charset":"utf-8"}`
    })
    expect(toc.chapters[0].title).toBe('正文')
  })

  it('renders header templates with the request context', async () => {
    let received = ''
    const server = await startFakeServer((req, res) => {
      received = String(req.headers['x-chapter'] ?? '')
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div id="content">正文</div>')
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const chapterUrl = `${server.url}/c/1`
    const parsed = source(
      { ruleContent: { content: '#content@html' } },
      { url: server.url, header: { 'X-Chapter': '{{chapter.url}}' } }
    )

    await reader.content(parsed, {
      chapterUrl,
      chapterName: '第一章',
      bookUrl: `${server.url}/b/1`
    })
    expect(received).toBe(chapterUrl)
  })

  it('stops when the toc next page repeats', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end(
        '<div class="chapter"><a href="/c/1">第一章</a></div><a class="next" href="/toc">下一页</a>'
      )
    })
    close = server.close
    const reader = new SourceReader(new HttpClient())
    const parsed = source(
      {
        ruleToc: {
          chapterList: '.chapter a',
          chapterName: '@text',
          chapterUrl: '@href',
          nextTocUrl: '.next@href'
        }
      },
      { url: server.url }
    )

    const toc = await reader.toc(parsed, {
      bookUrl: `${server.url}/b/1`,
      tocUrl: `${server.url}/toc`
    })
    expect(server.requestCount).toBe(1)
    expect(toc.warnings).toContain('目录下一页出现循环，已停止')
    expect(toc.chapters).toHaveLength(1)
  })
})
