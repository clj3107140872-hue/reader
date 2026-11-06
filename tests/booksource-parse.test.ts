import { describe, expect, it } from 'vitest'
import {
  documentFromResponse,
  parseBookInfoPage,
  parseContentPage,
  parseSearchPage,
  parseTocPage,
  sourceRules
} from '../src/core/booksource/parse'

const definition = {
  searchUrl: '/search?q={{key}}',
  ruleSearch: {
    bookList: '.book',
    name: '.name@text',
    author: '.author@text',
    bookUrl: '.name@href',
    intro: '.intro@text'
  },
  ruleBookInfo: {
    name: '.detail h1@text',
    author: '.detail .author@text',
    tocUrl: '.read@href',
    coverUrl: 'img.cover@src'
  },
  ruleToc: { chapterList: '.chapter a', chapterName: '@text', chapterUrl: '@href' },
  ruleContent: { content: '#content@html' }
}
const rules = sourceRules(definition)

describe('booksource page parsing', () => {
  it('parses search items and resolves relative URLs', () => {
    const doc = documentFromResponse(
      '<div class="book"><a class="name" href="/b/1">书名</a><span class="author">作者</span><p class="intro">简介</p></div>',
      'text/html',
      'https://example.com/search'
    )
    const items = parseSearchPage(doc, rules, {
      baseUrl: 'https://example.com',
      searchKey: '书名'
    })
    expect(items).toEqual([
      {
        title: '书名',
        author: '作者',
        intro: '简介',
        kind: '',
        coverUrl: '',
        bookUrl: 'https://example.com/b/1',
        lastChapter: ''
      }
    ])
  })

  it('fills missing optional fields with empty strings', () => {
    const doc = documentFromResponse(
      '<div class="book"><a class="name" href="/b/2">只有书名</a></div>',
      'text/html',
      'https://example.com/search'
    )
    const items = parseSearchPage(doc, rules, { baseUrl: 'https://example.com', searchKey: 'x' })
    expect(items[0]).toMatchObject({ title: '只有书名', author: '', intro: '', lastChapter: '' })
    expect(items[0].bookUrl).toBe('https://example.com/b/2')
  })

  it('parses book info, toc with volume rows, and content', () => {
    const info = parseBookInfoPage(
      documentFromResponse(
        '<div class="detail"><h1>书名</h1><span class="author">作者</span><img class="cover" src="/c.jpg"><a class="read" href="/toc">目录</a></div>',
        'text/html',
        'https://example.com/b/1'
      ),
      rules,
      { baseUrl: 'https://example.com', bookUrl: 'https://example.com/b/1' }
    )
    expect(info.title).toBe('书名')
    expect(info.coverUrl).toBe('https://example.com/c.jpg')
    expect(info.tocUrl).toBe('https://example.com/toc')

    const toc = parseTocPage(
      documentFromResponse(
        '<div class="chapter"><a href="/c/1">第一章</a><a href="/c/2">第二章</a></div>',
        'text/html',
        'https://example.com/toc'
      ),
      {
        ...rules,
        tocIsVolume: ''
      },
      { baseUrl: 'https://example.com', bookUrl: 'https://example.com/b/1' }
    )
    expect(toc.chapters).toEqual([
      { title: '第一章', url: 'https://example.com/c/1', level: 'chapter' },
      { title: '第二章', url: 'https://example.com/c/2', level: 'chapter' }
    ])
    expect(toc.nextUrl).toBeUndefined()

    const content = parseContentPage(
      documentFromResponse(
        '<div id="content">第一段<br>第二句<p>第二段</p></div>',
        'text/html',
        'https://example.com/c/1'
      ),
      rules,
      { baseUrl: 'https://example.com', chapterUrl: 'https://example.com/c/1', chapterName: '第一章' }
    )
    expect(content.text).toBe('第一段\n\n第二句\n\n第二段')
    expect(content.nextUrl).toBeUndefined()
  })

  it('rejects JSON rules on HTML and javascript: links', () => {
    const html = documentFromResponse('<div>x</div>', 'text/html', 'https://example.com')
    const jsonRules = { ...rules, searchBookList: '@json:$.books[*]' }
    expect(() => parseSearchPage(html, jsonRules, { baseUrl: 'https://example.com' }))
      .toThrow('JSON')
    const doc = documentFromResponse(
      '<div class="book"><a class="name" href="javascript:alert(1)">x</a></div>',
      'text/html',
      'https://example.com'
    )
    expect(parseSearchPage(doc, rules, { baseUrl: 'https://example.com' })).toEqual([])
  })
})
