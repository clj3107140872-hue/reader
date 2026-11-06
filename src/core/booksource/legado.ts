import type { RejectedSource } from './model'
import type { SourceCompat } from './model'
import { findUnsupportedRule } from './rules'

export interface ParsedSource {
  definition: Record<string, unknown>
  name: string
  url: string
  group: string
  searchUrl: string
  header: Record<string, string>
  charset?: string
  customOrder: number
  /** 书源自带 enabled；缺省 true。 */
  enabled?: boolean
  compat: SourceCompat
  /** 解析时发现、但不影响导入的问题（例如 header 不是合法 JSON）。 */
  warnings?: string[]
}

export interface ParsedSourceBatch {
  sources: ParsedSource[]
  rejected: RejectedSource[]
  warnings: string[]
}

export type NormalizedSourceResult =
  | { ok: true; source: ParsedSource }
  | { ok: false; rejected: RejectedSource }

const REQUIRED = [
  ['bookSourceName', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['bookSourceUrl', (value: unknown) => typeof value === 'string' && /^https?:\/\//i.test(value)],
  ['searchUrl', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleSearch.bookList', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleSearch.name', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleSearch.bookUrl', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleToc.chapterList', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleToc.chapterName', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleToc.chapterUrl', (value: unknown) => typeof value === 'string' && value.trim() !== ''],
  ['ruleContent.content', (value: unknown) => typeof value === 'string' && value.trim() !== '']
] as const

function valueAt(definition: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object' || Array.isArray(current)) return undefined
    return (current as Record<string, unknown>)[key]
  }, definition)
}

export function parseHeader(value: unknown, warnings: string[]): Record<string, string> {
  if (value === undefined || value === null || value === '') return {}
  if (typeof value === 'object' && !Array.isArray(value)) {
    const headers: Record<string, string> = {}
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      if (typeof entry === 'string') headers[key] = entry
    }
    return headers
  }
  if (typeof value !== 'string') {
    warnings.push('header 不是 JSON 字符串，已忽略')
    return {}
  }
  try {
    const parsed = JSON.parse(value) as unknown
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      warnings.push('header 不是 JSON 对象，已忽略')
      return {}
    }
    const headers: Record<string, string> = {}
    for (const [key, entry] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof entry === 'string') headers[key] = entry
    }
    return headers
  } catch {
    warnings.push('header 不是合法 JSON，已忽略')
    return {}
  }
}

function scanUnsupported(definition: Record<string, unknown>): string[] {
  const issues: string[] = []
  const push = (issue: string): void => {
    if (!issues.includes(issue)) issues.push(issue)
  }
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const issue = findUnsupportedRule(value)
      if (issue) push(issue)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        // Login configuration lives in keys (loginUrl/loginUi/loginCheckJs), so
        // the string-leaf scan alone would miss it.
        if (/^login/i.test(key)) push(`不支持登录相关配置：${key}`)
        // A boolean webView flag has no rule text to inspect.
        if (/webview/i.test(key) && entry === true) push(`不支持 WebView 配置：${key}`)
        visit(entry)
      }
    }
  }
  visit(definition)
  return issues
}

