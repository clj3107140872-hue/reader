import { load } from 'cheerio'
import { JSONPath } from 'jsonpath-plus'

export interface RuleContext {
  baseUrl: string
  searchKey?: string
  page?: number
  searchPage?: number
  pageIndex?: number
  bookUrl?: string
  bookName?: string
  bookAuthor?: string
  chapterName?: string
  chapterUrl?: string
  extra?: Record<string, string>
}

export type RuleDocument =
  | { kind: 'html'; html: string; url: string }
  | { kind: 'json'; value: unknown; url: string }

export interface RuleEvalResult {
  values: string[]
  warnings: string[]
}

export interface ParsedUrlOptions {
  url: string
  options: {
    method: 'GET' | 'POST'
    body?: string
    charset?: string
    headers?: Record<string, string>
    retry?: number
  }
  warnings: string[]
}

const TEMPLATE_RE = /\{\{([^{}]+)\}\}/g
const SUFFIX_RE = /@(text|ownText|html|textNode|href|src)$/i

function variableValue(key: string, ctx: RuleContext): string | undefined {
  switch (key) {
    case 'key':
    case 'searchKey':
      return ctx.searchKey
    case 'page':
      return String(ctx.page ?? 1)
    case 'searchPage':
      return String(ctx.searchPage ?? 1)
    case 'pageIndex':
      return String(ctx.pageIndex ?? 0)
    case 'baseUrl':
      return ctx.baseUrl
    case 'bookUrl':
      return ctx.bookUrl
    case 'book.name':
      return ctx.bookName
    case 'book.author':
      return ctx.bookAuthor
    case 'chapter.name':
      return ctx.chapterName
    case 'chapter.url':
      return ctx.chapterUrl
    default:
      return ctx.extra?.[key]
  }
}

/** Substitutes simple Legado variables. JS expressions are reported, never executed. */
export function applyTemplate(
  text: string,
  ctx: RuleContext,
  options: { encode?: boolean } = {}
): { text: string; warnings: string[] } {
  const warnings: string[] = []
  const URL_VARIABLES = new Set(['baseUrl', 'bookUrl', 'chapterUrl', 'chapter.url'])
  const output = text.replace(TEMPLATE_RE, (_match, raw: string) => {
    const key = raw.trim()
    const value = variableValue(key, ctx)
    if (value === undefined) {
      warnings.push(`未知模板变量 {{${key}}}`)
      return ''
    }
    // Legado encodes query values, but URLs injected through {{baseUrl}} /
    // {{bookUrl}} must stay intact.
    return options.encode && !URL_VARIABLES.has(key) ? encodeURIComponent(value) : value
  })
  return { text: output, warnings }
}

export function findUnsupportedRule(text: string): string | null {
  if (!text) return null
  if (/<js>/i.test(text)) return '使用了 JS 规则'
  if (/@js(?!on)(?=[:@\s]|$)/i.test(text)) return '使用了 JS 规则'
  if (/@xpath:/i.test(text)) return '使用了 XPath 规则'
  if (/"webview"\s*:\s*true/i.test(text)) return '使用了 WebView'
  if (/(loginurl|loginui|logincheckjs)/i.test(text)) return '使用了登录规则'
  if (/\{\{[^{}]*(?:\(|\)|\*|\/|\+)/.test(text)) return '模板中使用了 JS 表达式'
  return null
}

export function parseUrlOptions(raw: string): ParsedUrlOptions {
  const warnings: string[] = []
  let at = raw.lastIndexOf(',{')
  const sawOptionsCandidate = at >= 0
  while (at >= 0) {
    const candidate = raw.slice(at + 1)
    try {
      const value = JSON.parse(candidate) as Record<string, unknown>
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const method = String(value.method ?? 'GET').toUpperCase() === 'POST' ? 'POST' : 'GET'
        const headers: Record<string, string> = {}
        if (value.headers && typeof value.headers === 'object' && !Array.isArray(value.headers)) {
          for (const [key, entry] of Object.entries(value.headers as Record<string, unknown>)) {
            if (typeof entry === 'string') headers[key] = entry
          }
        }
        const retry = Number(value.retry)
        return {
          url: raw.slice(0, at),
          options: {
            method,
            ...(typeof value.body === 'string' ? { body: value.body } : {}),
            ...(typeof value.charset === 'string' ? { charset: value.charset } : {}),
            ...(Object.keys(headers).length > 0 ? { headers } : {}),
            ...(Number.isFinite(retry) ? { retry: Math.min(3, Math.max(0, Math.floor(retry))) } : {})
          },
          warnings
        }
      }
    } catch {
      // Keep looking left; a comma inside the URL is not an options block.
    }
    at = raw.lastIndexOf(',{', at - 1)
  }
  if (sawOptionsCandidate) warnings.push('URL options 解析失败，按普通 URL 处理')
  return { url: raw, options: { method: 'GET' }, warnings }
}

function splitTop(text: string, separator: string): string[] {
  const parts: string[] = []
  let start = 0
  let depth = 0
  let quote: string | null = null
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null
      continue
    }
    if (ch === '"' || ch === "'") { quote = ch; continue }
    if (ch === '(' || ch === '[') { depth++; continue }
    if (ch === ')' || ch === ']') { depth = Math.max(0, depth - 1); continue }
    if (depth === 0 && text.startsWith(separator, i)) {
      parts.push(text.slice(start, i))
      start = i + separator.length
      i += separator.length - 1
    }
  }
  parts.push(text.slice(start))
  return parts
}

