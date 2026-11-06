import type { ParsedSource } from '../../../core/booksource/legado'
import type { TocChapter } from '../../../core/booksource/model'
import {
  absoluteUrl,
  documentFromResponse,
  parseBookInfoPage,
  parseContentPage,
  parseSearchPage,
  parseTocPage,
  sourceRules
} from '../../../core/booksource/parse'
import type { ParsedBookInfo, ParsedSearchItem } from '../../../core/booksource/parse'
import { applyTemplate, parseUrlOptions } from '../../../core/booksource/rules'
import type { RuleContext, RuleDocument } from '../../../core/booksource/rules'
import type { HttpClient, HttpResponse } from './httpClient'
import { NetworkError } from './httpClient'

const MAX_TOC_PAGES = 50
const MAX_CONTENT_PAGES = 20

export class SourceReader {
  constructor(private readonly http: HttpClient) {}

  private async fetch(
    source: ParsedSource,
    template: string,
    context: RuleContext,
    signal?: AbortSignal
  ): Promise<{ doc: RuleDocument; response: HttpResponse; warnings: string[] }> {
    const parsed = parseUrlOptions(template)
    const urlText = applyTemplate(parsed.url, context, { encode: true }).text
    const url = absoluteUrl(urlText, source.url)
    if (!url) throw new NetworkError('书源地址无效', 'blocked')
    const body = parsed.options.body
      ? applyTemplate(parsed.options.body, context, { encode: false }).text
      : undefined
    const response = await this.http.request({
      url,
      method: parsed.options.method,
      headers: { ...source.header, ...parsed.options.headers },
      ...(body !== undefined ? { body } : {}),
      charset: source.charset ?? parsed.options.charset,
      sourceId: source.url,
      ...(signal ? { signal } : {}),
      retry: parsed.options.retry
    })
    const hint = [
      source.definition.ruleSearch,
      source.definition.ruleBookInfo,
      source.definition.ruleToc,
      source.definition.ruleContent
    ]
      .map((value) => JSON.stringify(value ?? ''))
      .join(' ')
    return {
      doc: documentFromResponse(response.text, response.contentType, response.url, hint),
      response,
      warnings: parsed.warnings
    }
  }

  async search(
    source: ParsedSource,
    keyword: string,
    page: number,
    signal?: AbortSignal
  ): Promise<ParsedSearchItem[]> {
    const rules = sourceRules(source.definition)
    const context: RuleContext = {
      baseUrl: source.url,
      searchKey: keyword,
      page,
      searchPage: page
    }
    const { doc } = await this.fetch(source, rules.searchUrl, context, signal)
    return parseSearchPage(doc, rules, context)
  }

  async info(
    source: ParsedSource,
    bookUrl: string,
    signal?: AbortSignal
  ): Promise<ParsedBookInfo & { bookUrl: string }> {
    const rules = sourceRules(source.definition)
    const context: RuleContext = { baseUrl: source.url, bookUrl }
    const { doc } = await this.fetch(source, bookUrl, context, signal)
    const info = parseBookInfoPage(doc, rules, context)
    return { ...info, bookUrl: doc.url }
  }

  async toc(
    source: ParsedSource,
    input: { bookUrl: string; tocUrl: string },
    signal?: AbortSignal
  ): Promise<{ chapters: TocChapter[]; warnings: string[] }> {
    const rules = sourceRules(source.definition)
    const context: RuleContext = {
      baseUrl: source.url,
      bookUrl: input.bookUrl,
      ...(input.tocUrl ? { extra: { tocUrl: input.tocUrl } } : {})
    }
    let url = input.tocUrl || input.bookUrl
    const chapters: TocChapter[] = []
    const seen = new Set<string>()
    const warnings: string[] = []
    for (let page = 0; page < MAX_TOC_PAGES && url; page++) {
      const { doc, warnings: fetchWarnings } = await this.fetch(source, url, context, signal)
      warnings.push(...fetchWarnings)
      const parsed = parseTocPage(doc, rules, context)
      for (const chapter of parsed.chapters) {
        const key = `${chapter.level}|${chapter.url}|${chapter.title}`
        if (seen.has(key)) continue
        seen.add(key)
        chapters.push(chapter)
        if (chapters.length >= 20_000) {
          warnings.push('目录超过 20000 章，已截断')
          return { chapters, warnings }
        }
      }
      url = parsed.nextUrl ?? ''
    }
    return { chapters, warnings }
  }

  async content(
    source: ParsedSource,
    input: { chapterUrl: string; chapterName: string; bookUrl: string },
    signal?: AbortSignal
  ): Promise<{ text: string; warnings: string[] }> {
    const rules = sourceRules(source.definition)
    const context: RuleContext = {
      baseUrl: source.url,
      bookUrl: input.bookUrl,
      chapterUrl: input.chapterUrl,
      chapterName: input.chapterName
    }
    let url = input.chapterUrl
    const parts: string[] = []
    const warnings: string[] = []
    const seen = new Set<string>()
    for (let page = 0; page < MAX_CONTENT_PAGES && url; page++) {
      if (seen.has(url)) {
        warnings.push('正文下一页出现循环，已停止')
        break
      }
      seen.add(url)
      const { doc, warnings: fetchWarnings } = await this.fetch(source, url, context, signal)
      warnings.push(...fetchWarnings)
      const parsed = parseContentPage(doc, rules, context)
      if (parsed.text) parts.push(parsed.text)
      url = parsed.nextUrl ?? ''
    }
    const text = parts.join('\n\n')
    if (text.length > 2 * 1024 * 1024) throw new NetworkError('正文超过 2 MB，已停止', 'too-large')
    return { text, warnings }
  }
}