export function normalizeSourceDefinition(
  definition: Record<string, unknown>
): NormalizedSourceResult {
  const warnings: string[] = []
  const missing = REQUIRED.filter(([path, valid]) => !valid(valueAt(definition, path))).map(
    ([path]) => path
  )
  if (missing.length > 0) {
    return {
      ok: false,
      rejected: {
        name: typeof definition.bookSourceName === 'string' ? definition.bookSourceName : undefined,
        url: typeof definition.bookSourceUrl === 'string' ? definition.bookSourceUrl : undefined,
        reason: `缺少必填字段：${missing.join('、')}`
      }
    }
  }

  const type = Number(definition.bookSourceType ?? 0)
  if (type !== 0) {
    return {
      ok: false,
      rejected: {
        name: String(definition.bookSourceName ?? ''),
        url: String(definition.bookSourceUrl ?? ''),
        reason: '只支持文字书源（bookSourceType=0）'
      }
    }
  }

  const url = String(definition.bookSourceUrl).trim()
  if (!/^https?:\/\//i.test(url)) {
    return {
      ok: false,
      rejected: { name: String(definition.bookSourceName ?? ''), url, reason: '书源地址必须是 http(s)' }
    }
  }

  const header = parseHeader(definition.header, warnings)
  const issues = scanUnsupported(definition)
  const compat: SourceCompat = {
    level: issues.length > 0 ? 'partial' : 'full',
    issues
  }
  return {
    ok: true,
    source: {
      definition,
      name: String(definition.bookSourceName).trim(),
      url,
      group: typeof definition.bookSourceGroup === 'string' ? definition.bookSourceGroup : '',
      searchUrl: String(definition.searchUrl).trim(),
      header,
      ...(typeof definition.charset === 'string' && definition.charset.trim()
        ? { charset: definition.charset.trim() }
        : {}),
      customOrder: Number.isFinite(Number(definition.customOrder))
        ? Number(definition.customOrder)
        : 0,
      enabled: typeof definition.enabled === 'boolean' ? definition.enabled : true,
      compat,
      ...(warnings.length > 0 ? { warnings } : {})
    }
  }
}

export function normalizeStoredSource(definition: Record<string, unknown>): ParsedSource {
  const result = normalizeSourceDefinition(definition)
  if (!result.ok) throw new Error(result.rejected.reason)
  return result.source
}

export function parseSourceValue(input: unknown): ParsedSourceBatch {
  const items = Array.isArray(input) ? input : [input]
  const sources: ParsedSource[] = []
  const rejected: RejectedSource[] = []
  const warnings: string[] = []
  const byUrl = new Map<string, number>()

  for (const item of items) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      rejected.push({ reason: '书源条目不是 JSON 对象' })
      continue
    }
    const result = normalizeSourceDefinition(item as Record<string, unknown>)
    if (!result.ok) {
      rejected.push(result.rejected)
      continue
    }
    for (const warning of result.source.warnings ?? []) {
      if (!warnings.includes(warning)) warnings.push(warning)
    }
    const existing = byUrl.get(result.source.url)
    if (existing !== undefined) {
      sources[existing] = result.source
    } else {
      byUrl.set(result.source.url, sources.length)
      sources.push(result.source)
    }
  }
  return { sources, rejected, warnings }
}

export function parseSourceJson(text: string): ParsedSourceBatch {
  const clean = text.replace(/^﻿/, '')
  let input: unknown
  try {
    input = JSON.parse(clean)
  } catch {
    throw new Error('书源 JSON 无法解析')
  }
  return parseSourceValue(input)
}

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.toString() : null
  } catch {
    return null
  }
}

/**
 * Resolves an import address to the http(s) JSON URL to download.
 *
 * Accepts plain http(s) links and the Legado share form
 * `legado://import/bookSource?src=<url>` (URL-decoded once). Every other
 * scheme, including file/data/ftp, is rejected.
 */
export function resolveSourceImportUrl(input: string): string {
  const value = input.trim()
  const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(value)?.[1]?.toLowerCase()
  if (!value || !protocol) throw new Error('书源地址无效')
  const direct = httpUrl(value)
  if (direct) return direct
  if (protocol !== 'legado') {
    throw new Error('只支持 http(s) 链接或 legado:// 分享链接')
  }
  let share: URL
  try {
    share = new URL(value)
  } catch {
    throw new Error('分享链接格式不正确')
  }
  if (share.hostname.toLowerCase() !== 'import' || share.pathname.toLowerCase() !== '/booksource') {
    throw new Error('只支持书源分享链接（legado://import/bookSource）')
  }
  const source = share.searchParams.get('src')?.trim()
  if (!source) throw new Error('分享链接缺少书源地址')
  const nested = httpUrl(source)
  if (!nested) throw new Error('分享链接里的地址必须是 http(s)')
  return nested
}