interface SegmentParts {
  selector: string
  suffix: string
  index: number | null
  pattern?: string
  replacement?: string
  onlyFirst: boolean
}

function extractIndex(value: string): { selector: string; index: number | null } {
  const match = /\.(-?\d+)$/.exec(value)
  if (!match) return { selector: value, index: null }
  return { selector: value.slice(0, match.index), index: Number(match[1]) }
}

function parseSegment(raw: string): SegmentParts {
  let selector = raw.trim()
  // The OnlyOne marker belongs to the raw rule: splitting on ## first would
  // turn the trailing "###" into an extra "#" part and lose the marker.
  let onlyFirst = false
  if (selector.endsWith('###')) {
    onlyFirst = true
    selector = selector.slice(0, -3)
  }
  const parts = selector.split('##')
  let pattern: string | undefined
  let replacement: string | undefined
  if (parts.length >= 3) {
    selector = parts[0]
    pattern = parts[1]
    replacement = parts[2] ?? ''
  }
  // Legado allows the index before the suffix (a.0@href) or after it (a@href.0).
  const leading = extractIndex(selector)
  selector = leading.selector
  let index = leading.index
  const suffixMatch = SUFFIX_RE.exec(selector)
  const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : 'text'
  if (suffixMatch) {
    selector = selector.slice(0, suffixMatch.index)
    if (index === null) {
      const trailing = extractIndex(selector)
      selector = trailing.selector
      index = trailing.index
    }
  }
  return { selector: selector.trim(), suffix, index, pattern, replacement, onlyFirst }
}

function jsonValues(path: string, value: unknown, suffix: string): string[] {
  const found = JSONPath({ path, json: value as object, wrap: true }) as unknown[]
  return found.map((entry) => {
    if (suffix === 'href' || suffix === 'src') {
      if (entry && typeof entry === 'object') {
        const attr = (entry as Record<string, unknown>)[suffix]
        return typeof attr === 'string' ? attr : ''
      }
      return ''
    }
    if (typeof entry === 'string') return entry
    if (typeof entry === 'number' || typeof entry === 'boolean') return String(entry)
    return JSON.stringify(entry)
  })
}

function htmlValues(selector: string, suffix: string, doc: { html: string }): string[] {
  // Fragment mode keeps the document's own root element(s) addressable, so a
  // bare suffix rule (`@href`, `@text`) can read from the item element itself.
  const $ = load(doc.html, null, false)
  const nodes = selector ? $(selector) : $.root().children()
  const values: string[] = []
  nodes.each((_index, node) => {
    if (suffix === 'href' || suffix === 'src') {
      const value = $(node).attr(suffix)
      if (value) values.push(value)
      return
    }
    if (suffix === 'html') {
      values.push($.html(node))
      return
    }
    if (suffix === 'owntext') {
      values.push($(node).clone().children().remove().end().text())
      return
    }
    if (suffix === 'textnode') {
      values.push($(node).contents().filter((_i, child) => child.type === 'text').text())
      return
    }
    values.push($(node).text())
  })
  return values
}

function evaluateSegment(parts: SegmentParts, doc: RuleDocument): { values: string[]; warnings: string[] } {
  const warnings: string[] = []
  let values: string[]
  try {
    if (/^@json:/i.test(parts.selector)) {
      if (doc.kind !== 'json') return { values: [], warnings: ['JSONPath 规则用在了 HTML 响应上'] }
      values = jsonValues(parts.selector.slice(6), doc.value, parts.suffix)
    } else if (/^@xpath:/i.test(parts.selector)) {
      return { values: [], warnings: ['不支持的规则类型：XPath'] }
    } else {
      const selector = parts.selector.replace(/^@css:/i, '')
      if (doc.kind === 'json') {
        const path = selector || '$'
        values = jsonValues(path, doc.value, parts.suffix)
      } else {
        values = htmlValues(selector, parts.suffix, doc)
      }
    }
    if (parts.index !== null) {
      const index = parts.index < 0 ? values.length + parts.index : parts.index
      values = index >= 0 && index < values.length ? [values[index]] : []
    }
    if (parts.pattern !== undefined) {
      try {
        const re = new RegExp(parts.pattern, parts.onlyFirst ? '' : 'g')
        values = values.map((value) => value.replace(re, parts.replacement ?? ''))
      } catch {
        warnings.push(`正则无效：${parts.pattern}`)
      }
    }
  } catch (error) {
    warnings.push(error instanceof Error ? error.message : '规则求值失败')
    values = []
  }
  return { values, warnings }
}

export function evaluateRule(
  rule: string,
  doc: RuleDocument,
  ctx: RuleContext
): RuleEvalResult {
  const templated = applyTemplate(rule, ctx)
  const warnings = [...templated.warnings]
  for (const alternative of splitTop(templated.text, '||')) {
    const merged: string[] = []
    for (const segment of splitTop(alternative, '&&')) {
      const result = evaluateSegment(parseSegment(segment), doc)
      warnings.push(...result.warnings)
      merged.push(...result.values)
    }
    if (merged.some((value) => value.trim().length > 0)) return { values: merged, warnings }
  }
  return { values: [], warnings }
}

export function evaluateRuleFirst(rule: string, doc: RuleDocument, ctx: RuleContext): string {
  return evaluateRule(rule, doc, ctx).values[0]?.trim() ?? ''
}
