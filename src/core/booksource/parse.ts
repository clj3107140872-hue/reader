import { load } from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import type { RuleContext, RuleDocument } from './rules'
import { evaluateRule } from './rules'
import type { TocChapter } from './model'
import { htmlToParagraphs } from './html'

export interface SourceRules {
  searchUrl: string
  searchBookList: string
  searchName: string
  searchAuthor: string
  searchKind: string
  searchIntro: string
  searchCoverUrl: string
  searchBookUrl: string
  searchLastChapter: string
  infoName: string
  infoAuthor: string
  infoKind: string
  infoIntro: string
  infoCoverUrl: string
  infoLastChapter: string
  tocUrl: string
  tocChapterList: string
  tocChapterName: string
  tocChapterUrl: string
  tocIsVolume: string
  tocNextUrl: string
  content: string
  contentNextUrl: string
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

export function sourceRules(definition: Record<string, unknown>): SourceRules {
  const search = object(definition.ruleSearch)
  const info = object(definition.ruleBookInfo)
  const toc = object(definition.ruleToc)
  const content = object(definition.ruleContent)
  return {
    searchUrl: text(definition.searchUrl),
    searchBookList: text(search.bookList),
    searchName: text(search.name),
    searchAuthor: text(search.author),
    searchKind: text(search.kind),
    searchIntro: text(search.intro),
    searchCoverUrl: text(search.coverUrl),
    searchBookUrl: text(search.bookUrl),
    searchLastChapter: text(search.lastChapter),
    infoName: text(info.name),
    infoAuthor: text(info.author),
    infoKind: text(info.kind),
    infoIntro: text(info.intro),
    infoCoverUrl: text(info.coverUrl),
    infoLastChapter: text(info.lastChapter),
    tocUrl: text(info.tocUrl),
    tocChapterList: text(toc.chapterList),
    tocChapterName: text(toc.chapterName),
    tocChapterUrl: text(toc.chapterUrl),
    tocIsVolume: text(toc.isVolume),
    tocNextUrl: text(toc.nextTocUrl),
    content: text(content.content),
    contentNextUrl: text(content.nextContentUrl)
  }
}

export function absoluteUrl(value: string, base: string): string {
  const trimmed = value.trim()
  if (!trimmed || /^javascript:/i.test(trimmed)) return ''
  try {
    const resolved = new URL(trimmed, base)
    return resolved.protocol === 'http:' || resolved.protocol === 'https:'
      ? resolved.toString()
      : ''
  } catch {
    return ''
  }
}

export function documentFromResponse(
  textBytes: string,
  contentType: string,
  url: string,
  ruleHint = ''
): RuleDocument {
  const trimmed = textBytes.trim()
  const wantsJson = /@json:/i.test(ruleHint) || /json/i.test(contentType)
  if (wantsJson || /^[\[{]/.test(trimmed)) {
    try {
      return { kind: 'json', value: JSON.parse(trimmed), url }
    } catch {
      if (wantsJson) throw new Error('书源要求 JSON，但响应不是合法 JSON')
    }
  }
  return { kind: 'html', html: textBytes, url }
}

function listDocuments(
  doc: RuleDocument,
  rule: string
): { doc: RuleDocument; base: string }[] {
  const alternatives = rule.split('||').map((part) => part.trim()).filter(Boolean)
  const selected =
    alternatives.find((part) => (doc.kind === 'json' ? /^@json:/i.test(part) : !/^@json:/i.test(part))) ??
    alternatives[0] ??
    ''
  if (doc.kind === 'json') {
    if (!/^@json:/i.test(selected) && selected !== '$') {
      throw new Error('这个书源要求 JSONPath，但响应不是 JSON')
    }
    const path = selected.replace(/^@json:/i, '') || '$'
    const values = JSONPath({ path, json: doc.value as object, wrap: true }) as unknown[]
    return values.map((value) => ({ doc: { kind: 'json', value, url: doc.url }, base: doc.url }))
  }
  if (/^@json:/i.test(selected)) throw new Error('这个书源要求 JSON，但响应是 HTML')
  const selector = selected.replace(/^@css:/i, '')
  const $ = load(doc.html)
  const nodes = selector ? $(selector).toArray() : $.root().children().toArray()
  return nodes.map((node) => ({
    doc: { kind: 'html', html: $.html(node), url: doc.url },
    base: doc.url
  }))
}

function field(rule: string, doc: RuleDocument, context: RuleContext): string {
  if (!rule) return ''
  return evaluateRule(rule, doc, context).values
    .map((value) => value.trim())
    .filter(Boolean)
    .join('\n')
}

export interface ParsedSearchItem {
  title: string
  author: string
  intro: string
  kind: string
  coverUrl: string
  bookUrl: string
  lastChapter: string
}

export function parseSearchPage(
  doc: RuleDocument,
  rules: SourceRules,
  context: RuleContext
): ParsedSearchItem[] {
  return listDocuments(doc, rules.searchBookList)
    .map(({ doc: itemDoc, base }) => {
      const title = field(rules.searchName, itemDoc, context)
      const bookUrl = absoluteUrl(field(rules.searchBookUrl, itemDoc, context), base)
      return {
        title,
        author: field(rules.searchAuthor, itemDoc, context),
        intro: field(rules.searchIntro, itemDoc, context),
        kind: field(rules.searchKind, itemDoc, context),
        coverUrl: absoluteUrl(field(rules.searchCoverUrl, itemDoc, context), base),
        bookUrl,
        lastChapter: field(rules.searchLastChapter, itemDoc, context)
      }
    })
    .filter((item) => item.title && item.bookUrl)
}

export interface ParsedBookInfo {
  title: string
  author: string
  kind: string
  intro: string
  coverUrl: string
  lastChapter: string
  tocUrl: string
}

export function parseBookInfoPage(
  doc: RuleDocument,
  rules: SourceRules,
  context: RuleContext
): ParsedBookInfo {
  const title = field(rules.infoName, doc, context)
  return {
    title,
    author: field(rules.infoAuthor, doc, context),
    kind: field(rules.infoKind, doc, context),
    intro: field(rules.infoIntro, doc, context),
    coverUrl: absoluteUrl(field(rules.infoCoverUrl, doc, context), doc.url),
    lastChapter: field(rules.infoLastChapter, doc, context),
    tocUrl: absoluteUrl(field(rules.tocUrl, doc, context), doc.url)
  }
}

export interface ParsedToc {
  chapters: TocChapter[]
  nextUrl?: string
}

export function parseTocPage(
  doc: RuleDocument,
  rules: SourceRules,
  context: RuleContext
): ParsedToc {
  const chapters: TocChapter[] = []
  for (const { doc: itemDoc, base } of listDocuments(doc, rules.tocChapterList)) {
    const title = field(rules.tocChapterName || '@text', itemDoc, context)
    const url = absoluteUrl(field(rules.tocChapterUrl || '@href', itemDoc, context), base)
    const volume = rules.tocIsVolume
      ? Boolean(field(rules.tocIsVolume, itemDoc, context))
      : false
    if (!title || (!url && !volume)) continue
    chapters.push({ title, url, level: volume ? 'volume' : 'chapter' })
  }
  const next = rules.tocNextUrl ? field(rules.tocNextUrl, doc, context) : ''
  const nextUrl = absoluteUrl(next, doc.url)
  return { chapters, ...(nextUrl ? { nextUrl } : {}) }
}

export interface ParsedContent {
  text: string
  nextUrl?: string
}

export function parseContentPage(
  doc: RuleDocument,
  rules: SourceRules,
  context: RuleContext
): ParsedContent {
  const raw = field(rules.content, doc, context)
  const paragraphs = htmlToParagraphs(raw)
  const next = rules.contentNextUrl ? field(rules.contentNextUrl, doc, context) : ''
  const nextUrl = absoluteUrl(next, doc.url)
  return {
    text: paragraphs.join('\n\n'),
    ...(nextUrl ? { nextUrl } : {})
  }
}
