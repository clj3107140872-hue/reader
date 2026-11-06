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
const MAX_CONTENT_CHARS = 2 * 1024 * 1024
const MAX_CHAPTERS = 20_000

export class SourceReader {
  constructor(private readonly http: HttpClient) {}

  private async fetch(
    source: ParsedSource,
    template: string,
    context: RuleContext,
    ruleGroup: unknown,
    signal?: AbortSignal
  ): Promise<{ doc: RuleDocument; response: HttpResponse; warnings: string[] }> {
    const parsed = parseUrlOptions(template)
    const warnings = [...parsed.warnings]
    const templatedUrl = applyTemplate(parsed.url, context, { encode: true })
    warnings.push(...templatedUrl.warnings)
    const url = absoluteUrl(templatedUrl.text, source.url)
    if (!url) throw new NetworkError('书源地址无效', 'blocked')
    let body: string | undefined
    if (parsed.options.body) {
      const templatedBody = applyTemplate(parsed.options.body, context, { encode: false })
      warnings.push(...templatedBody.warnings)
      body = templatedBody.text
    }
    const headers: Record<string, string> = {}
    for (const [key, value] of Object.entries({
      ...source.header,
      ...parsed.options.headers
    })) {
      const templatedHeader = applyTemplate(value, context, { encode: false })
      warnings.push(...templatedHeader.warnings)
      headers[key] = templatedHeader.text
    }
    const response = await this.http.request({
      url,
      method: parsed.options.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      charset: parsed.options.charset ?? source.charset,
      sourceId: source.url,
      ...(signal ? { signal } : {}),
      retry: parsed.options.retry
    })
    warnings.push(...response.warnings)
    // Only the current operation's rule group decides whether this response is
    // JSON; a JSON search API must not force HTML content pages through JSON.
    const hint = JSON.stringify(ruleGroup ?? '')
    return {
      doc: documentFromResponse(response.text, response.contentType, response.url, hint),
      response,
      warnings
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
    const { doc } = await this.fetch(
      source,
      rules.searchUrl,
      context,
      source.definition.ruleSearch,
      signal
    )
    return parseSearchPage(doc, rules, context)
  }

  async info(
    source: ParsedSource,
    bookUrl: string,
    signal?: AbortSignal
  ): Promise<ParsedBookInfo & { bookUrl: string }> {
    const rules = sourceRules(source.definition)
    const context: RuleContext = { baseUrl: source.url, bookUrl }
    const { doc } = await this.fetch(
      source,
      bookUrl,
      context,
      source.definition.ruleBookInfo,
      signal
    )
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
    const seenPages = new Set<string>()
    const warnings: string[] = []
    for (let page = 0; page < MAX_TOC_PAGES && url; page++) {
      if (seenPages.has(url)) {
        warnings.push('目录下一页出现循环，已停止')
        break
      }
      seenPages.add(url)
      const { doc, warnings: fetchWarnings } = await this.fetch(
        source,
        url,
        context,
        source.definition.ruleToc,
        signal
      )
      warnings.push(...fetchWarnings)
      const parsed = parseTocPage(doc, rules, context)
      warnings.push(...parsed.warnings)
      for (const chapter of parsed.chapters) {
        const key = `${chapter.level}|${chapter.url}|${chapter.title}`
        if (seen.has(key)) continue
        seen.add(key)
        chapters.push(chapter)
      }
      if (chapters.length > MAX_CHAPTERS) {
        chapters.length = MAX_CHAPTERS
        warnings.push('目录超过 20000 章，已截断')
        return { chapters, warnings }
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
    let text = ''
    const warnings: string[] = []
    const seen = new Set<string>()
    for (let page = 0; page < MAX_CONTENT_PAGES && url; page++) {
      if (seen.has(url)) {
        warnings.push('正文下一页出现循环，已停止')
        break
      }
      seen.add(url)
      const { doc, warnings: fetchWarnings } = await this.fetch(
        source,
        url,
        context,
        source.definition.ruleContent,
        signal
      )
      warnings.push(...fetchWarnings)
      const parsed = parseContentPage(doc, rules, context)
      warnings.push(...parsed.warnings)
      if (parsed.text) {
        text = text ? `${text}\n\n${parsed.text}` : parsed.text
        if (text.length > MAX_CONTENT_CHARS) {
          text = text.slice(0, MAX_CONTENT_CHARS)
          warnings.push('正文超过 2 MB，已截断')
          break
        }
      }
      url = parsed.nextUrl ?? ''
    }
    return { text, warnings }
  }
}
