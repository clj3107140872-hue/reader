# 网络书源 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让用户导入「阅读」书源 JSON，按书名搜索、加入书架、按需在线阅读并缓存，支持更新目录、下载全本、转本地书与书源管理。

**Architecture:** `core/booksource` 只做纯函数解析与规则求值；`main/services/network` 负责联网、并发、缓存与网络书生命周期；renderer 只通过类型化 IPC 调用。本地 TXT/EPUB 的 `book:open` 仍返回全部章节，网络书返回 `contentMode: 'lazy'`，阅读器只请求当前窗口章节。

**Tech Stack:** Electron 45、TypeScript、React 19、Vitest 5、cheerio、jsonpath-plus、iconv-lite、Node 内置 `fetch`。

**Spec:** [2026-11-06-network-book-source-design.md](../specs/2026-11-06-network-book-source-design.md)

**与 spec 的差异（已决定，验收时说明）：** v1 不下载网络封面（spec 7.6/11.2 的封面拉取推迟到 v1.1），书架与搜索结果的网络书用书名首字占位；其余按 spec 实现。

## Global Constraints

- 只允许 `http://` 与 `https://`；拒绝 `file:`、`data:`、`ftp:` 等协议。
- 拒绝 localhost、`127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`、`fe80::/10`；仅测试可设置 `READER_ALLOW_LOCAL_SOURCES=1` 放行 `127.0.0.1`。
- 每次请求：超时 10 秒；响应体上限 10 MB；最多 5 次重定向；GET 超时重试 1 次；4xx 不重试。
- 单章正文转文本后上限 2 MB；单书目录上限 20,000 章；`nextTocUrl` 最多 50 页；`nextContentUrl` 最多 20 页。
- 搜索并发 6、单书源超时 10 秒、每源最多 100 条；优质池默认 30 个（标星不截断）。
- 下载并发：每本书 2、同一书源 2、全局 4；读章全局 6；每本书读章 + 下载合计最多 2。
- 不执行书源 JS、不 `eval`、不 `new Function`、不加载 WebView；不内置、不推荐、不分享书源。
- Cookie 只存内存；日志不记录正文、关键词、请求头、Cookie；书源 JSON 里的凭据只存本地 `data/sources/sources.json`。
- 所有用户可见错误必须是中文，不能出现 Electron IPC 前缀或裸 Node 错误。
- 旧书目没有 `format` 时一律按 TXT 处理；本地书 `book:open` 仍一次性返回全部章节。
- 自动化验收必须离屏：`READER_ACCEPTANCE=1` + 临时数据目录，不触碰真实 `data/`，不打开可见窗口。
- 测试遵循全局规范：只测关键行为，测行为不测实现，不追覆盖率。

## Review Focus

- **不可信响应/URL**：超大响应、压缩炸弹、重定向到内网、坏字符集、非 HTML/JSON 响应都必须失败关闭，不能拖垮主进程或绕过地址校验。测试放在 Task 6 与 Task 17。
- **Legado 规则变体**：`URL,{options}` 内含逗号、`@json:`/`@css:`、`&&`/`||`、`##正则##`、缺失可选字段、相对 URL 必须按响应地址解析；partial 规则只让对应操作失败。测试放在 Task 2、3、7。
- **不完整网络书**：空缓存文件、书源删除/停用、目录新增/消失/重排、转本地时 `raw/` 缺失都必须可读且不丢进度。测试放在 Task 8、9、10、11。
- **并发与取消**：同章并发只请求一次、搜索取消、下载取消后续传、更新/下载/转本地互斥，不能出现旧事件覆盖新状态或半写缓存。测试放在 Task 7、9、10。
- **本地书回归**：没有 `format` 的旧书、eager 加载、重洗/重切/合并/换编码路径不能被网络分支改坏。测试放在 Task 11、17。

---

### Task 1: 基础类型、依赖与设置

**Files:**
- Modify: `package.json`
- Modify: `src/core/model.ts`
- Create: `src/core/booksource/model.ts`
- Modify: `src/shared/settings.ts`
- Modify: `src/shared/api.ts`（只加类型，不接 IPC）
- Modify: `src/main/services/reader.ts`（仅补 `contentMode`/`cachedChapters` 字段）
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: 现有 `AppSettings`、`LibraryEntry`、`BookMeta`。
- Produces: `BookFormat = 'txt' | 'epub' | 'network'`；`NetworkBookInfo`；`SourceListItem`、`StoredSource`、`SourceStats`、`NetworkSearchItem`、`NetworkSearchGroup`、`ImportSourcesResult`、`UpdateTocResult`、`DownloadDone`；`AppSettings.network`；`NetworkSearchRequest`、`NetworkChapterPayload`。

- [ ] **Step 1: 安装依赖并确认类型可用**

Run:
```bash
npm install cheerio@1.0.0 jsonpath-plus@10.2.0
npx tsc --noEmit
```
Expected: 安装成功；`tsc` 仍通过（此时还没引用新库）。

如果 npm 官方源 TLS 失败，重试一次；仍失败则用 `npm install --registry=https://registry.npmmirror.com cheerio@1.0.0 jsonpath-plus@10.2.0`，并在提交说明里记录。

- [ ] **Step 2: 扩展核心模型**

在 `src/core/model.ts` 中把 `BookFormat` 改为：

```ts
export type BookFormat = 'txt' | 'epub' | 'network'
export type DownloadState = 'none' | 'partial' | 'complete'

export interface NetworkBookInfo {
  sourceId: string
  /** 用于书源删除后按 URL 重新关联。 */
  sourceUrl: string
  /** 快照，书源删除后仍能显示。 */
  sourceName: string
  bookUrl: string
  tocUrl: string
  lastChapter?: string
  lastTocAt: string | null
  lastCheckAt: string | null
  lastDownloadAt?: string | null
}
```

在 `ChapterMeta` 增加：

```ts
  /** 网络章节地址；本地章节没有该字段。 */
  url?: string
```

`BookMeta` 和 `LibraryEntry` 本来就有 `format?: BookFormat` 字段，Step 2 只需把上面的 `BookFormat` 联合类型从两值改成三值；不要再往接口里加一遍 `format`（重复声明会编译报错）。

在 `BookMeta` 增加：

```ts
  intro?: string
  kind?: string
  network?: NetworkBookInfo
```

在 `LibraryEntry` 增加：

```ts
  intro?: string
  kind?: string
  /** 网络书当前绑定的书源；来源删除后用于显示「书源已删除」。 */
  sourceId?: string
  sourceName?: string
  networkCache?: { cached: number; total: number }
  downloadState?: DownloadState
  lastUpdateAt?: string
```

在 `AppSettings` 增加：

```ts
  network: {
    enabled: boolean
    autoCheckOnOpen: boolean
  }
```

- [ ] **Step 3: 创建书源/搜索结果类型**

新建 `src/core/booksource/model.ts`：

```ts
import type { ChapterLevel } from '../model'

export type SourceCompatLevel = 'full' | 'partial'

export interface SourceCompat {
  level: SourceCompatLevel
  issues: string[]
}

export interface StoredSource {
  id: string
  definition: Record<string, unknown>
  enabled: boolean
  starred: boolean
  blacklisted: boolean
  compat: SourceCompat
  importedAt: string
  updatedAt: string
}

export interface SourceListItem {
  id: string
  name: string
  url: string
  group: string
  enabled: boolean
  starred: boolean
  blacklisted: boolean
  compat: SourceCompat
  score: number
  searchSuccessRate: number
  avgMs: number
  importedAt: string
  customOrder: number
  /** 已加入书架、仍指向该来源的网络书数量；由 SourceService 填充。 */
  bookCount?: number
  lastError?: { operation: string; message: string; at: string }
}

export interface OperationStats {
  attempts: number
  successes: number
  empties: number
  errors: number
  totalMs: number
}

export interface SourceStats {
  search: OperationStats
  info: OperationStats
  toc: OperationStats
  content: OperationStats
  score: number
  lastError?: { operation: string; message: string; at: string }
  lastUsedAt: string | null
}

export interface StatsFile {
  version: 1
  bySource: Record<string, SourceStats>
}

export interface SourcesFile {
  version: 1
  sources: StoredSource[]
}

export interface NetworkSearchItem {
  sourceId: string
  sourceName: string
  title: string
  author: string
  intro?: string
  kind?: string
  coverUrl?: string
  bookUrl: string
  lastChapter?: string
  qualityScore: number
  starred: boolean
  inShelf: boolean
  /** 组内最佳来源排序用的内部字段，不展示。 */
  avgMs?: number
  importedAt?: string
}

export interface NetworkSearchGroup {
  key: string
  title: string
  author: string
  items: NetworkSearchItem[]
  bestSourceId: string
}

export interface RejectedSource {
  name?: string
  url?: string
  reason: string
}

export interface ImportSourcesResult {
  added: number
  updated: number
  rejected: RejectedSource[]
  warnings: string[]
}

export interface TocChapter {
  title: string
  url: string
  level: ChapterLevel
}

export interface UpdateTocResult {
  added: number
  total: number
  warnings: string[]
  lastChapter?: string
}

export interface DownloadFailedChapter {
  index: number
  title: string
  message: string
}

export interface DownloadProgress {
  bookId: string
  done: number
  total: number
  failed: number
}

export interface DownloadDone {
  bookId: string
  done: number
  total: number
  failedChapters: DownloadFailedChapter[]
  cancelled: boolean
}
```

- [ ] **Step 4: 设置默认值与归一化**

在 `src/shared/settings.ts` 的 `DEFAULT_SETTINGS` 增加：

```ts
  network: { enabled: true, autoCheckOnOpen: true },
```

在 `SettingsPatch` 增加：

```ts
  network?: Partial<AppSettings['network']>
```

在 `normalizeSettings` 的返回值增加：

```ts
    network: {
      enabled:
        typeof (raw.network as AppSettings['network'] | undefined)?.enabled === 'boolean'
          ? (raw.network as AppSettings['network']).enabled
          : DEFAULT_SETTINGS.network.enabled,
      autoCheckOnOpen:
        typeof (raw.network as AppSettings['network'] | undefined)?.autoCheckOnOpen === 'boolean'
          ? (raw.network as AppSettings['network']).autoCheckOnOpen
          : DEFAULT_SETTINGS.network.autoCheckOnOpen
    },
```

在 `mergeSettings` 的 `normalizeSettings({...})` 参数里增加：

```ts
    network: { ...base.network, ...patch.network },
```

- [ ] **Step 5: 增加共享 IPC 类型（先不实现）**

在 `src/shared/api.ts` 增加导入和类型：

```ts
import type {
  DownloadDone,
  DownloadProgress,
  ImportSourcesResult,
  NetworkSearchGroup,
  NetworkSearchItem,
  SourceListItem,
  UpdateTocResult
} from '../core/booksource/model'

export type SourceImportRequest =
  | { kind: 'file'; dryRun?: boolean }
  | { kind: 'json'; json: string; dryRun?: boolean }
  | { kind: 'url'; url: string; dryRun?: boolean }

export interface NetworkSearchRequest {
  requestId: string
  keyword: string
  scope: 'quality' | 'all'
}

export interface NetworkSearchSourceEvent {
  requestId: string
  sourceId: string
  sourceName: string
  status: 'success' | 'empty' | 'error'
  count: number
  ms: number
  message?: string
}

export interface NetworkSearchPayload {
  requestId: string
  groups: NetworkSearchGroup[]
  searched: number
  succeeded: number
  empty: number
  failed: number
  remaining: number
  scope: 'quality' | 'all'
}

export interface NetworkSearchDone {
  requestId: string
  cancelled: boolean
  searched: number
  succeeded: number
  empty: number
  failed: number
  groups: NetworkSearchGroup[]
}

export interface AddNetworkBookInput {
  sourceId: string
  bookUrl: string
  title?: string
  author?: string
}

export interface NetworkChapterPayload {
  text: string
  cached: boolean
}

export interface ConvertToLocalResult {
  id: string
  chapterCount: number
  warnings: string[]
}
```

把 `OpenBookPayload` 整体改为：

```ts
export interface OpenBookPayload {
  meta: BookMeta
  contentMode: 'eager' | 'lazy'
  /** 本地书：全部章节；网络书：[]。 */
  chapters: string[]
  /** 网络书：已缓存章节索引；本地书：[]。 */
  cachedChapters: number[]
  /** User-visible notes about chapters that had to be rebuilt or replaced. */
  warnings: string[]
  progress: BookProgress | null
  bookmarks: Bookmark[]
}
```

`ReaderApi` 的新方法留到 Task 12 再加，避免 Task 1 结束时 preload 不满足接口导致 `tsc` 失败。

同一步把 `src/main/services/reader.ts` 的现有返回值补上两个字段（网络分支在 Task 11 加）：

```ts
    return {
      meta,
      contentMode: 'eager',
      chapters,
      cachedChapters: [],
      warnings,
      progress: stored.progress,
      bookmarks: stored.bookmarks
    }
```


- [ ] **Step 6: 测试设置兼容**

在 `tests/settings.test.ts` 增加：

```ts
it('adds network defaults for old settings and preserves explicit values', () => {
  const old = normalizeSettings({ theme: 'green' })
  expect(old.network).toEqual({ enabled: true, autoCheckOnOpen: true })

  const off = normalizeSettings({ network: { enabled: false, autoCheckOnOpen: false } })
  expect(off.network).toEqual({ enabled: false, autoCheckOnOpen: false })
})
```

如果该测试文件没有导入 `normalizeSettings`，补上导入。

- [ ] **Step 7: 运行测试并提交**

Run: `npx vitest run tests/settings.test.ts && npx tsc --noEmit`
Expected: PASS。Task 1 只加数据结构和设置，不往 `ReaderApi` 加方法，因此 preload 仍然满足接口；`ReaderService.open()` 是 `OpenBookPayload` 的唯一构造点，Step 5 已补上 `contentMode: 'eager'` 与 `cachedChapters: []`，所以这里 `tsc` 能过。

```bash
git add package.json package-lock.json src/core/model.ts src/core/booksource/model.ts src/shared/settings.ts src/shared/api.ts tests/settings.test.ts
git commit -m "feat(network): add book source types and settings"
```

---

### Task 2: 规则求值与 HTML 转文本

**Files:**
- Create: `src/core/booksource/rules.ts`
- Create: `src/core/booksource/html.ts`
- Test: `tests/booksource-rules.test.ts`

**Interfaces:**
- Consumes: `cheerio`、`jsonpath-plus`。
- Produces: `RuleContext`、`RuleDocument`、`evaluateRule()`、`evaluateRuleFirst()`、`applyTemplate()`、`parseUrlOptions()`、`findUnsupportedRule()`、`htmlToParagraphs()`、`htmlToText()`。

- [ ] **Step 1: 写失败测试**

```ts
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
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/booksource-rules.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `rules.ts`**

```ts
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
  const URL_VARIABLES = new Set(['baseUrl', 'bookUrl', 'chapterUrl'])
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

function parseSegment(raw: string): SegmentParts {
  let selector = raw.trim()
  const parts = selector.split('##')
  let pattern: string | undefined
  let replacement: string | undefined
  let onlyFirst = false
  if (parts.length >= 3) {
    selector = parts[0]
    pattern = parts[1]
    replacement = parts[2] ?? ''
    if (replacement.endsWith('###')) {
      onlyFirst = true
      replacement = replacement.slice(0, -3)
    }
  }
  const suffixMatch = SUFFIX_RE.exec(selector)
  const suffix = suffixMatch ? suffixMatch[1].toLowerCase() : 'text'
  if (suffixMatch) selector = selector.slice(0, suffixMatch.index)
  const indexMatch = /\.(-?\d+)$/.exec(selector)
  const index = indexMatch ? Number(indexMatch[1]) : null
  if (indexMatch) selector = selector.slice(0, indexMatch.index)
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
  const $ = load(doc.html)
  const nodes = selector ? $(selector) : $.root()
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
    if (merged.length > 0) return { values: merged, warnings }
  }
  return { values: [], warnings }
}

export function evaluateRuleFirst(rule: string, doc: RuleDocument, ctx: RuleContext): string {
  return evaluateRule(rule, doc, ctx).values[0]?.trim() ?? ''
}
```

- [ ] **Step 4: 实现 `html.ts`**

```ts
import { load } from 'cheerio'

const BLOCK_TAGS = [
  'p', 'div', 'section', 'article', 'li', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4',
  'h5', 'h6', 'blockquote', 'pre', 'tr', 'table'
].join(',')

/** Converts an HTML fragment to trimmed, non-empty paragraphs. */
export function htmlToParagraphs(html: string): string[] {
  const $ = load(`<div id="__root__">${html}</div>`)
  const root = $('#__root__')
  root.find('script,style,iframe,noscript,svg,canvas').remove()
  root.find('br').replaceWith('\n')
  root.find(BLOCK_TAGS).each((_index, node) => {
    $(node).append('\n')
  })
  return root
    .text()
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .filter(Boolean)
}

export function htmlToText(html: string): string {
  return htmlToParagraphs(html).join('\n\n')
}
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/booksource-rules.test.ts`
Expected: PASS。若模板 URL 编码断言因 `encodeURIComponent` 对 `/` 的编码不一致失败，按实际 `encodeURIComponent` 结果修正测试期望，不要放宽实现。

- [ ] **Step 6: 提交**

```bash
git add src/core/booksource/rules.ts src/core/booksource/html.ts tests/booksource-rules.test.ts
git commit -m "feat(network): add legado rule evaluator and html text conversion"
```

---

### Task 3: Legado 书源解析、校验与兼容状态

**Files:**
- Create: `src/core/booksource/legado.ts`
- Test: `tests/booksource-legado.test.ts`

**Interfaces:**
- Consumes: `findUnsupportedRule()`（Task 2）。
- Produces: `ParsedSource`、`ParsedSourceBatch`、`parseSourceJson()`、`parseSourceValue()`、`normalizeSourceDefinition()`、`normalizeStoredSource()`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import {
  normalizeSourceDefinition,
  parseSourceJson,
  parseSourceValue
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
    const xpath = normalizeSourceDefinition(raw({ ruleToc: { chapterList: '@xpath://a' } }))
    expect(xpath.ok).toBe(true)
    if (xpath.ok) expect(xpath.source.compat.issues.join('')).toContain('XPath')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/booksource-legado.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `legado.ts`**

```ts
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

function parseHeader(value: unknown, warnings: string[]): Record<string, string> {
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
  const visit = (value: unknown): void => {
    if (typeof value === 'string') {
      const issue = findUnsupportedRule(value)
      if (issue && !issues.includes(issue)) issues.push(issue)
      return
    }
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    if (value && typeof value === 'object') {
      Object.values(value as Record<string, unknown>).forEach(visit)
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
```

`ParsedSource` 上有 `warnings?: string[]`（header 不是合法 JSON 等非致命问题写在这里，`compat.level` 不受影响），`parseSourceValue` 在成功分支把 `result.source.warnings` 去重汇总进批次 `ParsedSourceBatch.warnings`。测试里 header 非法时断言 `compat.level === 'full'` 且批次 `warnings` 非空。

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/booksource-legado.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/core/booksource/legado.ts tests/booksource-legado.test.ts
git commit -m "feat(network): parse and validate legado book sources"
```

---

### Task 4: 搜索结果合并、质量分与目录增量

**Files:**
- Create: `src/core/booksource/searchResults.ts`
- Create: `src/core/booksource/quality.ts`
- Create: `src/core/booksource/toc.ts`
- Test: `tests/booksource-quality.test.ts`

**Interfaces:**
- Consumes: `NetworkSearchItem`、`SourceListItem`、`SourceStats`、`ChapterMeta`、`chapterTitleHash()`。
- Produces: `normalizeSearchTitle()`、`normalizeSearchAuthor()`、`mergeSearchResults()`、`computeScore()`、`selectQualitySources()`、`downloadState()`、`networkCacheFor()`、`diffToc()`。

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import type { SourceListItem, SourceStats } from '../src/core/booksource/model'
import { computeScore, downloadState, selectQualitySources } from '../src/core/booksource/quality'
import { mergeSearchResults } from '../src/core/booksource/searchResults'
import { diffToc } from '../src/core/booksource/toc'
import type { ChapterMeta } from '../src/core/model'

function stats(partial: Partial<SourceStats> = {}): SourceStats {
  return {
    search: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    info: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    toc: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    content: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    score: 0,
    lastUsedAt: null,
    ...partial
  }
}

function source(id: string, overrides: Partial<SourceListItem> = {}): SourceListItem {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    group: '',
    enabled: true,
    starred: false,
    blacklisted: false,
    compat: { level: 'full', issues: [] },
    score: 60,
    searchSuccessRate: 0,
    avgMs: 0,
    importedAt: '2026-01-01T00:00:00.000Z',
    customOrder: 0,
    ...overrides
  }
}

describe('quality and search grouping', () => {
  it('uses initial scores and penalises partial sources after stats exist', () => {
    expect(computeScore(stats(), { level: 'full', issues: [] })).toBe(60)
    expect(computeScore(stats(), { level: 'partial', issues: ['JS'] })).toBe(40)
    const perfect = computeScore(
      stats({
        search: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 },
        toc: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 },
        content: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 }
      }),
      { level: 'full', issues: [] }
    )
    expect(perfect).toBe(100)
  })

  it('puts all starred sources in the pool and fills to 30', () => {
    const list = [
      ...Array.from({ length: 35 }, (_, i) => source(`s${i}`, { score: 90 - i })),
      source('starred', { starred: true, score: 1 })
    ]
    const pool = selectQualitySources(list)
    expect(pool).toHaveLength(30)
    expect(pool[0].id).toBe('starred')
    expect(pool.some((item) => item.id === 's29')).toBe(false)
  })

  it('groups by normalized title and author and picks the best source', () => {
    const groups = mergeSearchResults([
      { sourceId: 'a', sourceName: 'A', title: ' 斗破  苍穹 ', author: '天蚕土豆', bookUrl: 'u1', qualityScore: 70, starred: false, inShelf: false, avgMs: 100, importedAt: '2026-01-01' },
      { sourceId: 'b', sourceName: 'B', title: '斗破 苍穹', author: '天蚕土豆', bookUrl: 'u2', qualityScore: 80, starred: false, inShelf: false, avgMs: 200, importedAt: '2026-01-02' },
      { sourceId: 'c', sourceName: 'C', title: '斗破苍穹', author: '别人', bookUrl: 'u3', qualityScore: 99, starred: true, inShelf: false, avgMs: 50, importedAt: '2026-01-03' }
    ])
    expect(groups).toHaveLength(2)
    const group = groups.find((item) => item.author === '天蚕土豆')!
    expect(group.bestSourceId).toBe('b')
    expect(group.items).toHaveLength(2)
  })

  it('computes download states and appends toc chapters without reordering', () => {
    expect(downloadState(0, 0)).toBe('complete')
    expect(downloadState(0, 3)).toBe('none')
    expect(downloadState(1, 3)).toBe('partial')
    expect(downloadState(3, 3)).toBe('complete')

    const existing: ChapterMeta[] = [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'a', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'u1' }
    ]
    const result = diffToc(existing, [
      { title: '第一章 新标题', url: 'u1', level: 'chapter' },
      { title: '第二章', url: 'u2', level: 'chapter' }
    ])
    expect(result.added).toBe(1)
    expect(result.chapters[0].index).toBe(0)
    expect(result.chapters[0].title).toBe('第一章 新标题')
    expect(result.chapters[1].index).toBe(1)
    expect(result.chapters[1].url).toBe('u2')

    // A chapter that disappeared from the toc stays in place so its cached
    // text and index do not become orphaned.
    const shrunk = diffToc(existing, [{ title: '第三章', url: 'u3', level: 'chapter' }])
    expect(shrunk.chapters[0].url).toBe('u1')
    expect(shrunk.chapters[1].url).toBe('u3')
    expect(shrunk.added).toBe(1)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/booksource-quality.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `searchResults.ts`**

```ts
import type { NetworkSearchGroup, NetworkSearchItem } from './model'

export function normalizeSearchTitle(value: string): string {
  return value
    .trim()
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function normalizeSearchAuthor(value: string): string {
  return normalizeSearchTitle(value)
}

export function searchGroupKey(title: string, author: string): string {
  return `${normalizeSearchTitle(title)}|${normalizeSearchAuthor(author)}`
}

function compareItems(a: NetworkSearchItem, b: NetworkSearchItem): number {
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore
  const avg = (a.avgMs ?? Number.MAX_SAFE_INTEGER) - (b.avgMs ?? Number.MAX_SAFE_INTEGER)
  if (avg !== 0) return avg
  return (a.importedAt ?? '').localeCompare(b.importedAt ?? '')
}

export function mergeSearchResults(items: NetworkSearchItem[]): NetworkSearchGroup[] {
  const groups = new Map<string, NetworkSearchItem[]>()
  for (const item of items) {
    const key = searchGroupKey(item.title, item.author)
    const list = groups.get(key) ?? []
    if (!list.some((existing) => existing.sourceId === item.sourceId)) list.push(item)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(compareItems)
      return {
        key,
        title: sorted[0].title,
        author: sorted[0].author,
        items: sorted,
        bestSourceId: sorted[0].sourceId
      }
    })
    .sort((a, b) => compareItems(a.items[0], b.items[0]))
}
```

- [ ] **Step 4: 实现 `quality.ts`**

```ts
import type { ChapterMeta, DownloadState } from '../model'
import type { OperationStats, SourceCompat, SourceListItem, SourceStats } from './model'

export const QUALITY_POOL_SIZE = 30

export function emptyOperationStats(): OperationStats {
  return { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 }
}

export function emptySourceStats(): SourceStats {
  return {
    search: emptyOperationStats(),
    info: emptyOperationStats(),
    toc: emptyOperationStats(),
    content: emptyOperationStats(),
    score: 0,
    lastUsedAt: null
  }
}

export function computeScore(stats: SourceStats, compat: SourceCompat): number {
  const hasAttempts =
    stats.search.attempts > 0 || stats.toc.attempts > 0 || stats.content.attempts > 0
  if (!hasAttempts) return compat.level === 'full' ? 60 : 40

  const searchRate =
    (stats.search.successes + 0.5 * stats.search.empties) / Math.max(1, stats.search.attempts)
  const tocRate = stats.toc.attempts > 0
    ? stats.toc.successes / stats.toc.attempts
    : 0.5
  const contentRate = stats.content.attempts > 0
    ? stats.content.successes / stats.content.attempts
    : 0.5
  const avgMs = stats.search.attempts > 0 ? stats.search.totalMs / stats.search.attempts : 0
  const speedScore = stats.search.attempts > 0 ? 1 - Math.min(avgMs / 10000, 1) : 0.5
  const raw = 35 * searchRate + 20 * tocRate + 30 * contentRate + 15 * speedScore
  const penalty = compat.level === 'partial' ? 10 : 0
  return Math.round(Math.max(0, Math.min(100, raw - penalty)) * 10) / 10
}

function compareSources(a: SourceListItem, b: SourceListItem): number {
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  if (a.score !== b.score) return b.score - a.score
  if (a.customOrder !== b.customOrder) return a.customOrder - b.customOrder
  return a.importedAt.localeCompare(b.importedAt)
}

export function selectQualitySources(sources: SourceListItem[]): SourceListItem[] {
  const candidates = sources.filter((source) => source.enabled && !source.blacklisted)
  const starred = candidates.filter((source) => source.starred).sort(compareSources)
  const normal = candidates
    .filter((source) => !source.starred)
    .sort(compareSources)
    .slice(0, Math.max(0, QUALITY_POOL_SIZE - starred.length))
  return [...starred, ...normal]
}

export function downloadState(cached: number, total: number): DownloadState {
  if (total <= 0 || cached >= total) return 'complete'
  return cached > 0 ? 'partial' : 'none'
}

export function networkCacheFor(
  chapters: ChapterMeta[],
  cached: Set<number>
): { cached: number; total: number } {
  const withUrl = chapters.filter((chapter) => chapter.level !== 'volume' && chapter.url)
  return {
    cached: withUrl.filter((chapter) => cached.has(chapter.index)).length,
    total: withUrl.length
  }
}
```

- [ ] **Step 5: 实现 `toc.ts`**

```ts
import type { ChapterMeta } from '../model'
import { chapterTitleHash } from '../chapters'
import type { TocChapter } from './model'

export interface TocDiffResult {
  chapters: ChapterMeta[]
  added: number
  updated: number
  lastChapter?: string
}

export function diffToc(existing: ChapterMeta[], incoming: TocChapter[]): TocDiffResult {
  const chapters = existing.map((chapter) => ({ ...chapter }))
  const used = new Set<number>()
  let added = 0
  let updated = 0

  for (const entry of incoming) {
    let index = entry.url
      ? chapters.findIndex((chapter, i) => !used.has(i) && chapter.url === entry.url)
      : -1
    if (index < 0) {
      const hash = chapterTitleHash(entry.title)
      index = chapters.findIndex((chapter, i) => !used.has(i) && chapter.titleHash === hash)
    }
    if (index >= 0) {
      used.add(index)
      const chapter = chapters[index]
      const nextHash = chapterTitleHash(entry.title)
      if (chapter.title !== entry.title || chapter.url !== entry.url) updated++
      chapter.title = entry.title
      chapter.url = entry.url || chapter.url
      chapter.level = entry.level
      chapter.titleHash = nextHash
      continue
    }
    const chapter: ChapterMeta = {
      index: chapters.length,
      title: entry.title,
      level: entry.level,
      titleHash: chapterTitleHash(entry.title),
      startLine: 0,
      charCount: 0,
      simhash: '',
      flags: {},
      ...(entry.url ? { url: entry.url } : {})
    }
    chapters.push(chapter)
    used.add(chapter.index)
    added++
  }

  const last = [...incoming].reverse().find((entry) => entry.level !== 'volume')
  return {
    chapters,
    added,
    updated,
    ...(last ? { lastChapter: last.title } : {})
  }
}
```

- [ ] **Step 6: 运行测试并提交**

Run: `npx vitest run tests/booksource-quality.test.ts`
Expected: PASS。

```bash
git add src/core/booksource/searchResults.ts src/core/booksource/quality.ts src/core/booksource/toc.ts tests/booksource-quality.test.ts
git commit -m "feat(network): merge search results and score sources"
```

---

### Task 5: 书源/统计存储与网络书文件仓库

**Files:**
- Create: `src/main/services/network/sourceStore.ts`
- Create: `src/main/storage/networkBook.ts`
- Test: `tests/network-storage.test.ts`

**Interfaces:**
- Consumes: `ParsedSource`、`SourceListItem`、`SourceStats`、`computeScore()`。
- Produces: `SourceStore`（`listStored`、`listItems`、`importParsed`、`setFlags`、`raw`、`remove`、`record`、`flush`、`repair`、`get`）；`NetworkBookRepository`（`create`、`writeMeta`、`listCachedChapters`、`readChapterText`、`readRawChapter`、`writeChapter`）。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import type { ParsedSource } from '../src/core/booksource/legado'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-network-store-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

function parsed(url = 'https://example.com', name = '源A'): ParsedSource {
  return {
    definition: {
      bookSourceName: name,
      bookSourceUrl: url,
      searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.b', name: '.n', bookUrl: '.l@href' },
      ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
      ruleContent: { content: '#c' }
    },
    name,
    url,
    group: '',
    searchUrl: '/s?q={{key}}',
    header: {},
    customOrder: 0,
    compat: { level: 'full', issues: [] }
  }
}

describe('SourceStore', () => {
  it('imports new sources, updates by URL and keeps flags', async () => {
    const store = new SourceStore(root)
    expect(await store.importParsed([parsed()])).toMatchObject({ added: 1, updated: 0 })
    const [first] = await store.listStored()
    await store.setFlags(first.id, { starred: true })
    expect(await store.importParsed([parsed('https://example.com', '源A2')]))
      .toMatchObject({ added: 0, updated: 1 })
    const [updated] = await store.listStored()
    expect(updated.id).toBe(first.id)
    expect(updated.starred).toBe(true)
    expect((updated.definition as { bookSourceName: string }).bookSourceName).toBe('源A2')
  })

  it('falls back to .bak when sources.json is corrupt', async () => {
    const store = new SourceStore(root)
    await store.importParsed([parsed()])
    await writeFile(join(root, 'sources', 'sources.json'), '{bad', 'utf8')
    expect((await store.listStored()).map((source) => source.name)).toEqual(['源A'])
  })

  it('records stats and flushes them', async () => {
    const store = new SourceStore(root)
    const [source] = (await store.importParsed([parsed()]), await store.listStored())
    await store.record(source.id, 'search', 'success', 120)
    await store.flush()
    const text = await readFile(join(root, 'sources', 'stats.json'), 'utf8')
    expect(text).toContain('"successes": 1')
  })
})

describe('NetworkBookRepository', () => {
  it('creates meta, writes raw and cleaned chapters, and lists only non-empty caches', async () => {
    const repo = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const,
      id: 'book-1',
      title: '书',
      encoding: 'utf-8',
      format: 'network' as const,
      chapters: [],
      createdAt: '2026-01-01T00:00:00.000Z'
    }
    await repo.create(meta)
    await repo.writeChapter('book-1', 0, '原始正文', '清洗正文')
    expect(await repo.readRawChapter('book-1', 0)).toBe('原始正文')
    expect(await repo.readChapterText('book-1', 0)).toBe('清洗正文')
    expect(await repo.listCachedChapters('book-1')).toEqual([0])
    await repo.writeChapter('book-1', 1, '', '')
    expect(await repo.listCachedChapters('book-1')).toEqual([0])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/network-storage.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `sourceStore.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import type {
  ImportSourcesResult,
  SourceListItem,
  SourceStats,
  SourcesFile,
  StatsFile,
  StoredSource
} from '../../../core/booksource/model'
import { computeScore, emptySourceStats } from '../../../core/booksource/quality'
import type { ParsedSource } from '../../../core/booksource/legado'
import { atomicWriteJson, readJson } from '../../storage/fsUtil'
import { Mutex } from '../../storage/mutex'

export type SourceOperation = 'search' | 'info' | 'toc' | 'content'
export type OperationOutcome = 'success' | 'empty' | 'error'

export class SourceStore {
  private readonly mutex = new Mutex()
  private statsCache: StatsFile | null = null
  private statsTimer: NodeJS.Timeout | null = null

  constructor(private readonly root: string) {}

  private get sourcesFile(): string { return join(this.root, 'sources', 'sources.json') }
  private get statsFile(): string { return join(this.root, 'sources', 'stats.json') }

  async repair(): Promise<boolean> {
    return this.mutex.runExclusive(async () => {
      const main = await readJson<SourcesFile>(this.sourcesFile)
      if (main?.version === 1 && Array.isArray(main.sources)) return false
      const backup = await readJson<SourcesFile>(`${this.sourcesFile}.bak`)
      if (!backup?.version || !Array.isArray(backup.sources)) return false
      await atomicWriteJson(this.sourcesFile, backup, false)
      return true
    })
  }

  async read(): Promise<SourcesFile> {
    const main = await readJson<SourcesFile>(this.sourcesFile)
    if (main?.version === 1 && Array.isArray(main.sources)) return main
    const backup = await readJson<SourcesFile>(`${this.sourcesFile}.bak`)
    return backup?.version === 1 && Array.isArray(backup.sources)
      ? backup
      : { version: 1, sources: [] }
  }

  async listStored(): Promise<StoredSource[]> {
    return (await this.read()).sources
  }

  async get(id: string): Promise<StoredSource | null> {
    return (await this.read()).sources.find((source) => source.id === id) ?? null
  }

  async listItems(): Promise<SourceListItem[]> {
    const stats = await this.readStats()
    return (await this.listStored()).map((stored) => this.toItem(stored, stats.bySource[stored.id]))
  }

  private toItem(stored: StoredSource, stats?: SourceStats): SourceListItem {
    const value = stats ?? emptySourceStats()
    const score = computeScore(value, stored.compat)
    const attempts = value.search.attempts
    const definition = stored.definition as Record<string, unknown>
    return {
      id: stored.id,
      name: String(definition.bookSourceName ?? '未命名书源'),
      url: String(definition.bookSourceUrl ?? ''),
      group: typeof definition.bookSourceGroup === 'string' ? definition.bookSourceGroup : '',
      enabled: stored.enabled,
      starred: stored.starred,
      blacklisted: stored.blacklisted,
      compat: stored.compat,
      score,
      searchSuccessRate: attempts > 0 ? value.search.successes / attempts : 0,
      avgMs: attempts > 0 ? Math.round(value.search.totalMs / attempts) : 0,
      importedAt: stored.importedAt,
      customOrder: Number.isFinite(Number(definition.customOrder)) ? Number(definition.customOrder) : 0,
      ...(value.lastError ? { lastError: value.lastError } : {})
    }
  }

  async importParsed(sources: ParsedSource[]): Promise<ImportSourcesResult> {
    return this.mutex.runExclusive(async () => {
      const file = await this.read()
      const byUrl = new Map(file.sources.map((source, index) => [String((source.definition as Record<string, unknown>).bookSourceUrl), index]))
      let added = 0
      let updated = 0
      const now = new Date().toISOString()
      for (const parsed of sources) {
        const index = byUrl.get(parsed.url)
        if (index !== undefined) {
          const old = file.sources[index]
          file.sources[index] = {
            ...old,
            definition: parsed.definition,
            compat: parsed.compat,
            updatedAt: now
          }
          updated++
        } else {
          file.sources.push({
            id: randomUUID(),
            definition: parsed.definition,
            enabled: true,
            starred: false,
            blacklisted: false,
            compat: parsed.compat,
            importedAt: now,
            updatedAt: now
          })
          added++
        }
      }
      await atomicWriteJson(this.sourcesFile, file)
      return { added, updated, rejected: [], warnings: [] }
    })
  }

  async setFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<void> {
    await this.mutex.runExclusive(async () => {
      const file = await this.read()
      const source = file.sources.find((item) => item.id === id)
      if (!source) throw new Error('找不到这个书源')
      if (typeof flags.enabled === 'boolean') source.enabled = flags.enabled
      if (typeof flags.starred === 'boolean') source.starred = flags.starred
      if (typeof flags.blacklisted === 'boolean') source.blacklisted = flags.blacklisted
      source.updatedAt = new Date().toISOString()
      await atomicWriteJson(this.sourcesFile, file)
    })
  }

  async raw(id: string): Promise<Record<string, unknown> | null> {
    return (await this.get(id))?.definition ?? null
  }

  async remove(id: string): Promise<StoredSource | null> {
    return this.mutex.runExclusive(async () => {
      const file = await this.read()
      const source = file.sources.find((item) => item.id === id) ?? null
      if (!source) return null
      file.sources = file.sources.filter((item) => item.id !== id)
      await atomicWriteJson(this.sourcesFile, file)
      const stats = await this.readStats()
      delete stats.bySource[id]
      await atomicWriteJson(this.statsFile, stats)
      return source
    })
  }

  private async readStats(): Promise<StatsFile> {
    if (this.statsCache) return this.statsCache
    const stored = await readJson<StatsFile>(this.statsFile)
    this.statsCache =
      stored?.version === 1 && stored.bySource && typeof stored.bySource === 'object'
        ? stored
        : { version: 1, bySource: {} }
    return this.statsCache
  }

  async record(
    sourceId: string,
    operation: SourceOperation,
    outcome: OperationOutcome,
    ms: number,
    message?: string
  ): Promise<void> {
    const stats = await this.readStats()
    const value = (stats.bySource[sourceId] ??= emptySourceStats())
    const target = value[operation]
    target.attempts++
    target.totalMs += Math.max(0, Math.round(ms))
    if (outcome === 'success') target.successes++
    else if (outcome === 'empty') target.empties++
    else target.errors++
    value.lastUsedAt = new Date().toISOString()
    if (outcome === 'error' && message) {
      value.lastError = { operation, message, at: value.lastUsedAt }
    }
    const stored = await this.get(sourceId)
    if (stored) value.score = computeScore(value, stored.compat)
    this.scheduleStatsFlush()
  }

  private scheduleStatsFlush(): void {
    if (this.statsTimer) clearTimeout(this.statsTimer)
    this.statsTimer = setTimeout(() => {
      this.statsTimer = null
      void this.flush()
    }, 2000)
    this.statsTimer.unref?.()
  }

  async flush(): Promise<void> {
    if (!this.statsCache) return
    if (this.statsTimer) {
      clearTimeout(this.statsTimer)
      this.statsTimer = null
    }
    await atomicWriteJson(this.statsFile, this.statsCache)
  }
}
```

- [ ] **Step 4: 实现 `networkBook.ts`**

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { BookMeta } from '../../core/model'
import { atomicWriteJson, ensureDir, pathExists, readJson } from './fsUtil'

function fileName(index: number): string {
  return `${String(index).padStart(5, '0')}.txt`
}

export class NetworkBookRepository {
  constructor(private readonly root: string) {}

  private bookDir(id: string): string { return join(this.root, 'books', id) }

  async create(meta: BookMeta): Promise<void> {
    const dir = this.bookDir(meta.id)
    await ensureDir(join(dir, 'chapters'))
    await ensureDir(join(dir, 'raw'))
    await atomicWriteJson(join(dir, 'meta.json'), meta)
  }

  async writeMeta(id: string, meta: BookMeta): Promise<void> {
    await atomicWriteJson(join(this.bookDir(id), 'meta.json'), meta)
  }

  async readMeta(id: string): Promise<BookMeta> {
    const meta = await readJson<BookMeta>(join(this.bookDir(id), 'meta.json'))
    if (!meta) throw new Error(`书籍数据缺失：${id}`)
    return meta
  }

  async listCachedChapters(id: string): Promise<number[]> {
    let names: string[]
    try {
      names = await fs.readdir(join(this.bookDir(id), 'chapters'))
    } catch {
      return []
    }
    const cached: number[] = []
    for (const name of names) {
      const match = /^(\d{5})\.txt$/.exec(name)
      if (!match) continue
      try {
        const stat = await fs.stat(join(this.bookDir(id), 'chapters', name))
        if (stat.size > 0) cached.push(Number(match[1]))
      } catch {
        // A disappearing file is simply not cached.
      }
    }
    return cached.sort((a, b) => a - b)
  }

  async readChapterText(id: string, index: number): Promise<string | null> {
    try {
      const text = await fs.readFile(join(this.bookDir(id), 'chapters', fileName(index)), 'utf8')
      return text.trim() ? text : null
    } catch {
      return null
    }
  }

  async readRawChapter(id: string, index: number): Promise<string | null> {
    try {
      const text = await fs.readFile(join(this.bookDir(id), 'raw', fileName(index)), 'utf8')
      return text.trim() ? text : null
    } catch {
      return null
    }
  }

  async writeChapter(id: string, index: number, raw: string, cleaned: string): Promise<void> {
    const dir = this.bookDir(id)
    await ensureDir(join(dir, 'raw'))
    await ensureDir(join(dir, 'chapters'))
    await this.atomicWrite(join(dir, 'raw', fileName(index)), raw)
    await this.atomicWrite(join(dir, 'chapters', fileName(index)), cleaned)
  }

  private async atomicWrite(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }

  async exists(id: string): Promise<boolean> {
    return pathExists(this.bookDir(id))
  }
}
```

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run tests/network-storage.test.ts`
Expected: PASS。

```bash
git add src/main/services/network/sourceStore.ts src/main/storage/networkBook.ts src/main/storage/book.ts tests/network-storage.test.ts
git commit -m "feat(network): store sources, stats and network chapter caches"
```

---

### Task 6: 安全 HTTP 客户端

**Files:**
- Create: `src/main/services/network/httpClient.ts`
- Create: `tests/helpers/networkServer.ts`
- Test: `tests/network-http.test.ts`

**Interfaces:**
- Consumes: `iconv-lite`、`node:dns/promises`、`node:net`、`node:fs`? 不写盘。
- Produces: `HttpClient`、`HttpRequest`、`HttpResponse`、`NetworkError`、`isBlockedAddress()`、`decodeBody()`。

- [ ] **Step 1: 写失败测试**

```ts
import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { HttpClient, NetworkError } from '../src/main/services/network/httpClient'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'

let close: (() => Promise<void>) | null = null
afterEach(async () => { if (close) await close(); close = null })

describe('HttpClient', () => {
  it('fetches text and follows a redirect, revalidating the target', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/go') { res.writeHead(302, { Location: '/ok' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<p>你好</p>')
    })
    close = server.close
    const client = new HttpClient()
    const response = await client.request({ url: `${server.url}/go` })
    expect(response.text).toContain('你好')
    expect(response.url).toBe(`${server.url}/ok`)
  })

  it('blocks private addresses unless the test flag is on', async () => {
    const client = new HttpClient()
    const previous = process.env.READER_ALLOW_LOCAL_SOURCES
    delete process.env.READER_ALLOW_LOCAL_SOURCES
    await expect(client.request({ url: 'http://127.0.0.1:9/' }))
      .rejects.toBeInstanceOf(NetworkError)
    process.env.READER_ALLOW_LOCAL_SOURCES = previous
  })

  it('decodes GBK', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    })
    close = server.close
    const client = new HttpClient()
    const response = await client.request({ url: `${server.url}/gbk`, charset: 'gbk' })
    expect(response.text).toBe('你好')
  })

  it('stops an oversized body and a gzip bomb by decompressed size', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/bomb') {
        // Small on the wire, 4 KB after decompression: the stream cap must
        // count decompressed bytes, not content-length.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
        res.end(gzipSync(Buffer.from('x'.repeat(4096))))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('y'.repeat(2048))
    })
    close = server.close
    const client = new HttpClient({ maxBytes: 1024 })
    await expect(client.request({ url: `${server.url}/big` }))
      .rejects.toMatchObject({ kind: 'too-large' })
    await expect(client.request({ url: `${server.url}/bomb` }))
      .rejects.toMatchObject({ kind: 'too-large' })
  })
})
```

- [ ] **Step 2: 写测试服务器**

新建 `tests/helpers/networkServer.ts`：

```ts
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeServer {
  url: string
  close: () => Promise<void>
  /** When true, the next request answers 500 and the flag resets. */
  failNext: boolean
  requestCount: number
  /** Milliseconds to wait before running the handler (0 = immediate). */
  delayMs: number
}

/**
 * One local HTTP server used by every network test. `failNext` and `delayMs`
 * exist from the start so search-cancel and download-cancel tests can use
 * them without reworking the helper later.
 */
export async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<FakeServer> {
  const state: FakeServer = {
    url: '',
    close: async () => undefined,
    failNext: false,
    requestCount: 0,
    delayMs: 0
  }
  const server = createServer((req, res) => {
    state.requestCount++
    if (state.failNext) {
      state.failNext = false
      res.writeHead(500)
      res.end()
      return
    }
    if (state.delayMs > 0) {
      setTimeout(() => handler(req, res), state.delayMs)
      return
    }
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind')
  state.url = `http://127.0.0.1:${address.port}`
  state.close = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return state
}
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/network-http.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 4: 实现 `httpClient.ts`**

```ts
import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import iconv from 'iconv-lite'

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'http' | 'network' | 'blocked' | 'too-large',
    readonly status?: number
  ) {
    super(message)
    this.name = 'NetworkError'
  }
}

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  charset?: string
  sourceId?: string
  signal?: AbortSignal
  timeoutMs?: number
  retry?: number
}

export interface HttpResponse {
  url: string
  status: number
  text: string
  contentType: string
  warnings: string[]
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5

export function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  if (ip === '::1' || ip === '0.0.0.0') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (isIP(ip) === 6) {
    return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || ip === '::1'
  }
  return false
}

async function assertAllowed(url: URL, allowLocal: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkError('只允许 http 或 https 地址', 'blocked')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') {
    if (allowLocal && url.port) return
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
  if (isIP(host)) {
    if (isBlockedAddress(host) && !(allowLocal && (host === '127.0.0.1' || host === '::1'))) {
      throw new NetworkError('不允许访问本地或内网地址', 'blocked')
    }
    return
  }
  let addresses: { address: string }[]
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new NetworkError('无法解析书源域名', 'network')
  }
  if (addresses.some((entry) => isBlockedAddress(entry.address)) && !allowLocal) {
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
}

function charsetFrom(contentType: string, html: string): string | null {
  const header = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^["']|["']$/g, '')
  if (header) return header
  return /<meta[^>]+charset=["']?([^"'\s/>]+)/i.exec(html.slice(0, 4096))?.[1] ?? null
}

export function decodeBody(buffer: Buffer, charset?: string, contentType = ''): { text: string; warnings: string[] } {
  const warnings: string[] = []
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), warnings }
  }
  const head = buffer.subarray(0, 4096).toString('latin1')
  const label = charset ?? charsetFrom(contentType, head) ?? 'utf-8'
  const normalized = /^gb2312$/i.test(label) ? 'gbk' : label
  if (!iconv.encodingExists(normalized)) {
    warnings.push(`未知字符集 ${label}，按 UTF-8 处理`)
    return { text: buffer.toString('utf8'), warnings }
  }
  return { text: iconv.decode(buffer, normalized), warnings }
}

class CookieJar {
  private readonly values = new Map<string, Map<string, string>>()
  private key(sourceId: string, host: string): string { return `${sourceId}|${host}` }

  header(sourceId: string, url: URL): string {
    const values = this.values.get(this.key(sourceId, url.hostname))
    return values ? [...values.entries()].map(([key, value]) => `${key}=${value}`).join('; ') : ''
  }

  store(sourceId: string, url: URL, setCookies: string[]): void {
    if (setCookies.length === 0) return
    const key = this.key(sourceId, url.hostname)
    const values = this.values.get(key) ?? new Map<string, string>()
    for (const cookie of setCookies) {
      const pair = cookie.split(';', 1)[0]
      const at = pair.indexOf('=')
      if (at > 0) values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    this.values.set(key, values)
  }

  clearSource(sourceId: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(`${sourceId}|`)) this.values.delete(key)
    }
  }
}

export class HttpClient {
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly allowLocal: boolean
  private readonly cookies = new CookieJar()

  constructor(options: { timeoutMs?: number; maxBytes?: number; allowLocal?: boolean } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.allowLocal = options.allowLocal ?? process.env.READER_ALLOW_LOCAL_SOURCES === '1'
  }

  clearSourceCookies(sourceId: string): void {
    this.cookies.clearSource(sourceId)
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const retries = request.method === 'POST' ? 0 : Math.min(1, request.retry ?? 1)
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await this.requestOnce(request)
      } catch (error) {
        lastError = error
        if (!(error instanceof NetworkError) || !['timeout', 'network'].includes(error.kind)) break
      }
    }
    throw lastError instanceof Error ? lastError : new NetworkError('网络请求失败', 'network')
  }

  private async requestOnce(request: HttpRequest): Promise<HttpResponse> {
    let current = new URL(request.url)
    const warnings: string[] = []
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      await assertAllowed(current, this.allowLocal)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs)
      const onAbort = (): void => controller.abort()
      request.signal?.addEventListener('abort', onAbort)
      try {
        const headers: Record<string, string> = {
          'User-Agent': 'Reader/1.0',
          ...request.headers
        }
        const cookie = this.cookies.header(request.sourceId ?? '', current)
        if (cookie) {
          // A source header may spell the key either way; merge instead of
          // sending two different Cookie headers.
          const existing = headers.Cookie ?? headers.cookie
          headers.Cookie = existing ? `${existing}; ${cookie}` : cookie
          delete headers.cookie
        }
        const response = await fetch(current, {
          method: request.method ?? 'GET',
          headers,
          ...(request.body !== undefined && request.method === 'POST'
            ? { body: Buffer.from(iconv.encode(request.body, request.charset && iconv.encodingExists(request.charset) ? request.charset : 'utf8')) }
            : {}),
          redirect: 'manual',
          signal: controller.signal
        })
        const setCookies = typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : []
        this.cookies.store(request.sourceId ?? '', current, setCookies)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) throw new NetworkError(`重定向缺少地址（${response.status}）`, 'http', response.status)
          current = new URL(location, current)
          continue
        }
        if (response.status >= 400) {
          throw new NetworkError(`HTTP ${response.status}`, 'http', response.status)
        }
        const length = Number(response.headers.get('content-length') ?? 0)
        if (Number.isFinite(length) && length > this.maxBytes) {
          throw new NetworkError('响应内容过大', 'too-large')
        }
        const reader = response.body?.getReader()
        const chunks: Uint8Array[] = []
        let total = 0
        if (reader) {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            total += value.byteLength
            if (total > this.maxBytes) {
              await reader.cancel().catch(() => undefined)
              throw new NetworkError('响应内容过大', 'too-large')
            }
            chunks.push(value)
          }
        }
        const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
        const contentType = response.headers.get('content-type') ?? ''
        const decoded = decodeBody(buffer, request.charset, contentType)
        return {
          url: current.toString(),
          status: response.status,
          text: decoded.text,
          contentType,
          warnings: [...warnings, ...decoded.warnings]
        }
      } catch (error) {
        if (error instanceof NetworkError) throw error
        if (controller.signal.aborted) throw new NetworkError('请求超时', 'timeout')
        throw new NetworkError(error instanceof Error ? error.message : '网络请求失败', 'network')
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
    }
    throw new NetworkError('重定向次数过多', 'network')
  }
}
```

注意：`request.headers` 里的 Cookie 键大小写不定，合并时取 `headers.Cookie ?? headers.cookie`，并删掉小写键，保证只发一个 Cookie 头。

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/network-http.test.ts`
Expected: PASS。

- [ ] **Step 6: 提交**

```bash
git add src/main/services/network/httpClient.ts tests/helpers/networkServer.ts tests/network-http.test.ts
git commit -m "feat(network): add secure http client for book sources"
```

---

### Task 7: 页面解析、书源读取与网络搜索

**Files:**
- Create: `src/core/booksource/parse.ts`
- Create: `src/main/services/network/sourceReader.ts`
- Create: `src/main/services/network/sourceService.ts`
- Create: `src/main/services/network/searchService.ts`
- Test: `tests/booksource-parse.test.ts`
- Test: `tests/network-search.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `evaluateRuleFirst()`、`applyTemplate()`、`parseUrlOptions()`；Task 3 的 `ParsedSource`；Task 5 的 `SourceStore`；Task 6 的 `HttpClient`；Task 4 的 `mergeSearchResults()`、`selectQualitySources()`。
- Produces: `SourceRules`、`sourceRules()`、`documentFromResponse()`、`parseSearchPage()`、`parseBookInfoPage()`、`parseTocPage()`、`parseContentPage()`、`absoluteUrl()`；`SourceReader`（`search`、`info`、`toc`、`content`）；`SourceService`（`list`、`get`、`require`、`importJson`、`importUrl`、`setFlags`、`raw`、`remove`、`repair`）；`NetworkSearchService.search()`。

- [ ] **Step 1: 写解析失败测试**

```ts
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
    expect(content.text).toBe('第一段\n第二句\n\n第二段')
    expect(content.nextUrl).toBeUndefined()
  })

  it('rejects JSON rules on HTML and javascript: links', () => {
    const html = documentFromResponse('<div>x</div>', 'text/html', 'https://example.com')
    const jsonRules = { ...rules, searchBookList: '@json:$.books[*]' }
    expect(() => parseSearchPage(html, jsonRules, { baseUrl: 'https://example.com' }))
      .toThrow('JSON')
    const doc = documentFromResponse(
      '<a class="name" href="javascript:alert(1)">x</a>',
      'text/html',
      'https://example.com'
    )
    expect(parseSearchPage(doc, rules, { baseUrl: 'https://example.com' })).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/booksource-parse.test.ts`
Expected: FAIL，模块不存在。

- [ ] **Step 3: 实现 `parse.ts`**

```ts
import { load } from 'cheerio'
import { JSONPath } from 'jsonpath-plus'
import type { RuleContext, RuleDocument } from './rules'
import { evaluateRuleFirst } from './rules'
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
  return evaluateRuleFirst(rule, doc, context).trim()
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
```

`require('jsonpath-plus')` 在 ESM/TS 下不可靠；改成文件顶部 `import { JSONPath } from 'jsonpath-plus'` 并直接使用。不要使用 `require`。

- [ ] **Step 4: 写 `SourceReader`**

```ts
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
  ): Promise<{ doc: RuleDocument; response: HttpResponse }> {
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
      response
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
      const { doc } = await this.fetch(source, url, context, signal)
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
      const { doc } = await this.fetch(source, url, context, signal)
      const parsed = parseContentPage(doc, rules, context)
      if (parsed.text) parts.push(parsed.text)
      url = parsed.nextUrl ?? ''
    }
    const text = parts.join('\n\n')
    if (text.length > 2 * 1024 * 1024) throw new NetworkError('正文超过 2 MB，已停止', 'too-large')
    return { text, warnings }
  }
}
```

`info` 里的 `infoUrl` 三元表达式是冗余的；直接用 `bookUrl`。若 `ruleBookInfo.name` 为空，仍请求 `bookUrl`，标题回退到搜索结果。

- [ ] **Step 5: 写 `SourceService`**

```ts
import type { LibraryEntry } from '../../../core/model'
import type {
  ImportSourcesResult,
  SourceListItem,
  StoredSource
} from '../../../core/booksource/model'
import { parseSourceJson, parseSourceValue } from '../../../core/booksource/legado'
import type { ParsedSource } from '../../../core/booksource/legado'
import type { LibraryRepository } from '../../storage/library'
import type { HttpClient } from './httpClient'
import type { SourceStore } from './sourceStore'

export class SourceService {
  constructor(
    private readonly store: SourceStore,
    private readonly http: HttpClient,
    private readonly library: LibraryRepository
  ) {}

  async repair(): Promise<boolean> {
    return this.store.repair()
  }

  async list(): Promise<SourceListItem[]> {
    const [items, entries] = await Promise.all([this.store.listItems(), this.library.list()])
    const counts = new Map<string, number>()
    for (const entry of entries) {
      if (entry.format !== 'network' || !entry.sourceId) continue
      counts.set(entry.sourceId, (counts.get(entry.sourceId) ?? 0) + 1)
    }
    return items.map((item) => ({ ...item, bookCount: counts.get(item.id) ?? 0 }))
  }

  async get(id: string): Promise<StoredSource | null> {
    return this.store.get(id)
  }

  async require(id: string): Promise<ParsedSource> {
    const stored = await this.store.get(id)
    if (!stored) throw new Error('书源已删除，无法联网')
    if (!stored.enabled) throw new Error('书源已停用，无法联网')
    return {
      definition: stored.definition,
      name: String(stored.definition.bookSourceName ?? '未命名书源'),
      url: String(stored.definition.bookSourceUrl ?? ''),
      group: String(stored.definition.bookSourceGroup ?? ''),
      searchUrl: String(stored.definition.searchUrl ?? ''),
      header: this.header(stored.definition.header),
      ...(typeof stored.definition.charset === 'string'
        ? { charset: stored.definition.charset }
        : {}),
      customOrder: Number(stored.definition.customOrder ?? 0),
      compat: stored.compat
    }
  }

  private header(value: unknown): Record<string, string> {
    if (typeof value !== 'string') return {}
    try {
      const parsed = JSON.parse(value) as unknown
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
      return Object.fromEntries(
        Object.entries(parsed as Record<string, unknown>).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string'
        )
      )
    } catch {
      return {}
    }
  }

  private async applyImport(
    batch: ReturnType<typeof parseSourceValue>
  ): Promise<ImportSourcesResult> {
    const result = await this.store.importParsed(batch.sources)
    return {
      added: result.added,
      updated: result.updated,
      rejected: batch.rejected,
      warnings: batch.warnings
    }
  }

  async importJson(text: string, dryRun = false): Promise<ImportSourcesResult> {
    const batch = parseSourceJson(text)
    if (dryRun) {
      return { added: batch.sources.length, updated: 0, rejected: batch.rejected, warnings: batch.warnings }
    }
    return this.applyImport(batch)
  }

  async importUrl(url: string): Promise<ImportSourcesResult> {
    const response = await this.http.request({ url })
    return this.importJson(response.text)
  }

  async setFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<SourceListItem[]> {
    await this.store.setFlags(id, flags)
    return this.list()
  }

  async raw(id: string): Promise<Record<string, unknown> | null> {
    return this.store.raw(id)
  }

  async remove(id: string): Promise<void> {
    const removed = await this.store.remove(id)
    if (!removed) throw new Error('找不到这个书源')
    const url = removed.definition.bookSourceUrl
    if (typeof url === 'string') this.http.clearSourceCookies(url)
  }
}
```

- [ ] **Step 6: 写 `NetworkSearchService`**

```ts
import type { LibraryEntry } from '../../../core/model'
import type {
  NetworkSearchDone,
  NetworkSearchGroup,
  NetworkSearchItem,
  NetworkSearchSourceEvent,
  SourceListItem
} from '../../../core/booksource/model'
import { mergeSearchResults, normalizeSearchTitle } from '../../../core/booksource/searchResults'
import { selectQualitySources } from '../../../core/booksource/quality'
import { sourceRules } from '../../../core/booksource/parse'
import type { NetworkSearchRequest } from '../../../shared/api'
import type { SourceReader } from './sourceReader'
import type { SourceService } from './sourceService'
import type { SourceStore } from './sourceStore'

const CONCURRENCY = 6
const PER_SOURCE_LIMIT = 100

/** The renderer has its own error formatter; the main process keeps a local one. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : '搜索失败'
}

export interface SearchEmitter {
  source(event: NetworkSearchSourceEvent): void
  results(payload: { groups: NetworkSearchGroup[]; searched: number; succeeded: number; empty: number; failed: number; remaining: number }): void
}

export class NetworkSearchService {
  private readonly jobs = new Map<string, { controller: AbortController; cancelled: boolean }>()
  private readonly inFlight = new Set<string>()

  constructor(
    private readonly sources: SourceService,
    private readonly store: SourceStore,
    private readonly reader: SourceReader,
    private readonly library: LibraryRepository
  ) {}

  cancel(requestId: string): void {
    const job = this.jobs.get(requestId)
    if (job) {
      job.cancelled = true
      job.controller.abort()
    }
  }

  async search(request: NetworkSearchRequest, emit: SearchEmitter): Promise<NetworkSearchDone> {
    const key = `${request.requestId}`
    if (this.inFlight.has(key)) throw new Error('这个搜索已经在进行')
    this.inFlight.add(key)
    const job = { controller: new AbortController(), cancelled: false }
    this.jobs.set(request.requestId, job)
    const keyword = request.keyword.trim()
    const emptyDone: NetworkSearchDone = {
      requestId: request.requestId,
      cancelled: false,
      searched: 0,
      succeeded: 0,
      empty: 0,
      failed: 0,
      groups: []
    }
    if (!keyword) return emptyDone

    try {
      const all = await this.sources.list()
      const pool = request.scope === 'all'
        ? all.filter((source) => source.enabled)
        : selectQualitySources(all)
      if (pool.length === 0) throw new Error('没有可用的书源，请先导入或启用书源')
      const entries = await this.library.list()
      const shelfTitles = new Set(
        entries
          .filter((entry) => entry.format === 'network')
          .map((entry) => normalizeSearchTitle(entry.title))
      )
      const queue = [...pool]
      const collected: NetworkSearchItem[] = []
      let searched = 0
      let succeeded = 0
      let empty = 0
      let failed = 0
      let remaining = queue.length

      const runOne = async (item: SourceListItem): Promise<void> => {
        if (job.cancelled) return
        const started = Date.now()
        try {
          const source = await this.sources.require(item.id)
          const page = await this.reader.search(source, keyword, 1, job.controller.signal)
          const results = page.slice(0, PER_SOURCE_LIMIT).map((entry) => ({
            sourceId: item.id,
            sourceName: item.name,
            title: entry.title,
            author: entry.author,
            ...(entry.intro ? { intro: entry.intro } : {}),
            ...(entry.kind ? { kind: entry.kind } : {}),
            ...(entry.coverUrl ? { coverUrl: entry.coverUrl } : {}),
            bookUrl: entry.bookUrl,
            ...(entry.lastChapter ? { lastChapter: entry.lastChapter } : {}),
            qualityScore: item.score,
            starred: item.starred,
            inShelf: shelfTitles.has(normalizeSearchTitle(entry.title)),
            avgMs: item.avgMs,
            importedAt: item.importedAt
          }))
          await this.store.record(item.id, 'search', results.length ? 'success' : 'empty', Date.now() - started)
          if (results.length === 0) empty++
          else succeeded++
          collected.push(...results)
          emit.source({
            requestId: request.requestId,
            sourceId: item.id,
            sourceName: item.name,
            status: results.length ? 'success' : 'empty',
            count: results.length,
            ms: Date.now() - started
          })
        } catch (error) {
          if (job.cancelled) return
          failed++
          const message = messageOf(error)
          await this.store.record(item.id, 'search', 'error', Date.now() - started, message)
          emit.source({
            requestId: request.requestId,
            sourceId: item.id,
            sourceName: item.name,
            status: 'error',
            count: 0,
            ms: Date.now() - started,
            message
          })
        } finally {
          searched++
          remaining--
        }
        emit.results({
          groups: mergeSearchResults(collected),
          searched,
          succeeded,
          empty,
          failed,
          remaining
        })
      }

      const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
        while (queue.length > 0 && !job.cancelled) {
          const item = queue.shift()
          if (!item) break
          await runOne(item)
        }
      })
      await Promise.all(workers)
      return {
        requestId: request.requestId,
        cancelled: job.cancelled,
        searched,
        succeeded,
        empty,
        failed,
        groups: mergeSearchResults(collected)
      }
    } finally {
      this.inFlight.delete(key)
      this.jobs.delete(request.requestId)
    }
  }
}
```

`messageOf` 是主进程本地函数：renderer 的 `src/renderer/src/errors.ts` 只在渲染层可用，主进程不引用它。搜索错误只取 `error.message`，已经是中文的 `NetworkError` 文案会原样透传。

- [ ] **Step 7: 写搜索服务测试**

`tests/network-search.test.ts` 使用 `startFakeServer` 和临时 `SourceStore`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { NetworkSearchService } from '../src/main/services/network/searchService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { HttpClient } from '../src/main/services/network/httpClient'
import { LibraryRepository } from '../src/main/storage/library'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'
let root = ''
let close: (() => Promise<void>) | null = null
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-search-')) })
afterEach(async () => { if (close) await close(); await rm(root, { recursive: true, force: true }) })

describe('NetworkSearchService', () => {
  it('searches quality sources, groups results and records stats', async () => {
    const server = await startFakeServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<div class="book"><a class="name" href="/b/1">斗破苍穹</a><span class="author">土豆</span></div>')
    })
    close = server.close
    const store = new SourceStore(root)
    await store.importParsed([{
      definition: {
        bookSourceName: '源A', bookSourceUrl: server.url, searchUrl: '/s?q={{key}}',
        ruleSearch: { bookList: '.book', name: '.name', author: '.author', bookUrl: '.name@href' },
        ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
        ruleContent: { content: '#c' }
      },
      name: '源A', url: server.url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
      compat: { level: 'full', issues: [] }
    }])
    const storeService = new SourceService(store, new HttpClient(), new LibraryRepository(root))
    const service = new NetworkSearchService(storeService, store, new SourceReader(new HttpClient()), new LibraryRepository(root))
    const [source] = await storeService.list()
    await store.setFlags(source.id, { starred: true })
    const done = await service.search(
      { requestId: 'r1', keyword: '斗破', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    expect(done.groups).toHaveLength(1)
    expect(done.groups[0].items[0].author).toBe('土豆')
    expect(done.succeeded).toBe(1)
    expect((await store.listItems())[0].searchSuccessRate).toBeGreaterThan(0)

    // A cancelled request stops without counting the aborted fetch as a
    // source failure.
    server.delayMs = 100
    const running = service.search(
      { requestId: 'r2', keyword: '斗破', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    setTimeout(() => service.cancel('r2'), 20)
    const cancelled = await running
    expect(cancelled.cancelled).toBe(true)
    expect(cancelled.failed).toBe(0)
  })
})
```

- [ ] **Step 8: 运行测试**

Run: `npx vitest run tests/booksource-parse.test.ts tests/network-search.test.ts`
Expected: PASS。如果 `SourceService.require` 的 header 解析与 `ParsedSource` 字段不一致，按 Task 3 的实际类型修正。

- [ ] **Step 9: 提交**

```bash
git add src/core/booksource/parse.ts src/main/services/network/sourceReader.ts src/main/services/network/sourceService.ts src/main/services/network/searchService.ts tests/booksource-parse.test.ts tests/network-search.test.ts
git commit -m "feat(network): parse source pages and search across sources"
```

---

### Task 8: 网络书加入书架与按章读取

**Files:**
- Create: `src/main/services/network/bookService.ts`
- Create: `src/main/services/network/limits.ts`
- Test: `tests/network-book.test.ts`

**Interfaces:**
- Consumes: `SourceService`、`SourceReader`、`NetworkBookRepository`、`LibraryRepository.add/update`、`CleaningService.currentRunConfig()`。
- Produces: `Semaphore`、`KeyedLocks`；`NetworkBookService`（`add`、`readChapter`、`networkCacheOf`、`entryFor`、`cancelBookTasks`、`relinkSources`，以及 Task 9/10 会追加的方法）。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { NetworkBookService } from '../src/main/services/network/bookService'
import { HttpClient } from '../src/main/services/network/httpClient'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'
let root = ''
let close: (() => Promise<void>) | null = null
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-netbook-')) })
afterEach(async () => { if (close) await close(); await rm(root, { recursive: true, force: true }) })

async function setup(allowNetwork: () => boolean = () => true) {
  const server = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    if (req.url?.startsWith('/info')) {
      res.end('<h1>网络书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (req.url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (req.url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (req.url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  close = server.close
  const store = new SourceStore(root)
  await store.importParsed([{
    definition: {
      bookSourceName: '源A', bookSourceUrl: server.url, searchUrl: '/s?q={{key}}',
      ruleSearch: { bookList: '.book', name: '.name', bookUrl: '.name@href' },
      ruleBookInfo: { name: 'h1', author: '.author', tocUrl: '.toc@href' },
      ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
      ruleContent: { content: '#content@html' }
    },
    name: '源A', url: server.url, group: '', searchUrl: '/s?q={{key}}', header: {}, customOrder: 0,
    compat: { level: 'full', issues: [] }
  }])
  const library = new LibraryRepository(root)
  const books = new BookRepository(root)
  const networkBooks = new NetworkBookRepository(root)
  const sources = new SourceService(store, new HttpClient(), library)
  const service = new NetworkBookService({
    root, sources, reader: new SourceReader(new HttpClient()), networkBooks, books, library,
    cleaning: () => ({ adCleaning: true, rules: [] }),
    allowNetwork
  })
  const [source] = await sources.list()
  return { server, service, library, books, networkBooks, source }
}

describe('NetworkBookService', () => {
  it('adds a network book with toc and reads a chapter on demand', async () => {
    const { server, service, library, books } = await setup()
    const entry = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    expect(entry.title).toBe('网络书')
    expect(entry.format).toBe('network')
    expect(entry.chapterCount).toBe(2)
    expect(entry.downloadState).toBe('none')
    expect((await library.list())).toHaveLength(1)

    const meta = await books.readMeta(entry.id)
    expect(meta.network?.tocUrl).toBe(`${server.url}/toc`)
    const chapter = await service.readChapter(entry.id, 0)
    expect(chapter.text).toContain('正文一')
    expect((await service.networkCacheOf(entry.id)).cached).toBe(1)
    const again = await service.readChapter(entry.id, 0)
    expect(again.cached).toBe(true)
  })

  it('requests a chapter once for concurrent readers', async () => {
    const { service, server } = await setup()
    const entry = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    const before = server.requestCount
    const [a, b] = await Promise.all([
      service.readChapter(entry.id, 0),
      service.readChapter(entry.id, 0)
    ])
    expect(a.text).toBe(b.text)
    expect(server.requestCount - before).toBe(1)
  })

  it('rejects a source that was deleted', async () => {
    const { service } = await setup()
    const sourceId = (await service.sources.list())[0].id
    await service.sources.remove(sourceId)
    await expect(service.add({ sourceId, bookUrl: 'https://example.com/b' })).rejects.toThrow('书源已删除')
  })

  it('refuses network work when networking is off but still reads cached chapters', async () => {
    let enabled = true
    const { service, server } = await setup(() => enabled)
    const entry = await service.add({
      sourceId: (await service.sources.list())[0].id,
      bookUrl: `${server.url}/info`
    })
    await service.readChapter(entry.id, 0)
    enabled = false
    expect((await service.readChapter(entry.id, 0)).cached).toBe(true)
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('已关闭联网功能')
    await expect(service.updateToc(entry.id)).rejects.toThrow('已关闭联网功能')
  })
})
```

`service.sources` 和 `networkCacheOf` 需要在类中公开；`sources` 用 `readonly` 构造参数即可。

- [ ] **Step 2: 实现并发限制器 `limits.ts`**

```ts
export class Semaphore {
  private active = 0
  private readonly waiting: (() => void)[] = []

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) {
      await new Promise<void>((resolve) => this.waiting.push(resolve))
    }
    this.active++
    try {
      return await task()
    } finally {
      this.active--
      const next = this.waiting.shift()
      if (next) next()
    }
  }
}

/** Serializes work per key while allowing different keys to run together. */
export class KeyedLocks {
  private readonly tails = new Map<string, Promise<unknown>>()

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve()
    const run = previous.then(task, task)
    this.tails.set(key, run.catch(() => undefined))
    return run
  }
}
```

- [ ] **Step 3: 实现 `bookService.ts` 的 Task 8 部分**

```ts
import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cleanChapters } from '../../../core/cleaning'
import type { CleaningRunConfig } from '../../../core/cleaning'
import { downloadState, networkCacheFor } from '../../../core/booksource/quality'
import type { BookMeta, ChapterMeta, LibraryEntry } from '../../../core/model'
import { chapterTitleHash } from '../../../core/chapters'
import { normalizeBookTitle } from '../../../core/sameBook'
import type { AddNetworkBookInput } from '../../../shared/api'
import type { BookRepository } from '../../storage/book'
import type { LibraryRepository } from '../../storage/library'
import type { NetworkBookRepository } from '../../storage/networkBook'
import { assertBookId } from '../../bookId'
import type { SourceReader } from './sourceReader'
import type { SourceService } from './sourceService'
import { KeyedLocks, Semaphore } from './limits'

export interface NetworkBookDeps {
  root: string
  sources: SourceService
  reader: SourceReader
  networkBooks: NetworkBookRepository
  books: BookRepository
  library: LibraryRepository
  cleaning: () => CleaningRunConfig
  /** False when the user turned networking off; cached chapters stay readable. */
  allowNetwork?: () => boolean
}

function safeFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || '网络书'
  return `${base}.txt`
}

function chapterFromToc(title: string, url: string, level: 'chapter' | 'volume', index: number): ChapterMeta {
  return {
    index,
    title,
    level,
    titleHash: chapterTitleHash(title),
    startLine: 0,
    charCount: 0,
    simhash: '',
    flags: {},
    ...(url ? { url } : {})
  }
}

export class NetworkBookService {
  readonly sources: SourceService
  private readonly reader: SourceReader
  private readonly networkBooks: NetworkBookRepository
  private readonly books: BookRepository
  private readonly library: LibraryRepository
  private readonly cleaning: () => CleaningRunConfig
  private readonly allowNetwork: () => boolean
  private readonly root: string
  private readonly locks = new KeyedLocks()
  private readonly bookSemaphore = new Semaphore(2)
  private readonly readSemaphore = new Semaphore(6)
  private readonly chapterRequests = new Map<string, Promise<string>>()
  private readonly downloadJobs = new Map<string, { controller: AbortController; done: Promise<unknown> }>()

  constructor(deps: NetworkBookDeps) {
    this.root = deps.root
    this.sources = deps.sources
    this.reader = deps.reader
    this.networkBooks = deps.networkBooks
    this.books = deps.books
    this.library = deps.library
    this.cleaning = deps.cleaning
    this.allowNetwork = deps.allowNetwork ?? (() => true)
  }

  private ensureNetwork(): void {
    if (!this.allowNetwork()) {
      throw new Error('已关闭联网功能，请到设置里打开后再搜索/更新/下载')
    }
  }

  async add(input: AddNetworkBookInput): Promise<LibraryEntry> {
    this.ensureNetwork()
    const source = await this.sources.require(input.sourceId)
    const info = await this.reader.info(source, input.bookUrl)
    const title = (info.title || input.title || '').trim()
    if (!title) throw new Error('没有从书源拿到书名')
    const toc = await this.reader.toc(source, {
      bookUrl: info.bookUrl,
      tocUrl: info.tocUrl || info.bookUrl
    })
    const chapters = toc.chapters.map((chapter, index) =>
      chapterFromToc(chapter.title, chapter.url, chapter.level, index)
    )
    if (chapters.length === 0) throw new Error('书源没有返回目录')
    const contentChapterCount = chapters.filter(
      (chapter) => chapter.level !== 'volume' && chapter.url
    ).length
    if (contentChapterCount === 0) throw new Error('书源没有返回可读章节')
    const id = randomUUID()
    const now = new Date().toISOString()
    const meta: BookMeta = {
      version: 1,
      id,
      title,
      encoding: 'utf-8',
      format: 'network',
      chapters,
      createdAt: now,
      ...(info.author || input.author ? { author: info.author || input.author } : {}),
      ...(info.intro ? { intro: info.intro } : {}),
      ...(info.kind ? { kind: info.kind } : {}),
      network: {
        sourceId: input.sourceId,
        sourceUrl: source.url,
        sourceName: source.name,
        bookUrl: info.bookUrl,
        tocUrl: info.tocUrl || info.bookUrl,
        ...(info.lastChapter ? { lastChapter: info.lastChapter } : {}),
        lastTocAt: now,
        lastCheckAt: now,
        lastDownloadAt: null
      }
    }
    await this.networkBooks.create(meta)
    // v1 不下载网络封面：封面区显示书名首字，避免引入二进制响应处理。
    const entry: LibraryEntry = {
      id,
      title,
      format: 'network',
      ...(meta.author ? { author: meta.author } : {}),
      ...(meta.intro ? { intro: meta.intro } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      sourceId: input.sourceId,
      sourceName: source.name,
      normalizedTitle: normalizeBookTitle(safeFileName(title)),
      sourceFileName: safeFileName(title),
      fileHash: createHash('sha256').update(`network:${input.sourceId}:${info.bookUrl}`).digest('hex'),
      encoding: 'utf-8',
      importedAt: now,
      lastReadAt: null,
      chapterCount: chapters.length,
      progressPercent: 0,
      stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 },
      networkCache: { cached: 0, total: contentChapterCount },
      downloadState: 'none',
      lastUpdateAt: now
    }
    await this.library.add(entry)
    return entry
  }

  async readChapter(id: string, index: number): Promise<{ text: string; cached: boolean }> {
    assertBookId(id)
    const cached = await this.networkBooks.readChapterText(id, index)
    if (cached) return { text: cached, cached: true }
    this.ensureNetwork()
    const key = `${id}:${index}`
    const existing = this.chapterRequests.get(key)
    if (existing) return { text: await existing, cached: false }
    const request = this.locks.run(key, () =>
      this.bookSemaphore.run(() =>
        this.readSemaphore.run(async () => {
          const again = await this.networkBooks.readChapterText(id, index)
          if (again) return again
          const meta = await this.networkBooks.readMeta(id)
          if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
          const chapter = meta.chapters[index]
          if (!chapter) throw new Error('章节不存在')
          if (!chapter.url) throw new Error('这一章没有正文地址')
          const source = await this.sources.require(meta.network.sourceId)
          const content = await this.reader.content(source, {
            chapterUrl: chapter.url,
            chapterName: chapter.title,
            bookUrl: meta.network.bookUrl
          })
          if (!content.text.trim()) throw new Error('书源返回了空正文')
          const cleaning = this.cleaning()
          const cleaned = cleanChapters(
            [{ title: chapter.title, level: 'chapter', startLine: 0, paragraphs: content.text.split(/\n{2,}/) }],
            cleaning.rules,
            { adCleaning: cleaning.adCleaning }
          ).chapters[0]
          const text = cleaned.paragraphs.join('\n\n')
          await this.networkBooks.writeChapter(id, index, content.text, text)
          const info = await this.cacheInfo(id, meta)
          await this.library.update(id, {
            networkCache: info,
            downloadState: downloadState(info.cached, info.total)
          })
          return text
        })
      )
    )
    this.chapterRequests.set(key, request)
    try {
      return { text: await request, cached: false }
    } finally {
      this.chapterRequests.delete(key)
    }
  }

  async networkCacheOf(id: string): Promise<{ cached: number; total: number }> {
    const meta = await this.networkBooks.readMeta(id)
    return this.cacheInfo(id, meta)
  }

  private async cacheInfo(id: string, meta: BookMeta): Promise<{ cached: number; total: number }> {
    const cached = await this.networkBooks.listCachedChapters(id)
    return networkCacheFor(meta.chapters, new Set(cached))
  }

  async entryFor(id: string): Promise<LibraryEntry> {
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书')
    return entry
  }

  cancelBookTasks(id: string): void {
    const job = this.downloadJobs.get(id)
    if (job) job.controller.abort()
  }

  async relinkSources(): Promise<void> {
    const sources = await this.sources.list()
    const byUrl = new Map(sources.map((source) => [source.url, source]))
    for (const entry of await this.library.list()) {
      if (entry.format !== 'network' || !entry.sourceId) continue
      const meta = await this.networkBooks.readMeta(entry.id)
      if (!meta.network) continue
      if (sources.some((source) => source.id === meta.network!.sourceId)) continue
      const replacement = byUrl.get(meta.network.sourceUrl)
      if (!replacement) continue
      meta.network.sourceId = replacement.id
      meta.network.sourceName = replacement.name
      await this.networkBooks.writeMeta(entry.id, meta)
      await this.library.update(entry.id, {
        sourceId: replacement.id,
        sourceName: replacement.name
      })
    }
  }
}
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/network-book.test.ts`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/network/bookService.ts src/main/services/network/limits.ts tests/network-book.test.ts src/main/storage/networkBook.ts
git commit -m "feat(network): add network books and read chapters on demand"
```

---

### Task 9: 更新目录、下载全本、取消与续传

**Files:**
- Modify: `src/main/services/network/bookService.ts`
- Test: `tests/network-download.test.ts`

**Interfaces:**
- Consumes: Task 8 的 `NetworkBookService`、`SourceReader.toc/content`、`NetworkBookRepository`。
- Produces: `updateToc(id)`、`downloadAll(id, onProgress)`、`cancelDownload(id)`；`DownloadDone`。

- [ ] **Step 1: 写失败测试**

把 Task 8 `tests/network-book.test.ts` 里的 imports、`let root`/`beforeEach`/`afterEach` 和 `setup()` 原样复制到 `tests/network-download.test.ts`，再追加下面的用例：

```ts
it('appends new toc chapters without dropping cached ones', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  await service.readChapter(entry.id, 0)
  const result = await service.updateToc(entry.id)
  expect(result.added).toBe(0)
  expect(result.total).toBe(2)
  expect((await service.networkCacheOf(entry.id)).cached).toBe(1)
})

it('downloads all uncached chapters and reports progress', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  const events: { done: number; total: number }[] = []
  const done = await service.downloadAll(entry.id, (event) => events.push(event))
  expect(done.failedChapters).toEqual([])
  expect(done.cancelled).toBe(false)
  expect((await service.networkCacheOf(entry.id)).cached).toBe(2)
  expect(events.at(-1)).toMatchObject({ done: 2, total: 2 })
})

it('cancels a running download and finishes from the cache next time', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  server.delayMs = 100
  const running = service.downloadAll(entry.id, () => {})
  setTimeout(() => service.cancelDownload(entry.id), 20)
  const first = await running
  expect(first.cancelled).toBe(true)
  server.delayMs = 0
  const second = await service.downloadAll(entry.id, () => {})
  expect(second.cancelled).toBe(false)
  expect(second.failedChapters).toEqual([])
  expect((await service.networkCacheOf(entry.id)).cached).toBe(2)
})

it('keeps state partial when some chapters fail', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  server.failNext = true
  const done = await service.downloadAll(entry.id, () => {})
  expect(done.failedChapters.length).toBeGreaterThan(0)
  expect((await service.networkCacheOf(entry.id)).cached).toBeLessThan(2)
})
```

Task 6 的 `startFakeServer` 已经带 `failNext`（下一次请求返回 500）和 `delayMs`（延迟应答）字段，取消测试直接用，不需要再改 helper。

- [ ] **Step 2: 实现 `updateToc`**

```ts
  async updateToc(id: string): Promise<UpdateTocResult> {
    assertBookId(id)
    this.ensureNetwork()
    return this.locks.run(`book:${id}`, async () => {
      const meta = await this.networkBooks.readMeta(id)
      if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
      const source = await this.sources.require(meta.network.sourceId)
      const toc = await this.reader.toc(source, {
        bookUrl: meta.network.bookUrl,
        tocUrl: meta.network.tocUrl
      })
      const result = diffToc(meta.chapters, toc.chapters)
      meta.chapters = result.chapters
      meta.network.lastTocAt = new Date().toISOString()
      meta.network.lastCheckAt = meta.network.lastTocAt
      if (result.lastChapter) meta.network.lastChapter = result.lastChapter
      await this.networkBooks.writeMeta(id, meta)
      const cache = await this.cacheInfo(id, meta)
      await this.library.update(id, {
        chapterCount: meta.chapters.length,
        networkCache: cache,
        downloadState: downloadState(cache.cached, cache.total),
        lastUpdateAt: meta.network.lastTocAt
      })
      return {
        added: result.added,
        total: meta.chapters.length,
        warnings: toc.warnings,
        ...(result.lastChapter ? { lastChapter: result.lastChapter } : {})
      }
    })
  }
```

- [ ] **Step 3: 实现 `downloadAll`**

```ts
  downloadAll(
    id: string,
    onProgress: (event: DownloadProgress) => void
  ): Promise<DownloadDone> {
    assertBookId(id)
    this.ensureNetwork()
    const existing = this.downloadJobs.get(id)
    if (existing) return existing.done as Promise<DownloadDone>
    const controller = new AbortController()
    // 先把任务放进 map，取消请求才能看到它。
    const done = this.runDownload(id, controller, onProgress).finally(() => {
      this.downloadJobs.delete(id)
    })
    this.downloadJobs.set(id, { controller, done })
    return done
  }

  private async runDownload(
    id: string,
    controller: AbortController,
    onProgress: (event: DownloadProgress) => void
  ): Promise<DownloadDone> {
    // 下载、更新目录、转本地共用每本书的锁，互斥执行。
    return this.locks.run(`book:${id}`, async () => {
      const meta = await this.networkBooks.readMeta(id)
      if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
      const pending = meta.chapters.filter(
        (chapter) => chapter.level !== 'volume' && chapter.url
      )
      const cached = new Set(await this.networkBooks.listCachedChapters(id))
      const todo = pending.filter((chapter) => !cached.has(chapter.index))
      const failedChapters: DownloadFailedChapter[] = []
      let done = pending.length - todo.length
      onProgress({ bookId: id, done, total: pending.length, failed: 0 })

      // readChapter 内部有每书 2 的并发上限，这里 4 个 worker 实际最多同时跑 2 章。
      const queue = [...todo]
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          if (controller.signal.aborted) return
          const chapter = queue.shift()
          if (!chapter) return
          try {
            await this.readChapter(id, chapter.index)
            done++
          } catch (error) {
            if (controller.signal.aborted) return
            failedChapters.push({
              index: chapter.index,
              title: chapter.title,
              message: error instanceof Error ? error.message : '下载失败'
            })
          } finally {
            onProgress({ bookId: id, done, total: pending.length, failed: failedChapters.length })
          }
        }
      })
      await Promise.all(workers)

      const cache = await this.cacheInfo(id, meta)
      const state = downloadState(cache.cached, cache.total)
      await this.library.update(id, {
        networkCache: cache,
        downloadState: state,
        ...(state === 'complete' ? { lastUpdateAt: new Date().toISOString() } : {})
      })
      if (state === 'complete') {
        meta.network.lastDownloadAt = new Date().toISOString()
        await this.networkBooks.writeMeta(id, meta)
      }
      return {
        bookId: id,
        done,
        total: pending.length,
        failedChapters,
        cancelled: controller.signal.aborted
      }
    })
  }

  cancelDownload(id: string): void {
    const job = this.downloadJobs.get(id)
    if (!job) return
    job.controller.abort()
  }
```

- [ ] **Step 4: 运行测试**

Run: `npx vitest run tests/network-download.test.ts`
Expected: PASS。先实现 helper 的 `failNext`。

- [ ] **Step 5: 提交**

```bash
git add src/main/services/network/bookService.ts tests/network-download.test.ts tests/helpers/networkServer.ts
git commit -m "feat(network): update toc and download whole network books"
```

---

### Task 10: 转本地书、书源删除与重新关联

**Files:**
- Modify: `src/main/services/network/bookService.ts`
- Modify: `src/main/services/network/sourceService.ts`
- Test: `tests/network-convert.test.ts`

**Interfaces:**
- Consumes: `NetworkBookRepository`、`BookRepository.writeBook()`、`LibraryRepository.update()`。
- Produces: `convertToLocal(id)`、`relinkSources()`；删除书源后书架仍可读已缓存章节。

- [ ] **Step 1: 写失败测试**

把 Task 8 `tests/network-book.test.ts` 里的 imports、`let root`/`beforeEach`/`afterEach` 和 `setup()` 原样复制到 `tests/network-convert.test.ts`（`setup()` 返回 `{ server, service, library, books, networkBooks, source }`），再追加下面的用例：

```ts
it('refuses conversion before the whole book is downloaded', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  await expect(service.convertToLocal(entry.id)).rejects.toThrow('未下载全本')
})

it('converts a complete network book to a local book and keeps progress', async () => {
  const { service, server, books, library, networkBooks } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  await service.downloadAll(entry.id, () => {})
  // raw 首行与章节标题相同时，转换后只保留一行标题。
  await networkBooks.writeChapter(entry.id, 1, '第二章\n正文二', '正文二')
  await books.writeProgress(entry.id, {
    progress: { chapterKey: 'x', chapterIndex: 1, paragraphIndex: 0, percent: 50, updatedAt: new Date().toISOString() },
    bookmarks: []
  })
  const result = await service.convertToLocal(entry.id)
  expect(result.chapterCount).toBe(2)
  expect(result.warnings).toEqual([])
  const meta = await books.readMeta(entry.id)
  expect(meta.format).toBe('txt')
  expect(meta.network).toBeUndefined()
  expect(meta.chapters[1].url).toBeUndefined()
  // startLine 对齐 source.txt，charCount/simhash 用清洗后正文回填。
  const lines = (await books.readSource(entry.id)).split(/\r?\n/)
  expect(lines[meta.chapters[1].startLine]).toBe('第二章')
  expect(lines.filter((line) => line === '第二章')).toHaveLength(1)
  expect(meta.chapters[1].charCount).toBe('正文二'.length)
  expect(meta.chapters[1].simhash).not.toBe('')
  const updated = (await library.list()).find((item) => item.id === entry.id)!
  expect(updated.format).toBe('txt')
  expect(updated.sourceName).toBe('源A')
  expect(updated.downloadState).toBeUndefined()
  expect(updated.progressPercent).toBe(0)
  expect((await books.readProgress(entry.id)).progress?.chapterIndex).toBe(1)
  expect(await books.readChapter(entry.id, 1)).toContain('正文二')
})

it('keeps cached chapters readable after the source is deleted', async () => {
  const { service, server } = await setup()
  const entry = await service.add({ sourceId: (await service.sources.list())[0].id, bookUrl: `${server.url}/info` })
  await service.readChapter(entry.id, 0)
  await service.sources.remove((await service.sources.list())[0].id)
  expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
  await expect(service.readChapter(entry.id, 1)).rejects.toThrow('书源已删除')
})
```

- [ ] **Step 2: 实现 `convertToLocal`**

在 `bookService.ts` 顶部补充导入：

```ts
import { buildBookDocuments } from '../../../core/compose'
import { buildChapterMetas } from '../../../core/pipeline'
import type { BookMeta, ChapterMeta, CleanedChapter, LibraryEntry } from '../../../core/model'
```

在 `readChapter` 开头（`assertBookId(id)` 之后）加：

```ts
    if (this.converting.has(id)) throw new Error('正在转为本地书，请稍候')
```

类里新增字段：

```ts
  private readonly converting = new Set<string>()
```

方法：

```ts
  async convertToLocal(id: string): Promise<ConvertToLocalResult> {
    assertBookId(id)
    if (this.converting.has(id)) throw new Error('正在转为本地书，请稍候')
    this.converting.add(id)
    this.cancelBookTasks(id)
    try {
      // 等正在读的章节落盘；之后新的读章请求会被 converting 挡住。
      const pendingReads = [...this.chapterRequests.entries()]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([, request]) => request.catch(() => undefined))
      await Promise.all(pendingReads)

      return await this.locks.run(`book:${id}`, async () => {
        const meta = await this.networkBooks.readMeta(id)
        if (meta.format !== 'network') throw new Error('这本书已经是本地书')
        const cache = await this.cacheInfo(id, meta)
        if (cache.total === 0 || cache.cached < cache.total) {
          throw new Error('未下载全本，无法转为本地书')
        }
        const progress = await this.books.readProgress(id)
        const bookDir = join(this.root, 'books', id)
        const snapshot = join(this.root, '.convert', `${id}-${Date.now()}`)
        await fs.mkdir(join(this.root, '.convert'), { recursive: true })
        await fs.cp(bookDir, snapshot, { recursive: true })
        const warnings: string[] = []
        try {
          const sourceChapters: CleanedChapter[] = []
          const cleanedChapters: CleanedChapter[] = []
          for (const chapter of meta.chapters) {
            if (chapter.level === 'volume') {
              const empty: CleanedChapter = {
                title: chapter.title,
                level: 'volume',
                startLine: 0,
                paragraphs: []
              }
              sourceChapters.push(empty)
              cleanedChapters.push({ ...empty })
              continue
            }
            const raw = await this.networkBooks.readRawChapter(id, chapter.index)
            const cleaned = (await this.networkBooks.readChapterText(id, chapter.index)) ?? ''
            if (!raw) {
              warnings.push(`第 ${chapter.index + 1} 章《${chapter.title}》缺少原始正文，已用清洗后正文替代`)
            }
            const sourceParagraphs = (raw ?? cleaned)
              .split(/\r?\n/)
              .map((line) => line.trim())
              .filter(Boolean)
            if (sourceParagraphs[0] === chapter.title) sourceParagraphs.shift()
            sourceChapters.push({
              title: chapter.title,
              level: chapter.level,
              startLine: 0,
              paragraphs: sourceParagraphs
            })
            cleanedChapters.push({
              title: chapter.title,
              level: chapter.level,
              startLine: 0,
              paragraphs: cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
            })
          }

          // source.txt 与每章 startLine 由 raw 正文生成；charCount/simhash
          // 必须用清洗后正文，保证同书合并与重复章节检测正常。
          const documents = buildBookDocuments({
            id,
            title: meta.title,
            encoding: 'utf-8',
            createdAt: meta.createdAt,
            chapters: sourceChapters,
            format: 'txt',
            ...(meta.author ? { author: meta.author } : {}),
            ...(meta.cover ? { cover: meta.cover } : {})
          })
          const cleanedMetas = buildChapterMetas(cleanedChapters)
          const localMeta: BookMeta = {
            ...documents.meta,
            chapters: documents.meta.chapters.map((chapter, index) => ({
              ...chapter,
              charCount: cleanedMetas[index].charCount,
              simhash: cleanedMetas[index].simhash,
              flags: cleanedMetas[index].flags
            })),
            ...(meta.intro ? { intro: meta.intro } : {}),
            ...(meta.kind ? { kind: meta.kind } : {})
          }

          await this.books.writeBook(
            { meta: localMeta, sourceText: documents.sourceText, chapters: cleanedChapters },
            { backup: false }
          )
          await this.books.writeProgress(id, progress)
          await this.library.update(id, {
            format: 'txt',
            sourceId: undefined,
            networkCache: undefined,
            downloadState: undefined
          })
          return {
            id,
            chapterCount: localMeta.chapters.length,
            warnings
          }
        } catch (reason) {
          await fs.rm(bookDir, { recursive: true, force: true })
          await fs.rename(snapshot, bookDir)
          throw reason
        } finally {
          await fs.rm(snapshot, { recursive: true, force: true })
        }
      })
    } finally {
      this.converting.delete(id)
    }
  }
```

- [ ] **Step 3: 补重新关联的测试**

`relinkSources` 已在 Task 8 实现；这里补集成测试：

```ts
it('relinks a network book when the same source URL is imported again', async () => {
  const { service, server, library } = await setup()
  const sourceId = (await service.sources.list())[0].id
  const entry = await service.add({ sourceId, bookUrl: `${server.url}/info` })
  const raw = await service.sources.raw(sourceId)
  await service.sources.remove(sourceId)
  expect((await library.list())[0].sourceId).toBe(sourceId)

  await service.sources.importJson(JSON.stringify(raw))
  const fresh = (await service.sources.list()).find((item) => item.url === server.url)!
  expect(fresh.id).not.toBe(sourceId)
  await service.relinkSources()
  expect((await library.list())[0].sourceId).toBe(fresh.id)
  expect((await service.updateToc(entry.id)).total).toBe(2)
})
```

- [ ] **Step 4: 运行测试并提交**

Run: `npx vitest run tests/network-convert.test.ts`
Expected: PASS。

```bash
git add src/main/services/network/bookService.ts src/main/services/network/sourceService.ts tests/network-convert.test.ts
git commit -m "feat(network): convert downloaded books to local and relink sources"
```

---

### Task 11: 阅读器与全书搜索的懒加载

**Files:**
- Modify: `src/main/services/reader.ts`
- Modify: `src/main/services/search.ts`
- Modify: `src/shared/api.ts`（`SearchResults` 增加字段）
- Test: `tests/network-reader.test.ts`

**Interfaces:**
- Consumes: `NetworkBookRepository`（Task 5）。
- Produces: `ReaderService.open()` 对网络书返回 `contentMode:'lazy'`、`chapters:[]`、`cachedChapters`；`SearchService.search()` 对网络书只扫缓存并返回 `cachedOnly`/`skippedUncached`。

- [ ] **Step 1: 写失败测试**

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { ReaderService } from '../src/main/services/reader'
import { SearchService } from '../src/main/services/search'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-netread-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('network book reading', () => {
  it('opens a network book lazily and only lists cached chapter indexes', async () => {
    const books = new BookRepository(root)
    const network = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const, id: 'b1', title: '网络书', encoding: 'utf-8', format: 'network' as const,
      chapters: [
        { index: 0, title: '一', level: 'chapter' as const, titleHash: 'a', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'https://example.com/1' },
        { index: 1, title: '二', level: 'chapter' as const, titleHash: 'b', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'https://example.com/2' }
      ],
      createdAt: new Date().toISOString(),
      network: { sourceId: 's1', sourceUrl: 'https://example.com', sourceName: '源', bookUrl: 'https://example.com/b', tocUrl: 'https://example.com/toc', lastTocAt: null, lastCheckAt: null }
    }
    await network.create(meta)
    await network.writeChapter('b1', 1, '原始', '清洗后')
    const payload = await new ReaderService(new LibraryRepository(root), books, network).open('b1')
    expect(payload.contentMode).toBe('lazy')
    expect(payload.chapters).toEqual([])
    expect(payload.cachedChapters).toEqual([1])

    const localMeta = { ...meta, id: 'b2', format: 'txt' as const, network: undefined, chapters: [{ ...meta.chapters[0], url: undefined }] }
    await books.writeBook({ meta: localMeta, sourceText: '一\n\n正文', chapters: [{ title: '一', level: 'chapter', startLine: 0, paragraphs: ['正文'] }] })
    const local = await new ReaderService(new LibraryRepository(root), books, network).open('b2')
    expect(local.contentMode).toBe('eager')
    expect(local.chapters).toEqual(['正文'])
    expect(local.cachedChapters).toEqual([])

    // A book imported before `format` existed has no field at all and must
    // keep the eager local path.
    const legacyMeta = { ...localMeta, id: 'b3', format: undefined }
    await books.writeBook({
      meta: legacyMeta,
      sourceText: '一\n\n旧正文',
      chapters: [{ title: '一', level: 'chapter', startLine: 0, paragraphs: ['旧正文'] }]
    })
    const legacy = await new ReaderService(new LibraryRepository(root), books, network).open('b3')
    expect(legacy.contentMode).toBe('eager')
    expect(legacy.chapters).toEqual(['旧正文'])
  })

  it('searches only cached network chapters and says so', async () => {
    const books = new BookRepository(root)
    const network = new NetworkBookRepository(root)
    const meta = {
      version: 1 as const, id: 'b1', title: '网络书', encoding: 'utf-8', format: 'network' as const,
      chapters: [0, 1].map((index) => ({ index, title: `第${index + 1}章`, level: 'chapter' as const, titleHash: `h${index}`, startLine: 0, charCount: 0, simhash: '', flags: {}, url: `https://example.com/${index}` })),
      createdAt: new Date().toISOString(),
      network: { sourceId: 's1', sourceUrl: 'https://example.com', sourceName: '源', bookUrl: 'https://example.com/b', tocUrl: 'https://example.com/toc', lastTocAt: null, lastCheckAt: null }
    }
    await network.create(meta)
    await network.writeChapter('b1', 0, '原始', '这里有关键词')
    const result = await new SearchService(books, network).search('b1', '关键词', 't1', () => {})
    expect(result.hits).toHaveLength(1)
    expect(result.cachedOnly).toBe(true)
    expect(result.skippedUncached).toBe(1)
    expect(result.warnings.join('')).toContain('仅搜索已缓存')
  })
})
```

- [ ] **Step 2: 修改 `OpenBookPayload` 与 `SearchResults`**

`src/shared/api.ts`：

```ts
export interface OpenBookPayload {
  meta: BookMeta
  contentMode: 'eager' | 'lazy'
  /** 本地书：全部章节；网络书：[]。 */
  chapters: string[]
  /** 网络书：已缓存章节索引；本地书：[]。 */
  cachedChapters: number[]
  warnings: string[]
  progress: BookProgress | null
  bookmarks: Bookmark[]
}
```

```ts
export interface SearchResults {
  token: string
  hits: SearchHit[]
  warnings: string[]
  truncated: boolean
  cancelled: boolean
  /** 网络书只搜索了已缓存章节。 */
  cachedOnly: boolean
  /** 网络书因未缓存而跳过的章节数。 */
  skippedUncached: number
}
```

- [ ] **Step 3: 修改 `ReaderService`**

```ts
import type { NetworkBookRepository } from '../storage/networkBook'

export class ReaderService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly networkBooks?: NetworkBookRepository
  ) {}

  async open(id: string): Promise<OpenBookPayload> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const stored = await this.books.readProgress(id)
    if (meta.format === 'network') {
      const cachedChapters = this.networkBooks
        ? await this.networkBooks.listCachedChapters(id)
        : []
      return {
        meta,
        contentMode: 'lazy',
        chapters: [],
        cachedChapters,
        warnings: [],
        progress: stored.progress,
        bookmarks: stored.bookmarks
      }
    }
    const chapters: string[] = []
    const warnings: string[] = []
    // Loaded only when a chapter file is unusable; null means it is gone too.
    let sourceText: string | null | undefined
    for (const chapter of meta.chapters) {
      try {
        chapters.push(await this.books.readChapter(id, chapter.index))
        continue
      } catch {
        // Rebuild below from the pre-cleaning source that every book keeps.
      }

      if (sourceText === undefined) {
        sourceText = await this.books.readSource(id).catch(() => null)
      }
      const rebuilt =
        sourceText === null
          ? ''
          : chapterFromLines(sourceText, meta, chapter.index).paragraphs.join('\n\n').trim()

      if (rebuilt === '') {
        chapters.push(MISSING_CHAPTER_PLACEHOLDER)
        warnings.push(
          `第 ${chapter.index + 1} 章《${chapter.title}》文件缺失且无法从原文重建，已显示占位内容`
        )
      } else {
        chapters.push(rebuilt)
        warnings.push(`第 ${chapter.index + 1} 章《${chapter.title}》文件缺失，已从原文重建`)
      }
    }
    return {
      meta,
      contentMode: 'eager',
      chapters,
      cachedChapters: [],
      warnings,
      progress: stored.progress,
      bookmarks: stored.bookmarks
    }
  }
}
```

`readProgress` 提前读取，原来的 `const stored` 删除。网络分支不读 `source.txt`，避免网络书没有该文件时报错。

- [ ] **Step 4: 修改 `SearchService`**

```ts
import type { SearchHit, SearchProgress, SearchResults } from '../../shared/api'
import { splitParagraphs } from '../../core/paragraphs'
import { chapterFromLines } from '../../core/reprocess'
import type { BookRepository } from '../storage/book'
import type { NetworkBookRepository } from '../storage/networkBook'
import { assertBookId } from '../bookId'

const MAX_HITS = 300

export class SearchService {
  constructor(
    private readonly books: BookRepository,
    private readonly networkBooks?: NetworkBookRepository
  ) {}

  async search(
    id: string,
    query: string,
    token: string,
    onProgress: (payload: SearchProgress) => void
  ): Promise<SearchResults> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const network = meta.format === 'network'
    const cached =
      network && this.networkBooks
        ? new Set(await this.networkBooks.listCachedChapters(id))
        : null
    const searchable = network
      ? meta.chapters.filter(
          (chapter) => chapter.level !== 'volume' && chapter.url && cached?.has(chapter.index)
        )
      : meta.chapters
    const indexes = searchable.map((chapter) => chapter.index)
    const contentCount = network
      ? meta.chapters.filter((chapter) => chapter.level !== 'volume' && chapter.url).length
      : meta.chapters.length
    const skippedUncached = network ? contentCount - indexes.length : 0
    const warnings: string[] = []
    if (network) {
      warnings.push(`仅搜索已缓存章节（${indexes.length}/${contentCount} 章）`)
    }
    const base = { token, warnings, cachedOnly: network, skippedUncached }
    const needle = query.trim().toLowerCase()
    const hits: SearchHit[] = []
    if (!needle) return { ...base, hits, truncated: false, cancelled: false }

    // Loaded only when a chapter file is unusable; null means it is gone too.
    let sourceText: string | null | undefined
    for (let position = 0; position < indexes.length; position++) {
      if (this.cancelled.delete(token)) {
        return { ...base, hits, truncated: false, cancelled: true }
      }
      const index = indexes[position]

      let text: string | null
      try {
        text = await this.books.readChapter(id, index)
      } catch {
        if (network) {
          // 网络书没有 source.txt，缓存文件读失败就跳过这一章。
          warnings.push(`第 ${index + 1} 章《${meta.chapters[index].title}》读取失败，已跳过`)
          text = null
        } else {
          // Rebuild below from the pre-cleaning source that every book keeps.
          if (sourceText === undefined) {
            sourceText = await this.books.readSource(id).catch(() => null)
          }
          const title = meta.chapters[index].title
          const rebuilt =
            sourceText === null
              ? ''
              : chapterFromLines(sourceText, meta, index).paragraphs.join('\n\n').trim()
          if (rebuilt === '') {
            warnings.push(`第 ${index + 1} 章《${title}》文件缺失且无法从原文重建，已跳过`)
            text = null
          } else {
            warnings.push(`第 ${index + 1} 章《${title}》文件缺失，已从原文重建`)
            text = rebuilt
          }
        }
      }

      if (text !== null) {
        const paragraphs = splitParagraphs(text)

        for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
          const paragraph = paragraphs[paragraphIndex]
          const at = paragraph.toLowerCase().indexOf(needle)
          if (at < 0) continue
          // Truncated means a 301st match exists; keep scanning until one is found.
          if (hits.length >= MAX_HITS) {
            return { ...base, hits, truncated: true, cancelled: false }
          }

          const start = Math.max(0, at - 20)
          const end = Math.min(paragraph.length, at + needle.length + 40)
          hits.push({
            chapterIndex: index,
            chapterKey: meta.chapters[index].titleHash,
            paragraphIndex,
            excerpt: `${start > 0 ? '…' : ''}${paragraph.slice(start, end)}${end < paragraph.length ? '…' : ''}`
          })
        }
      }

      if ((position + 1) % 10 === 0 || position === indexes.length - 1) {
        onProgress({ token, scanned: position + 1, total: indexes.length })
      }
    }

    return { ...base, hits, truncated: false, cancelled: false }
  }
}
```

- [ ] **Step 5: 运行测试**

Run: `npx vitest run tests/network-reader.test.ts tests/search.test.ts`
Expected: PASS；本地搜索测试需要补齐 `cachedOnly`/`skippedUncached` 断言或调用方默认值。所有返回对象必须显式带这两个字段。

- [ ] **Step 6: 提交**

```bash
git add src/main/services/reader.ts src/main/services/search.ts src/shared/api.ts tests/network-reader.test.ts tests/search.test.ts
git commit -m "feat(network): lazy-load network chapters and cache-only search"
```

---

### Task 12: IPC、preload 与主进程装配

**Files:**
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/shared/api.ts`
- Test: `tests/ipc-contract.test.ts`

**Interfaces:**
- Consumes: Task 7/8/9/10 的服务。
- Produces: `ReaderApi` 的所有网络方法；`window.api` 可用；主进程启动时修复 `sources.json`。

- [ ] **Step 1: 写 IPC 契约测试**

测试不启动 Electron，只校验 `ReaderApi` 的键与 preload 映射表一致。先把 preload 的映射抽成 `src/preload/channels.ts`：

```ts
import type { ReaderApi } from '../shared/api'

export const INVOKE_CHANNELS = {
  sourceList: 'source:list',
  importSources: 'source:import',
  setSourceFlags: 'source:flags',
  sourceRaw: 'source:raw',
  deleteSource: 'source:delete',
  searchNetwork: 'network:search',
  cancelNetworkSearch: 'network:search-cancel',
  addNetworkBook: 'network:add-book',
  updateToc: 'network:update-toc',
  downloadAll: 'network:download-all',
  cancelDownload: 'network:download-cancel',
  readNetworkChapter: 'network:read-chapter',
  convertToLocal: 'network:convert'
} satisfies Partial<Record<keyof ReaderApi, string>>
```

`preload/index.ts` 用该表调用 `invoke`；`tests/ipc-contract.test.ts` 检查每个键都存在：

```ts
import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS } from '../src/preload/channels'

describe('preload IPC contract', () => {
  it('maps every network method to a channel', () => {
    for (const key of [
      'sourceList', 'importSources', 'setSourceFlags', 'sourceRaw', 'deleteSource',
      'searchNetwork', 'cancelNetworkSearch', 'addNetworkBook', 'updateToc',
      'downloadAll', 'cancelDownload', 'readNetworkChapter', 'convertToLocal'
    ] as const) {
      expect(INVOKE_CHANNELS[key], key).toMatch(/^(source|network):/)
    }
  })
})
```

- [ ] **Step 2: 扩展 `ReaderApi`**

`src/shared/api.ts` 的 `ReaderApi` 接口末尾增加（事件类型与请求类型已在 Task 1 定义）：

```ts
  sourceList(): Promise<SourceListItem[]>
  importSources(request: SourceImportRequest): Promise<ImportSourcesResult>
  setSourceFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<SourceListItem[]>
  sourceRaw(id: string): Promise<Record<string, unknown> | null>
  deleteSource(id: string): Promise<void>

  searchNetwork(request: NetworkSearchRequest): Promise<NetworkSearchDone>
  cancelNetworkSearch(requestId: string): Promise<void>
  addNetworkBook(input: AddNetworkBookInput): Promise<LibraryEntry>
  updateToc(id: string): Promise<UpdateTocResult>
  downloadAll(id: string): Promise<DownloadDone>
  cancelDownload(id: string): Promise<void>
  readNetworkChapter(id: string, index: number): Promise<NetworkChapterPayload>
  convertToLocal(id: string): Promise<ConvertToLocalResult>

  onNetworkSearchSource(cb: (payload: NetworkSearchSourceEvent) => void): () => void
  onNetworkSearchResults(cb: (payload: NetworkSearchPayload) => void): () => void
  onNetworkSearchDone(cb: (payload: NetworkSearchDone) => void): () => void
  onNetworkSearchError(cb: (payload: { requestId: string; message: string }) => void): () => void
  onDownloadProgress(cb: (payload: DownloadProgress) => void): () => void
  onDownloadDone(cb: (payload: DownloadDone) => void): () => void
  onBookTocUpdated(cb: (payload: { id: string; added: number; total: number }) => void): () => void
```

- [ ] **Step 3: 实现 `preload/index.ts`**

顶部增加 `import { INVOKE_CHANNELS } from './channels'`，在 `api` 对象中增加：

```ts
  sourceList: () => ipcRenderer.invoke(INVOKE_CHANNELS.sourceList),
  importSources: (request) => ipcRenderer.invoke(INVOKE_CHANNELS.importSources, request),
  setSourceFlags: (id, flags) => ipcRenderer.invoke(INVOKE_CHANNELS.setSourceFlags, id, flags),
  sourceRaw: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.sourceRaw, id),
  deleteSource: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.deleteSource, id),
  searchNetwork: (request) => ipcRenderer.invoke(INVOKE_CHANNELS.searchNetwork, request),
  cancelNetworkSearch: (requestId) => ipcRenderer.invoke(INVOKE_CHANNELS.cancelNetworkSearch, requestId),
  addNetworkBook: (input) => ipcRenderer.invoke(INVOKE_CHANNELS.addNetworkBook, input),
  updateToc: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.updateToc, id),
  downloadAll: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.downloadAll, id),
  cancelDownload: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.cancelDownload, id),
  readNetworkChapter: (id, index) => ipcRenderer.invoke(INVOKE_CHANNELS.readNetworkChapter, id, index),
  convertToLocal: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.convertToLocal, id),
  onNetworkSearchSource: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchSourceEvent): void => callback(payload)
    ipcRenderer.on('network:search-source', listener)
    return () => ipcRenderer.removeListener('network:search-source', listener)
  },
  onNetworkSearchResults: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchPayload): void => callback(payload)
    ipcRenderer.on('network:search-results', listener)
    return () => ipcRenderer.removeListener('network:search-results', listener)
  },
  onNetworkSearchDone: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchDone): void => callback(payload)
    ipcRenderer.on('network:search-done', listener)
    return () => ipcRenderer.removeListener('network:search-done', listener)
  },
  onNetworkSearchError: (callback) => {
    const listener = (_e: unknown, payload: { requestId: string; message: string }): void => callback(payload)
    ipcRenderer.on('network:search-error', listener)
    return () => ipcRenderer.removeListener('network:search-error', listener)
  },
  onDownloadProgress: (callback) => {
    const listener = (_e: unknown, payload: DownloadProgress): void => callback(payload)
    ipcRenderer.on('network:download-progress', listener)
    return () => ipcRenderer.removeListener('network:download-progress', listener)
  },
  onDownloadDone: (callback) => {
    const listener = (_e: unknown, payload: DownloadDone): void => callback(payload)
    ipcRenderer.on('network:download-done', listener)
    return () => ipcRenderer.removeListener('network:download-done', listener)
  },
  onBookTocUpdated: (callback) => {
    const listener = (_e: unknown, payload: { id: string; added: number; total: number }): void => callback(payload)
    ipcRenderer.on('network:toc-updated', listener)
    return () => ipcRenderer.removeListener('network:toc-updated', listener)
  }
```

`src/preload/index.ts` 的 import 增加 `NetworkSearchSourceEvent`、`NetworkSearchPayload`、`NetworkSearchDone`、`DownloadProgress`、`DownloadDone` 等事件类型。

- [ ] **Step 4: 装配主进程**

在 `src/main/index.ts` 增加导入：

```ts
import { HttpClient } from './services/network/httpClient'
import { NetworkBookService } from './services/network/bookService'
import { NetworkSearchService } from './services/network/searchService'
import { SourceReader } from './services/network/sourceReader'
import { SourceService } from './services/network/sourceService'
import { SourceStore } from './services/network/sourceStore'
import { NetworkBookRepository } from './storage/networkBook'
```

服务构造：

```ts
const networkBooks = new NetworkBookRepository(dataDir)
const networkHttp = new HttpClient()
const sourceStore = new SourceStore(dataDir)
const sourceService = new SourceService(sourceStore, networkHttp, library)
const sourceReader = new SourceReader(networkHttp)
const networkBookService = new NetworkBookService({
  root: dataDir,
  sources: sourceService,
  reader: sourceReader,
  networkBooks,
  books,
  library,
  cleaning: () => cleaning.currentRunConfig(),
  // 关闭联网后，加入书架/更新目录/下载/拉未缓存章节都在服务层被拒绝；
  // 已缓存章节仍然可读（readChapter 先查缓存再过这个门）。
  allowNetwork: () => settingsRepo.readSync().network.enabled
})
const networkSearch = new NetworkSearchService(sourceService, sourceStore, sourceReader, library)
```

已有 `reader`/`search` 改为：

```ts
const reader = new ReaderService(library, books, networkBooks)
const search = new SearchService(books, networkBooks)
```

`app.whenReady` 中 `library.repair()` 后增加：

```ts
const sourcesRestored = await sourceService.repair()
if (sourcesRestored) logger.info('sources.json restored from backup')
```

- [ ] **Step 5: 注册 IPC**

在 `ipcMain.handle('library:list', ...)` 附近增加：

```ts
    // 关闭联网后，需要访问网络的入口在进程内拒绝；缓存阅读和本地导入不受影响。
    const assertNetworkEnabled = (): void => {
      if (!settingsRepo.readSync().network.enabled) {
        throw new Error('已关闭联网功能，请到设置里打开后再搜索/更新/下载')
      }
    }
    ipcMain.handle('source:list', () => sourceService.list())
    ipcMain.handle('source:import', async (event, request: SourceImportRequest) => {
      if (request.kind === 'json') {
        const result = await sourceService.importJson(request.json, request.dryRun)
        await networkBookService.relinkSources()
        return result
      }
      if (request.kind === 'url') {
        assertNetworkEnabled()
        const result = await sourceService.importUrl(request.url)
        await networkBookService.relinkSources()
        return result
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: '书源 JSON', extensions: ['json', 'txt'] }]
      }
      const selection = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length === 0) {
        return { added: 0, updated: 0, rejected: [], warnings: ['已取消'] }
      }
      const text = await readFile(selection.filePaths[0], 'utf8')
      const result = await sourceService.importJson(text, request.dryRun)
      await networkBookService.relinkSources()
      return result
    })
    ipcMain.handle('source:flags', (_event, id: string, flags: unknown) => {
      if (typeof id !== 'string' || !flags || typeof flags !== 'object') {
        return Promise.reject(new Error('无效的书源参数'))
      }
      return sourceService.setFlags(id, flags as { enabled?: boolean; starred?: boolean; blacklisted?: boolean })
    })
    ipcMain.handle('source:raw', (_event, id: unknown) =>
      typeof id === 'string' ? sourceService.raw(id) : Promise.reject(new Error('无效的书源编号'))
    )
    ipcMain.handle('source:delete', async (_event, id: unknown) => {
      if (typeof id !== 'string') throw new Error('无效的书源编号')
      for (const entry of await library.list()) {
        if (entry.format === 'network' && entry.sourceId === id) {
          networkBookService.cancelBookTasks(entry.id)
        }
      }
      await sourceService.remove(id)
    })
    ipcMain.handle('network:search', (event, request: NetworkSearchRequest) => {
      assertNetworkEnabled()
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (channel: string, payload: unknown): void => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      }
      return networkSearch
        .search(request, {
          source: (payload) => send('network:search-source', payload),
          results: (payload) => send('network:search-results', { requestId: request.requestId, ...payload, scope: request.scope })
        })
        .then((done) => {
          send('network:search-done', done)
          return done
        })
        .catch((reason) => {
          send('network:search-error', {
            requestId: request.requestId,
            message: reason instanceof Error ? reason.message : '搜索失败'
          })
          throw reason
        })
    })
    ipcMain.handle('network:search-cancel', (_event, requestId: string) => {
      networkSearch.cancel(requestId)
    })
    ipcMain.handle('network:add-book', (_event, input: AddNetworkBookInput) =>
      networkBookService.add(input)
    )
    ipcMain.handle('network:update-toc', (event, id: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return networkBookService.updateToc(id).then((result) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('network:toc-updated', { id, added: result.added, total: result.total })
        }
        return result
      })
    })
    ipcMain.handle('network:download-all', (event, id: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return networkBookService.downloadAll(id, (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('network:download-progress', payload)
      }).then((result) => {
        if (win && !win.isDestroyed()) win.webContents.send('network:download-done', result)
        return result
      })
    })
    ipcMain.handle('network:download-cancel', (_event, id: string) => {
      networkBookService.cancelDownload(id)
    })
    ipcMain.handle('network:read-chapter', (_event, id: string, index: number) =>
      networkBookService.readChapter(id, index)
    )
    ipcMain.handle('network:convert', (_event, id: string) =>
      networkBookService.convertToLocal(id)
    )
```

`readFile` 从 `node:fs/promises` 导入；`SourceImportRequest`、`NetworkSearchRequest`、`AddNetworkBookInput` 从 `../shared/api` 导入。

`library:remove` 改为：

```ts
    ipcMain.handle('library:remove', async (_event, id: string) => {
      networkBookService.cancelBookTasks(id)
      await libraryService.remove(id)
    })
```

`app.on('will-quit')` 增加：

```ts
    void sourceStore.flush()
```

- [ ] **Step 6: 运行类型检查与契约测试**

Run: `npx vitest run tests/ipc-contract.test.ts && npx tsc --noEmit`
Expected: PASS。`channels.ts` 若只写了部分键，`satisfies Partial<...>` 不会报缺失；测试检查的是这 13 个网络键，确保它们都在。

- [ ] **Step 7: 提交**

```bash
git add src/main/index.ts src/preload/index.ts src/preload/channels.ts src/shared/api.ts tests/ipc-contract.test.ts
git commit -m "feat(network): wire source and network book IPC"
```

---

### Task 13: 书架网络书标识、下载状态与操作入口

**Files:**
- Create: `src/renderer/src/components/NetworkBookBadge.tsx`
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/components/BookCard.tsx`
- Modify: `src/renderer/src/components/BookInfo.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/network-badge.test.tsx`

**Interfaces:**
- Consumes: `LibraryEntry.format/sourceId/sourceName/networkCache/downloadState`、`DownloadProgress`、`SourceListItem`。
- Produces: 书架网络徽标、下载进度、更新目录/下载全本/取消/转本地菜单；`Library` 新增可选的 `onOpenSources`/`onOpenNetworkSearch`/`networkEnabled` 属性（App 的视图入口在 Task 14/15 接上）。

- [ ] **Step 1: 写组件测试**

`tests/network-badge.test.tsx`（项目已有 React 测试就按其配置；没有则用 `react-dom/server` 的 `renderToStaticMarkup`，避免引入测试库）：

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import NetworkBookBadge from '../src/renderer/src/components/NetworkBookBadge'
import type { LibraryEntry } from '../src/core/model'

const entry: LibraryEntry = {
  id: 'b1', title: '书', format: 'network', sourceId: 's1', sourceName: '源A',
  normalizedTitle: '书', sourceFileName: '书.txt', fileHash: 'x', encoding: 'utf-8',
  importedAt: '2026-01-01', lastReadAt: null, chapterCount: 3,
  progressPercent: 0, stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 },
  networkCache: { cached: 1, total: 3 }, downloadState: 'partial'
}

describe('NetworkBookBadge', () => {
  it('shows source name and download state', () => {
    const html = renderToStaticMarkup(<NetworkBookBadge entry={entry} />)
    expect(html).toContain('网络 · 源A')
    expect(html).toContain('1/3')
    expect(html).toContain('未下载完')
  })

  it('shows deleted source', () => {
    const html = renderToStaticMarkup(<NetworkBookBadge entry={entry} sourceMissing />)
    expect(html).toContain('书源已删除')
  })
})
```

- [ ] **Step 2: 实现 `NetworkBookBadge.tsx`**

```tsx
import type { LibraryEntry } from '../../../core/model'

export default function NetworkBookBadge({
  entry,
  sourceMissing = false,
  progress
}: {
  entry: LibraryEntry
  sourceMissing?: boolean
  progress?: { done: number; total: number }
}) {
  if (entry.format !== 'network') return null
  const cached = progress ? progress.done : (entry.networkCache?.cached ?? 0)
  const total = progress ? progress.total : (entry.networkCache?.total ?? 0)
  const source = sourceMissing ? '书源已删除' : entry.sourceName || '未知书源'
  const state = progress
    ? '下载中'
    : entry.downloadState === 'complete'
      ? '已下载全本'
      : entry.downloadState === 'partial'
        ? '未下载完'
        : '未下载'
  return (
    <span className={`network-badge ${sourceMissing ? 'missing' : ''}`}>
      <span className="network-badge-source">网络 · {source}</span>
      {total > 0 && (
        <span className="network-badge-cache">
          {cached}/{total}
        </span>
      )}
      <span className="network-badge-state">{state}</span>
    </span>
  )
}
```

- [ ] **Step 3: 修改 `BookCard`**

```tsx
import NetworkBookBadge from './NetworkBookBadge'
// props 增加
sourceMissing?: boolean
downloadProgress?: { done: number; total: number }

// sub 行
{entry.format === 'network'
  ? '网络'
  : entry.format === 'epub'
    ? 'EPUB'
    : 'TXT'} · {entry.chapterCount} 章
{entry.format === 'epub' || entry.format === 'network' ? '' : ` · ${entry.encoding}`}

// 在第二个 sub 行前
<NetworkBookBadge
  entry={entry}
  sourceMissing={sourceMissing}
  progress={downloadProgress}
/>
```

- [ ] **Step 4: 修改 `BookInfo`**

```tsx
const network = entry.format === 'network'
<dt>格式</dt>
<dd>{network ? '网络' : epub ? 'EPUB' : 'TXT'}</dd>
{network && (
  <>
    <dt>书源</dt>
    <dd>{entry.sourceName || '未知书源'}</dd>
    <dt>缓存</dt>
    <dd>
      {entry.networkCache?.cached ?? 0}/{entry.networkCache?.total ?? 0} 章
      {entry.downloadState === 'complete' ? ' · 已下载全本' : ' · 未下载完'}
    </dd>
  </>
)}
{!epub && !network && (编码行)}
```

- [ ] **Step 5: 修改 `Library.tsx` 属性和工具栏**

```tsx
export default function Library({
  onOpen,
  onOpenSources,
  onOpenNetworkSearch,
  networkEnabled = true
}: {
  onOpen: (bookId: string) => void
  onOpenSources?: () => void
  onOpenNetworkSearch?: () => void
  networkEnabled?: boolean
}) {
```

工具栏「导入书籍」前增加（回调未接入时不显示，保证本任务结束时 App 仍能编译）：

```tsx
{onOpenNetworkSearch && (
  <button className="ghost" onClick={onOpenNetworkSearch}>
    网络搜索
  </button>
)}
{onOpenSources && (
  <button className="ghost" onClick={onOpenSources}>
    书源
  </button>
)}
```

点击时若 `!networkEnabled`，在各自页面显示关闭提示；工具栏仍可进入，页面给提示，避免用户找不到开关。

- [ ] **Step 6: 下载事件与状态**

在 `Library` 内增加：

```tsx
const [sourceIds, setSourceIds] = useState<Set<string>>(new Set())
const [sourcesLoaded, setSourcesLoaded] = useState(false)
const [downloads, setDownloads] = useState<Record<string, DownloadProgress>>({})
const [downloading, setDownloading] = useState<Set<string>>(new Set())

useEffect(() => {
  void window.api
    .sourceList()
    .then((items) => setSourceIds(new Set(items.map((item) => item.id))))
    .finally(() => setSourcesLoaded(true))
}, [])

useEffect(() => {
  const offProgress = window.api.onDownloadProgress((payload) => {
    setDownloads((current) => ({ ...current, [payload.bookId]: payload }))
  })
  const offDone = window.api.onDownloadDone((payload) => {
    setDownloads((current) => {
      const next = { ...current }
      delete next[payload.bookId]
      return next
    })
    setDownloading((current) => {
      const next = new Set(current)
      next.delete(payload.bookId)
      return next
    })
    if (payload.cancelled) notify('已取消下载')
    else if (payload.failedChapters.length > 0) {
      notify(`下载完成，但有 ${payload.failedChapters.length} 章失败，可再次点击继续`)
    } else notify('已下载全本')
    void refresh()
  })
  return () => { offProgress(); offDone() }
}, [])
```

`refresh` 依赖 `notify` 等，若 lint 报依赖，按现有 `Library` 的写法用 `useCallback` 或忽略（项目现有 effect 不强制 exhaustive-deps 时保持风格）。

- [ ] **Step 7: 菜单分支**

在菜单「查看来源」前增加网络操作：

```tsx
{menu.entry.format === 'network' && (
  <>
    <button
      disabled={actionBusy}
      onClick={() => {
        setMenu(null)
        void runUpdateToc(menu.entry)
      }}
    >
      更新目录
    </button>
    {downloading.has(menu.entry.id) ? (
      <button
        onClick={() => {
          setMenu(null)
          void window.api.cancelDownload(menu.entry.id)
        }}
      >
        取消下载
      </button>
    ) : (
      <button
        disabled={actionBusy}
        onClick={() => {
          setMenu(null)
          setDownloading((current) => new Set(current).add(menu.entry.id))
          void window.api.downloadAll(menu.entry.id).catch((reason) => {
            setDownloading((current) => {
              const next = new Set(current)
              next.delete(menu.entry.id)
              return next
            })
            notify(`下载失败：${errorText(reason)}`)
          })
        }}
      >
        下载全本
      </button>
    )}
    <button
      disabled={menu.entry.downloadState !== 'complete' || actionBusy}
      title={menu.entry.downloadState !== 'complete' ? '未下载全本，无法转为本地书' : undefined}
      onClick={() => {
        setDialog({ kind: 'convert', entry: menu.entry })
        setMenu(null)
      }}
    >
      {menu.entry.downloadState === 'complete' ? '转为本地书…' : '转为本地书（需下载全本）'}
    </button>
  </>
)}
```

本地操作门禁（用户已选方案 A：下载全本后先确认转本地书，再执行本地操作）：

```tsx
// A fully downloaded network book is converted to a local book before any
// local-only edit; an incomplete one is refused with a notice.
const [convertNext, setConvertNext] = useState<Dialog | null>(null)

const ensureLocal = async (entry: LibraryEntry): Promise<boolean> => {
  if (entry.format !== 'network') return true
  if (entry.downloadState !== 'complete') {
    notify('未下载全本，无法执行这个操作')
    return false
  }
  await window.api.convertToLocal(entry.id)
  notify('已转为本地书')
  await refresh()
  return true
}

const openLocalDialog = (entry: LibraryEntry, next: Dialog): void => {
  if (entry.format !== 'network') {
    setDialog(next)
    return
  }
  if (entry.downloadState !== 'complete') {
    notify('未下载全本，无法执行这个操作')
    return
  }
  setConvertNext(next)
  setDialog({ kind: 'convert', entry })
}
```

`Dialog` 的 convert 分支保持 `{ kind: 'convert'; entry: LibraryEntry }`；`confirmConvert` 成功后在 `setDialog(null)` 的位置改为：

```tsx
    const next = convertNext
    setConvertNext(null)
    setDialog(next)
```

菜单里三个本地操作改为 `openLocalDialog(menu.entry, { kind: 'reclean', entry: menu.entry })`、`{ kind: 'resplit' ... }`、`{ kind: 'markers' ... }`。批量操作 `runBatch('reclean' | 'resplit')` 跳过网络书并在结束时提示 `已跳过 N 本未转本地的网络书`。

`切换编码` 只对非 EPUB 且非网络书显示：`menu.entry.format !== 'epub' && menu.entry.format !== 'network'`。「查看来源」对网络书改为禁用并给 `title="网络书没有原始文件"`。

合并前先把候选里的网络书转本地（`confirmCandidate` 里，取 `libraryList()` 之后）：

```tsx
      for (const id of [candidate.targetId, candidate.sourceId]) {
        const entry = existingEntries.find((item) => item.id === id)
        if (entry?.format !== 'network') continue
        if (entry.downloadState !== 'complete') {
          notify(`《${entry.title}》未下载全本，已跳过这一对`)
          const tally = { ...mergeTally, skipped: mergeTally.skipped + 1 }
          setMergeTally(tally)
          finishMerge(mergeCandidates.slice(1), tally)
          return
        }
        await window.api.convertToLocal(id)
      }
```

把 `const existing = new Set((await window.api.libraryList()).map((entry) => entry.id))` 换成先保存 `const existingEntries = await window.api.libraryList()`，再 `const existing = new Set(existingEntries.map((entry) => entry.id))`，然后插入上面的循环；循环之后照原样调用 `mergeBooks`。

`runUpdateToc`：

```tsx
const runUpdateToc = async (entry: LibraryEntry): Promise<void> => {
  try {
    const result = await window.api.updateToc(entry.id)
    notify(result.added > 0 ? `目录已更新，新增 ${result.added} 章` : '目录已是最新')
    await refresh()
  } catch (reason) {
    notify(`更新目录失败：${errorText(reason)}`)
  }
}
```

- [ ] **Step 8: 渲染徽标与删除源判断**

`BookCard` 调用处增加：

```tsx
sourceMissing={
  sourcesLoaded &&
  entry.format === 'network' &&
  Boolean(entry.sourceId) &&
  !sourceIds.has(entry.sourceId!)
}
downloadProgress={downloads[entry.id]}
```

`Dialog` 联合类型增加：

```ts
| { kind: 'convert'; entry: LibraryEntry }
```

渲染确认框：

```tsx
{dialog?.kind === 'convert' && (
  <Modal
    title="转为本地书"
    onClose={() => setDialog(null)}
    footer={
      <>
        <button className="modal-button ghost" onClick={() => setDialog(null)}>取消</button>
        <button
          className="modal-button"
          disabled={actionBusy}
          onClick={() => void confirmConvert(dialog.entry)}
        >
          转为本地书
        </button>
      </>
    }
  >
    <p>将把已缓存正文写成普通 TXT 书，之后可重新清洗、重新切章和合并。</p>
    <p>网络来源信息会保留为来源标记，但不再自动更新目录或下载。</p>
  </Modal>
)}
```

`confirmConvert`：

```tsx
const confirmConvert = async (entry: LibraryEntry): Promise<void> => {
  setActionBusy(true)
  try {
    await window.api.convertToLocal(entry.id)
    setDialog(null)
    notify('已转为本地书')
    await refresh()
  } catch (reason) {
    notify(`转换失败：${errorText(reason)}`)
  } finally {
    setActionBusy(false)
  }
}
```

- [ ] **Step 9: 样式**

```css
.network-badge {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
  margin-top: 4px;
  font-size: 12px;
  color: var(--muted);
}
.network-badge-source {
  padding: 1px 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}
.network-badge.missing .network-badge-source {
  background: color-mix(in srgb, var(--danger) 14%, transparent);
  color: var(--danger);
}
.network-badge-cache { font-variant-numeric: tabular-nums; }
.network-badge-state { opacity: 0.8; }
```

若项目没有 `--accent`/`--danger` 变量，使用现有变量名（先查 `styles.css` 的 `:root`）。

- [ ] **Step 10: 运行测试、类型检查并提交**

Run: `npx vitest run tests/network-badge.test.tsx && npx tsc --noEmit`
Expected: PASS。

```bash
git add src/renderer/src/components/NetworkBookBadge.tsx src/renderer/src/components/BookCard.tsx src/renderer/src/components/BookInfo.tsx src/renderer/src/pages/Library.tsx src/renderer/src/styles.css tests/network-badge.test.tsx
git commit -m "feat(network): show network books and download actions on the shelf"
```

---

### Task 14: 书源管理页与导入对话框

**Files:**
- Create: `src/renderer/src/pages/Sources.tsx`
- Create: `src/renderer/src/components/SourceImportDialog.tsx`
- Create: `src/renderer/src/components/SourceList.tsx`
- Modify: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/source-import-dialog.test.tsx`

**Interfaces:**
- Consumes: `window.api.sourceList/importSources/setSourceFlags/sourceRaw/deleteSource`；`SourceListItem`、`ImportSourcesResult`。
- Produces: 书源列表、导入、启停/标星/拉黑、查看原始 JSON、删除、联网开关。

- [ ] **Step 1: 写导入对话框测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SourceImportDialog from '../src/renderer/src/components/SourceImportDialog'

describe('SourceImportDialog', () => {
  it('renders all three import methods and the unsupported warning', () => {
    const html = renderToStaticMarkup(
      <SourceImportDialog onClose={() => {}} onImported={() => {}} />
    )
    expect(html).toContain('粘贴 JSON')
    expect(html).toContain('选择文件')
    expect(html).toContain('从链接导入')
    expect(html).toContain('JS')
  })
})
```

- [ ] **Step 2: 实现 `SourceImportDialog.tsx`**

```tsx
import { useState } from 'react'
import type { ImportSourcesResult } from '../../../core/booksource/model'
import Modal from './Modal'
import { errorText } from '../errors'

type Tab = 'json' | 'file' | 'url'

export default function SourceImportDialog({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (result: ImportSourcesResult) => void
}) {
  const [tab, setTab] = useState<Tab>('json')
  const [json, setJson] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportSourcesResult | null>(null)

  const run = async (request: Parameters<typeof window.api.importSources>[0]): Promise<void> => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const next = await window.api.importSources(request)
      setResult(next)
      onImported(next)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导入书源"
      onClose={onClose}
      footer={
        <>
          <button className="modal-button ghost" onClick={onClose}>关闭</button>
          <button
            className="modal-button"
            disabled={busy || (tab === 'json' && !json.trim()) || (tab === 'url' && !url.trim())}
            onClick={() => {
              if (tab === 'file') void run({ kind: 'file' })
              else if (tab === 'json') void run({ kind: 'json', json })
              else void run({ kind: 'url', url: url.trim() })
            }}
          >
            {busy ? '导入中…' : '导入'}
          </button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        {([
          ['json', '粘贴 JSON'],
          ['file', '选择文件'],
          ['url', '从链接导入']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'json' && (
        <textarea
          className="source-json"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder='粘贴「阅读」书源 JSON，支持单个对象或数组。'
          spellCheck={false}
        />
      )}
      {tab === 'file' && (
        <p className="hint">选择一个或多个「阅读」书源 JSON 文件（只支持文字书源）。</p>
      )}
      {tab === 'url' && (
        <input
          className="source-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/sources.json"
        />
      )}
      <p className="hint">
        只支持文字书源；使用 JS、XPath、WebView 或登录规则的书源会标记为「部分兼容」。不内置、不推荐任何书源。
      </p>
      {error && <p className="error">{error}</p>}
      {result && (
        <div className="import-result">
          <p>新增 {result.added} 个，更新 {result.updated} 个。</p>
          {result.rejected.length > 0 && (
            <details>
              <summary>{result.rejected.length} 个未导入</summary>
              <ul>
                {result.rejected.map((item, index) => (
                  <li key={index}>{item.name ?? item.url ?? '未命名'}：{item.reason}</li>
                ))}
              </ul>
            </details>
          )}
          {result.warnings.length > 0 && (
            <ul className="warn">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  )
}
```

文件多选目前 IPC 只返回第一个文件；v1 接受单选。`PROPERTIES` 用 `['openFile']`，不要写多选。

- [ ] **Step 3: 实现 `SourceList.tsx`**

```tsx
import type { SourceListItem } from '../../../core/booksource/model'

function scoreClass(score: number): string {
  return score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad'
}

export default function SourceList({
  sources,
  onFlags,
  onRaw,
  onDelete
}: {
  sources: SourceListItem[]
  onFlags: (source: SourceListItem, flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }) => void
  onRaw: (source: SourceListItem) => void
  onDelete: (source: SourceListItem) => void
}) {
  if (sources.length === 0) return <p className="empty">还没有书源，先导入一个。</p>
  return (
    <div className="source-list">
      {sources.map((source) => (
        <article key={source.id} className={`source-row ${source.enabled ? '' : 'disabled'}`}>
          <div className="source-main">
            <div className="source-title">
              <strong>{source.name}</strong>
              {source.starred && <span className="tag star">标星</span>}
              {source.blacklisted && <span className="tag black">拉黑</span>}
              {source.compat.level === 'partial' && <span className="tag partial">部分兼容</span>}
            </div>
            <div className="source-sub">{source.group || '未分组'} · {source.url}</div>
            <div className="source-sub">
              评分 <span className={`score ${scoreClass(source.score)}`}>{source.score.toFixed(1)}</span>
              {' · '}搜索成功率 {(source.searchSuccessRate * 100).toFixed(0)}%
              {' · '}平均 {source.avgMs} ms
              {' · '}书架 {source.bookCount ?? 0} 本
            </div>
            {source.compat.issues.length > 0 && (
              <div className="source-sub warn">{source.compat.issues.join('、')}</div>
            )}
            {source.lastError && (
              <div className="source-sub warn">
                最近失败：{source.lastError.operation} · {source.lastError.message}
              </div>
            )}
          </div>
          <div className="source-actions">
            <label>
              <input type="checkbox" checked={source.enabled} onChange={(event) => onFlags(source, { enabled: event.target.checked })} />
              启用
            </label>
            <label>
              <input type="checkbox" checked={source.starred} onChange={(event) => onFlags(source, { starred: event.target.checked })} />
              标星
            </label>
            <label>
              <input type="checkbox" checked={source.blacklisted} onChange={(event) => onFlags(source, { blacklisted: event.target.checked })} />
              拉黑
            </label>
            <button className="ghost" onClick={() => onRaw(source)}>查看 JSON</button>
            <button className="danger" onClick={() => onDelete(source)}>删除</button>
          </div>
        </article>
      ))}
    </div>
  )
}
```

- [ ] **Step 4: 实现 `Sources.tsx`**

```tsx
import { useEffect, useState } from 'react'
import type { SourceListItem } from '../../../core/booksource/model'
import type { ImportSourcesResult } from '../../../core/booksource/model'
import Modal from '../components/Modal'
import SourceImportDialog from '../components/SourceImportDialog'
import SourceList from '../components/SourceList'
import { errorText } from '../errors'

export default function Sources({ onBack }: { onBack: () => void }) {
  const [sources, setSources] = useState<SourceListItem[]>([])
  const [importing, setImporting] = useState(false)
  const [raw, setRaw] = useState<{ source: SourceListItem; json: string } | null>(null)
  const [deleting, setDeleting] = useState<SourceListItem | null>(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')

  const refresh = async (): Promise<void> => {
    setSources(await window.api.sourceList())
  }

  useEffect(() => {
    void refresh().catch((reason) => setError(errorText(reason)))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const onImported = (result: ImportSourcesResult): void => {
    setToast(`新增 ${result.added} 个，更新 ${result.updated} 个`)
    void refresh()
  }

  const onFlags = async (
    source: SourceListItem,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<void> => {
    try {
      setSources(await window.api.setSourceFlags(source.id, flags))
    } catch (reason) {
      setToast(`保存失败：${errorText(reason)}`)
    }
  }

  const onRaw = async (source: SourceListItem): Promise<void> => {
    try {
      const definition = await window.api.sourceRaw(source.id)
      setRaw({ source, json: JSON.stringify(definition, null, 2) })
    } catch (reason) {
      setToast(`读取失败：${errorText(reason)}`)
    }
  }

  const onDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await window.api.deleteSource(deleting.id)
      setDeleting(null)
      setToast('书源已删除；已加入书架的书仍可读已缓存章节')
      await refresh()
    } catch (reason) {
      setToast(`删除失败：${errorText(reason)}`)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="ghost" onClick={onBack}>← 书架</button>
        <h1>书源</h1>
        <div className="toolbar-actions">
          <button onClick={() => setImporting(true)}>导入书源</button>
        </div>
      </header>
      {error && <p className="error">{error}</p>}
      <SourceList sources={sources} onFlags={(source, flags) => void onFlags(source, flags)} onRaw={(source) => void onRaw(source)} onDelete={setDeleting} />
      {toast && <div className="toast" role="status">{toast}</div>}
      {importing && (
        <SourceImportDialog onClose={() => setImporting(false)} onImported={onImported} />
      )}
      {raw && (
        <Modal title={`书源 JSON：${raw.source.name}`} onClose={() => setRaw(null)}>
          <pre className="source-json-view">{raw.json}</pre>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除书源"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDeleting(null)}>取消</button>
              <button className="modal-button danger" onClick={() => void onDelete()}>删除</button>
            </>
          }
        >
          <p>删除「{deleting.name}」后，已加入书架的书不会删除，但未缓存章节将无法继续下载。</p>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 设置页增加「网络」分组**

在 `SettingsPanel` 的「摸鱼模式」前插入：

```tsx
<section className="setting-group">
  <h3>网络</h3>
  <label className="setting-row">
    <input
      type="checkbox"
      checked={settings.network.enabled}
      onChange={(event) => onChange({ network: { enabled: event.target.checked } })}
    />
    允许联网
  </label>
  <label className="setting-row">
    <input
      type="checkbox"
      checked={settings.network.autoCheckOnOpen}
      onChange={(event) => onChange({ network: { autoCheckOnOpen: event.target.checked } })}
    />
    打开网络书时自动检查目录（每本每 30 分钟最多一次）
  </label>
  <p className="hint">关闭后不能搜索、更新目录或下载；已缓存章节仍可阅读。</p>
</section>
```

- [ ] **Step 6: 接入 App 的书源视图**

`src/renderer/src/App.tsx` 增加导入：

```tsx
import Sources from './pages/Sources'
```

视图联合类型改为：

```tsx
type View = { name: 'library' } | { name: 'reader'; bookId: string } | { name: 'sources' }
```

渲染分支改为（`<Reader>` 的部分保持原样）：

```tsx
      {view.name === 'reader' ? (
        <Reader
          bookId={view.bookId}
          settings={settings}
          theme={theme}
          onSettingsChange={updateSettings}
          onBack={() => setView({ name: 'library' })}
        />
      ) : view.name === 'sources' ? (
        <Sources onBack={() => setView({ name: 'library' })} />
      ) : (
        <Library
          networkEnabled={settings.network.enabled}
          onOpen={(bookId) => setView({ name: 'reader', bookId })}
          onOpenSources={() => setView({ name: 'sources' })}
        />
      )}
```

- [ ] **Step 7: 样式**

```css
.source-list { display: grid; gap: 10px; padding: 16px; overflow: auto; }
.source-row { display: flex; gap: 16px; justify-content: space-between; padding: 12px 14px; border: 1px solid var(--line); border-radius: 10px; background: var(--panel); }
.source-row.disabled { opacity: 0.6; }
.source-main { min-width: 0; }
.source-title { display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.source-sub { margin-top: 4px; color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.source-actions { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; }
.source-actions label { display: flex; gap: 4px; align-items: center; font-size: 12px; }
.tag { border-radius: 999px; padding: 1px 6px; font-size: 11px; background: var(--line); }
.tag.star { color: #b8860b; }
.tag.black { color: var(--danger); }
.tag.partial { color: #b36b00; }
.score.good { color: #2e7d32; }
.score.mid { color: #b36b00; }
.score.bad { color: var(--danger); }
.source-json, .source-url { width: 100%; min-height: 180px; font-family: monospace; }
.source-url { min-height: 0; }
.source-json-view { max-height: 60vh; overflow: auto; white-space: pre-wrap; }
```

变量名以现有 `styles.css` 为准；没有 `--panel`/`--muted` 就换现有变量。

- [ ] **Step 8: 运行测试并提交**

Run: `npx vitest run tests/source-import-dialog.test.tsx && npx tsc --noEmit`
Expected: PASS。

```bash
git add src/renderer/src/pages/Sources.tsx src/renderer/src/components/SourceImportDialog.tsx src/renderer/src/components/SourceList.tsx src/renderer/src/components/SettingsPanel.tsx src/renderer/src/App.tsx src/renderer/src/styles.css tests/source-import-dialog.test.tsx
git commit -m "feat(network): add source management UI"
```

---

### Task 15: 网络搜索页

**Files:**
- Create: `src/renderer/src/pages/NetworkSearch.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/network-search-ui.test.tsx`

**Interfaces:**
- Consumes: `window.api.searchNetwork/cancelNetworkSearch/addNetworkBook` 与四个搜索事件；`NetworkSearchGroup`。
- Produces: 关键词搜索、优质/全量切换、分组结果、其他来源展开、加入书架、取消、空状态与全量兜底。

- [ ] **Step 1: 写组件测试**

```tsx
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NetworkSearchGroupView } from '../src/renderer/src/pages/NetworkSearch'
import type { NetworkSearchGroup } from '../src/core/booksource/model'

const group: NetworkSearchGroup = {
  key: 'a|b', title: '书名', author: '作者', bestSourceId: 's1',
  items: [
    { sourceId: 's1', sourceName: '源A', title: '书名', author: '作者', bookUrl: 'u1', qualityScore: 80, starred: false, inShelf: false },
    { sourceId: 's2', sourceName: '源B', title: '书名', author: '作者', bookUrl: 'u2', qualityScore: 60, starred: false, inShelf: false }
  ]
}

describe('NetworkSearchGroupView', () => {
  it('shows the best source first and hides other sources until expanded', () => {
    const html = renderToStaticMarkup(
      <NetworkSearchGroupView group={group} expanded={false} onToggle={() => {}} onAdd={() => {}} adding={null} />
    )
    expect(html).toContain('源A')
    expect(html).not.toContain('源B')
    expect(html).toContain('其他来源 1')
  })
})
```

- [ ] **Step 2: 实现 `NetworkSearch.tsx`**

```tsx
import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { NetworkSearchGroup, NetworkSearchItem } from '../../../core/booksource/model'
import type { NetworkSearchPayload } from '../../../shared/api'
import { errorText } from '../errors'

export function NetworkSearchGroupView({
  group,
  expanded,
  onToggle,
  onAdd,
  adding
}: {
  group: NetworkSearchGroup
  expanded: boolean
  onToggle: () => void
  onAdd: (item: NetworkSearchItem) => void
  adding: string | null
}) {
  const best = group.items.find((item) => item.sourceId === group.bestSourceId) ?? group.items[0]
  const others = group.items.filter((item) => item !== best)
  const renderItem = (item: NetworkSearchItem): ReactElement => (
    <div key={item.sourceId} className="network-result">
      <div className="network-result-main">
        <div className="network-result-title">
          {item.title}
          {item.author && <span className="network-result-author">{item.author}</span>}
          {item.starred && <span className="tag star">标星</span>}
          {item.inShelf && <span className="tag">已在书架</span>}
        </div>
        <div className="network-result-sub">
          来源：{item.sourceName} · 评分 {item.qualityScore.toFixed(1)}
          {item.lastChapter ? ` · 最新：${item.lastChapter}` : ''}
        </div>
        {item.intro && <p className="network-result-intro">{item.intro}</p>}
      </div>
      <button
        className="network-add"
        disabled={adding === `${item.sourceId}:${item.bookUrl}`}
        onClick={() => onAdd(item)}
      >
        {adding === `${item.sourceId}:${item.bookUrl}` ? '加入中…' : '加入书架'}
      </button>
    </div>
  )
  return (
    <article className="network-group">
      {renderItem(best)}
      {others.length > 0 && (
        <>
          <button className="network-others" onClick={onToggle}>
            {expanded ? '收起其他来源' : `其他来源 ${others.length}`}
          </button>
          {expanded && others.map(renderItem)}
        </>
      )}
    </article>
  )
}

export default function NetworkSearch({
  networkEnabled,
  onBack,
  onAdded
}: {
  networkEnabled: boolean
  onBack: () => void
  onAdded: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [scope, setScope] = useState<'quality' | 'all'>('quality')
  const [payload, setPayload] = useState<NetworkSearchPayload | null>(null)
  const [sourceEvents, setSourceEvents] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState('')
  const requestRef = useRef('')
  const scopeRef = useRef<'quality' | 'all'>('quality')

  useEffect(() => {
    const offSource = window.api.onNetworkSearchSource((event) => {
      if (event.requestId !== requestRef.current) return
      setSourceEvents((current) => ({
        ...current,
        [event.sourceId]:
          event.status === 'error'
            ? `${event.sourceName}：失败（${event.message ?? '未知错误'}）`
            : `${event.sourceName}：${event.count} 条`
      }))
    })
    const offResults = window.api.onNetworkSearchResults((next) => {
      if (next.requestId === requestRef.current) setPayload(next)
    })
    const offDone = window.api.onNetworkSearchDone((done) => {
      if (done.requestId !== requestRef.current) return
      setSearching(false)
      setPayload((current) =>
        current
          ? { ...current, groups: done.groups }
          : {
              requestId: done.requestId,
              groups: done.groups,
              searched: done.searched,
              succeeded: done.succeeded,
              empty: done.empty,
              failed: done.failed,
              remaining: 0,
              scope: scopeRef.current
            }
      )
      if (done.cancelled) setMessage('已取消搜索')
      else if (done.groups.length === 0) setMessage('没有找到这本书，可以换全量书源再试')
    })
    const offError = window.api.onNetworkSearchError((event) => {
      if (event.requestId !== requestRef.current) return
      setSearching(false)
      setMessage(`搜索失败：${event.message}`)
    })
    return () => { offSource(); offResults(); offDone(); offError() }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const run = async (nextScope: 'quality' | 'all'): Promise<void> => {
    const text = keyword.trim()
    if (!text || searching) return
    if (!networkEnabled) {
      setMessage('已关闭「允许联网」，请先在设置 → 网络里打开')
      return
    }
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    scopeRef.current = nextScope
    setScope(nextScope)
    setSearching(true)
    setPayload(null)
    setSourceEvents({})
    setExpanded(new Set())
    setMessage('')
    try {
      const done = await window.api.searchNetwork({ requestId, keyword: text, scope: nextScope })
      if (requestId === requestRef.current) setPayload((current) => current ? { ...current, groups: done.groups } : current)
    } catch (reason) {
      if (requestId === requestRef.current) setMessage(`搜索失败：${errorText(reason)}`)
    } finally {
      if (requestId === requestRef.current) setSearching(false)
    }
  }

  const add = async (item: NetworkSearchItem): Promise<void> => {
    const key = `${item.sourceId}:${item.bookUrl}`
    setAdding(key)
    try {
      await window.api.addNetworkBook({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        title: item.title,
        author: item.author
      })
      setToast(`已加入书架：${item.title}`)
      onAdded()
    } catch (reason) {
      setToast(`加入失败：${errorText(reason)}`)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="ghost" onClick={onBack}>← 书架</button>
        <h1>网络搜索</h1>
        <div className="toolbar-actions">
          <select value={scope} onChange={(event) => setScope(event.target.value as 'quality' | 'all')} aria-label="搜索范围">
            <option value="quality">优质书源</option>
            <option value="all">全量书源</option>
          </select>
        </div>
      </header>
      <form className="network-search-bar" onSubmit={(event) => { event.preventDefault(); void run(scope) }}>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入书名或作者"
          autoFocus
        />
        <button type="submit" disabled={searching || !keyword.trim()}>{searching ? '搜索中…' : '搜索'}</button>
        {searching && <button type="button" className="ghost" onClick={() => void window.api.cancelNetworkSearch(requestRef.current)}>取消</button>}
        {!searching && payload && <button type="button" className="ghost" onClick={() => void run('all')}>用全量书源再搜一次</button>}
      </form>
      {!networkEnabled && <p className="hint">已关闭「允许联网」，搜索和下载不可用；已缓存章节仍可阅读。</p>}
      {message && <p className="hint">{message}</p>}
      {searching && (
        <p className="hint">
          已搜索 {payload?.searched ?? 0} 个来源，成功 {payload?.succeeded ?? 0} 个，空 {payload?.empty ?? 0} 个，失败 {payload?.failed ?? 0} 个
        </p>
      )}
      {Object.values(sourceEvents).length > 0 && (
        <details className="network-progress">
          <summary>搜索明细</summary>
          <ul>{Object.entries(sourceEvents).map(([id, text]) => <li key={id}>{text}</li>)}</ul>
        </details>
      )}
      <div className="network-results">
        {payload?.groups.map((group) => (
          <NetworkSearchGroupView
            key={group.key}
            group={group}
            expanded={expanded.has(group.key)}
            onToggle={() => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(group.key)) next.delete(group.key)
              else next.add(group.key)
              return next
            })}
            onAdd={(item) => void add(item)}
            adding={adding}
          />
        ))}
      </div>
      {!searching && payload && payload.groups.length === 0 && !message && (
        <p className="empty">没有结果。</p>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
```

- [ ] **Step 3: 接入 App 的网络搜索视图**

`src/renderer/src/App.tsx`：

```tsx
import NetworkSearch from './pages/NetworkSearch'
```

```tsx
type View =
  | { name: 'library' }
  | { name: 'reader'; bookId: string }
  | { name: 'sources' }
  | { name: 'network-search' }
```

在 `sources` 分支后增加：

```tsx
      ) : view.name === 'network-search' ? (
        <NetworkSearch
          networkEnabled={settings.network.enabled}
          onBack={() => setView({ name: 'library' })}
          onAdded={() => setView({ name: 'library' })}
        />
      ) : (
```

`Library` 调用补上：

```tsx
          onOpenNetworkSearch={() => setView({ name: 'network-search' })}
```

- [ ] **Step 4: 样式**

```css
.network-search-bar { display: flex; gap: 8px; padding: 12px 16px; }
.network-search-bar input { flex: 1; min-width: 0; }
.network-results { display: grid; gap: 10px; padding: 0 16px 24px; overflow: auto; }
.network-group { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); padding: 10px; }
.network-result { display: flex; gap: 12px; justify-content: space-between; padding: 8px 4px; border-top: 1px solid var(--line); }
.network-result:first-child { border-top: none; }
.network-result-main { min-width: 0; }
.network-result-title { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; font-weight: 600; }
.network-result-author { color: var(--muted); font-weight: 400; }
.network-result-sub { margin-top: 3px; color: var(--muted); font-size: 12px; }
.network-result-intro { margin: 6px 0 0; color: var(--muted); font-size: 13px; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
.network-others { margin-top: 8px; font-size: 12px; }
.network-add { align-self: flex-start; white-space: nowrap; }
.network-progress { padding: 0 16px; }
```

- [ ] **Step 5: 运行测试并提交**

Run: `npx vitest run tests/network-search-ui.test.tsx && npx tsc --noEmit`
Expected: PASS。

```bash
git add src/renderer/src/pages/NetworkSearch.tsx src/renderer/src/App.tsx src/renderer/src/styles.css tests/network-search-ui.test.tsx
git commit -m "feat(network): add grouped network search UI"
```

---

### Task 16: 阅读器懒加载、占位、重试与自动更新

**Files:**
- Create: `src/renderer/src/reader/useChapterTexts.ts`
- Modify: `src/renderer/src/reader/position.ts`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/components/SearchPanel.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/use-chapter-texts.test.ts`

**Interfaces:**
- Consumes: `OpenBookPayload.contentMode/cachedChapters`、`window.api.readNetworkChapter`、`window.api.updateToc`。
- Produces: 当前窗口章节按需加载、加载/失败占位与重试、恢复进度等待目标章、打开网络书自动检查目录、搜索面板缓存提示、网络书按章节估算进度。

- [ ] **Step 1: 写测试**

```ts
import { describe, expect, it } from 'vitest'
import { needsLoad, mergeChapterText } from '../src/renderer/src/reader/useChapterTexts'
import { chapterForPercent, percentForChapter } from '../src/renderer/src/reader/position'

describe('useChapterTexts helpers', () => {
  it('loads only enabled, absent and not-requested indexes', () => {
    expect(needsLoad(2, true, new Set([1]), new Set())).toBe(true)
    expect(needsLoad(1, true, new Set([1]), new Set())).toBe(false)
    expect(needsLoad(3, false, new Set(), new Set())).toBe(false)
    expect(needsLoad(4, true, new Set(), new Set([4]))).toBe(false)
  })

  it('merges a resolved text without dropping other chapters', () => {
    expect(mergeChapterText({ 1: 'a' }, 2, 'b')).toEqual({ 1: 'a', 2: 'b' })
  })
})

describe('network progress helpers', () => {
  it('maps a chapter index to a percent and back', () => {
    expect(percentForChapter(100, 0)).toBe(0)
    expect(percentForChapter(100, 50)).toBe(50)
    expect(percentForChapter(100, 99)).toBe(99)
    expect(percentForChapter(0, 5)).toBe(0)
    expect(chapterForPercent(100, 50)).toBe(50)
    expect(chapterForPercent(100, 100)).toBe(99)
    expect(chapterForPercent(0, 100)).toBe(0)
  })
})
```

Run: `npx vitest run tests/use-chapter-texts.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 2: 增加进度换算 helper**

在 `src/renderer/src/reader/position.ts` 末尾追加：

```ts
/**
 * Network books do not know real chapter sizes until they are downloaded.
 * Their progress is measured in chapters: the bar and the seek slider move
 * one step per chapter instead of pretending a character count.
 */
export function percentForChapter(chapterCount: number, chapterIndex: number): number {
  if (chapterCount <= 0) return 0
  const index = Math.min(Math.max(chapterIndex, 0), chapterCount - 1)
  return Math.round((index / chapterCount) * 1000) / 10
}

export function chapterForPercent(chapterCount: number, percent: number): number {
  if (chapterCount <= 0) return 0
  const clamped = Math.min(100, Math.max(0, percent))
  return Math.min(chapterCount - 1, Math.floor((clamped / 100) * chapterCount))
}
```

- [ ] **Step 3: 实现 hook**

新建 `src/renderer/src/reader/useChapterTexts.ts`：

```ts
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpenBookPayload } from '../../../shared/api'

export function needsLoad(
  index: number,
  enabled: boolean,
  texts: Set<number>,
  requested: Set<number>
): boolean {
  return enabled && !texts.has(index) && !requested.has(index)
}

export function mergeChapterText(
  current: Record<number, string>,
  index: number,
  text: string
): Record<number, string> {
  return { ...current, [index]: text }
}

export interface ChapterLoadState {
  loading: boolean
  error?: string
}

function loadedIndexes(texts: Record<number, string>): Set<number> {
  return new Set(Object.keys(texts).map(Number))
}

/**
 * Fetches the visible chapters of a network book on demand. Resolved text is
 * kept in a ref as well as in state so a chapter is never requested twice,
 * even when the effect that asks for it runs again before React re-renders.
 */
export function useChapterTexts(
  book: OpenBookPayload | null,
  indexes: number[]
): {
  texts: Record<number, string>
  states: Record<number, ChapterLoadState>
  retry: (index: number) => void
} {
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [states, setStates] = useState<Record<number, ChapterLoadState>>({})
  const textsRef = useRef<Record<number, string>>({})
  const requested = useRef(new Set<number>())
  const aliveRef = useRef(true)
  const bookId = book?.meta.id ?? ''

  useEffect(() => {
    aliveRef.current = true
    textsRef.current = {}
    setTexts({})
    setStates({})
    requested.current = new Set()
    return () => {
      aliveRef.current = false
    }
  }, [bookId])

  const load = useCallback(
    (index: number): void => {
      if (!book || book.contentMode !== 'lazy') return
      if (!needsLoad(index, true, loadedIndexes(textsRef.current), requested.current)) return
      requested.current.add(index)
      setStates((current) => ({ ...current, [index]: { loading: true } }))
      void window.api
        .readNetworkChapter(book.meta.id, index)
        .then((payload) => {
          if (!aliveRef.current) return
          textsRef.current = mergeChapterText(textsRef.current, index, payload.text)
          setTexts(textsRef.current)
          setStates((current) => ({ ...current, [index]: { loading: false } }))
        })
        .catch((reason: unknown) => {
          if (!aliveRef.current) return
          setStates((current) => ({
            ...current,
            [index]: {
              loading: false,
              error: reason instanceof Error ? reason.message : String(reason)
            }
          }))
        })
        .finally(() => {
          requested.current.delete(index)
        })
    },
    [book]
  )

  const key = useMemo(() => indexes.join(','), [indexes])

  useEffect(() => {
    if (!book || book.contentMode !== 'lazy') return
    const loaded = loadedIndexes(textsRef.current)
    for (const index of key ? key.split(',').map(Number) : []) {
      if (!Number.isInteger(index) || index < 0) continue
      if (needsLoad(index, true, loaded, requested.current)) load(index)
    }
  }, [book, key, load])

  const retry = useCallback(
    (index: number): void => {
      requested.current.delete(index)
      load(index)
    },
    [load]
  )

  return { texts, states, retry }
}
```

失败后 `requested` 已清空、`textsRef` 里也没有该章，所以 `retry` 能重新请求；effect 只在窗口或书变化时触发，重试必须直接调 `load`。

- [ ] **Step 4: 阅读器接入 hook 与章节占位**

`Reader.tsx` 顶部导入：

```tsx
import { useChapterTexts } from '../reader/useChapterTexts'
```

position 导入增加两个 helper：

```tsx
import {
  chapterForPercent,
  charsBefore,
  nearestIndexByTop,
  percentAt,
  percentForChapter,
  positionForPercent,
  resolveChapterIndex,
  totalChars
} from '../reader/position'
```

`ChapterView` 增加：

```ts
  loading?: boolean
  error?: string
```

`ReaderBody` 增加 `onRetryChapter`，章节体在 `paragraphs.map(...)` 之后补占位分支：

```tsx
const ReaderBody = memo(function ReaderBody({
  chapters,
  resizing,
  onRetryChapter
}: {
  chapters: ChapterView[]
  resizing: boolean
  onRetryChapter: (index: number) => void
}) {
  const articleRef = useRef<HTMLElement | null>(null)

  // Reflowing every paragraph of a long book on each pointer move while the
  // window is dragged made the app freeze. Pin the text width for the drag,
  // then release it once so the book reflows exactly once.
  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (resizing) {
      article.style.width = `${article.clientWidth}px`
    } else {
      article.style.removeProperty('width')
    }
    return () => {
      article.style.removeProperty('width')
    }
  }, [resizing])

  return (
    <article className="reader-page" ref={articleRef}>
      {chapters.map((chapter) => (
        <section
          key={chapter.meta.index}
          className={`reader-chapter ${chapter.meta.level}`}
          data-chapter-section={chapter.meta.index}
        >
          <h2 className="chapter-title">{chapter.meta.title}</h2>
          {chapter.paragraphs.length > 0 ? (
            chapter.paragraphs.map((text, paragraphIndex) => (
              <p
                key={paragraphIndex}
                className="reader-paragraph"
                data-chapter-index={chapter.meta.index}
                data-paragraph-index={paragraphIndex}
              >
                {text}
              </p>
            ))
          ) : chapter.loading ? (
            <p className="chapter-placeholder">正在加载本章…</p>
          ) : chapter.error ? (
            <p className="chapter-placeholder error">
              本章加载失败：{chapter.error}
              <button className="ghost" onClick={() => onRetryChapter(chapter.meta.index)}>
                重试
              </button>
            </p>
          ) : (
            <p className="chapter-placeholder">本章暂无内容</p>
          )}
        </section>
      ))}
    </article>
  )
})
```

两处 `<ReaderBody ... />`（代码伪装的 `main` 与普通 `main`）都加 `onRetryChapter={retry}`。

用新代码替换原来的 `chapters` / `paragraphs` / `windowRange` / `windowStartRef` / `pendingAnchorRef` 定义（当前文件第 686–707 行）：

```tsx
  const chapterCount = book?.meta.chapters.length ?? 0
  // Only a small window of chapters lives in the DOM: the previous, current
  // and next one. A whole book in flow means every resize or font change
  // reflows tens of thousands of paragraphs, which freezes long books.
  const windowRange = useMemo(
    () => chapterWindow(chapterCount, current.chapterIndex),
    [chapterCount, current.chapterIndex]
  )
  const windowStartRef = useRef(windowRange.start)
  useLayoutEffect(() => {
    windowStartRef.current = windowRange.start
  }, [windowRange.start])
  const pendingAnchorRef = useRef<{ index: number; top: number } | null>(null)

  // Network books keep only metadata in memory: the chapter around the
  // reading position is fetched on demand and cached by the main process.
  const restoreChapterIndex = useMemo(() => {
    if (!book || book.contentMode !== 'lazy' || !book.progress) return -1
    return resolveChapterIndex(book.meta, book.progress.chapterKey, book.progress.chapterIndex)
  }, [book])
  const desiredIndexes = useMemo(() => {
    if (!book || book.contentMode !== 'lazy') return []
    const indexes = paged
      ? [current.chapterIndex]
      : Array.from(
          { length: windowRange.end - windowRange.start },
          (_, offset) => windowRange.start + offset
        )
    if (restoreChapterIndex >= 0 && !indexes.includes(restoreChapterIndex)) {
      indexes.push(restoreChapterIndex)
    }
    return indexes
  }, [book, paged, current.chapterIndex, windowRange.start, windowRange.end, restoreChapterIndex])
  const { texts, states, retry } = useChapterTexts(book, desiredIndexes)

  const chapters = useMemo<ChapterView[]>(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => {
      const raw =
        book.contentMode === 'lazy' ? (texts[index] ?? '') : (book.chapters[index] ?? '')
      const state = states[index]
      return {
        meta,
        paragraphs: splitParagraphs(raw),
        ...(state?.loading ? { loading: true } : {}),
        ...(state?.error ? { error: state.error } : {})
      }
    })
  }, [book, texts, states])

  const paragraphs = useMemo(() => chapters.map((chapter) => chapter.paragraphs), [chapters])
```

原来的 `windowRange` 定义删除（否则重复）；`windowStartRef` / `pendingAnchorRef` 的用法保持不变。

- [ ] **Step 5: 网络书进度按章节估算**

网络章节的 `charCount` 是 0，`percentAt` 会永远返回 0。在 `scheduleSave` 之后、`scrollToPosition` 之前加：

```tsx
  /** Local books have real character counts; network books count chapters. */
  const percentFor = useCallback(
    (chapterIndex: number, paragraphIndex: number): number => {
      if (!book) return 0
      if (book.contentMode === 'lazy') {
        return percentForChapter(book.meta.chapters.length, chapterIndex)
      }
      return percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
    },
    [book, paragraphs]
  )
```

把 6 处 `percentAt(book.meta, X, Y, paragraphs)` 换成 `percentFor(X, Y)`，并把 `percentFor` 加进对应 useCallback 的依赖：

1. `syncPagedFromView`：`percentAt(book.meta, position.chapterIndex, position.paragraphIndex, paragraphs)` → `percentFor(position.chapterIndex, position.paragraphIndex)`；依赖改为 `[book, currentPosition, percentFor, scheduleSave]`。
2. `turnPage` 向前跨章：`percentAt(book.meta, chapterIndex, 0, paragraphs)` → `percentFor(chapterIndex, 0)`；依赖加入 `percentFor`。
3. `turnPage` 向后跨章：`percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)` → `percentFor(chapterIndex, paragraphIndex)`。
4. `goToPosition`：同上；依赖加入 `percentFor`。
5. `handleScroll`：同上；依赖改为 `[book, currentPosition, percentFor, scheduleSave]`。
6. 恢复进度 effect：见 Step 6。

`seek` 改为：

```tsx
  const seek = (percent: number): void => {
    if (!book) return
    if (book.contentMode === 'lazy') {
      goToPosition(chapterForPercent(book.meta.chapters.length, percent), 0)
      return
    }
    const { chapterIndex, paragraphIndex } = positionForPercent(book.meta, percent, paragraphs)
    goToPosition(chapterIndex, paragraphIndex)
  }
```

底部剩余时间改为（原来的 `const total` / `const read` 删除）：

```tsx
  // 网络书没有真实字数：按每章约 3000 字估算剩余时间。
  const remainingMinutes =
    book.contentMode === 'lazy'
      ? Math.max(0, Math.ceil(((book.meta.chapters.length - current.chapterIndex) * 3000) / 400))
      : Math.max(
          0,
          Math.ceil(
            (totalChars(book.meta) -
              charsBefore(book.meta, current.chapterIndex, current.paragraphIndex, paragraphs)) /
              400
          )
        )
```

- [ ] **Step 6: 恢复进度等待章节加载 + 自动检查目录**

把恢复进度的 effect 改为下面的形式（网络书要等目标章文本就绪再定位，否则会滚到空章节、文本到达后落错位置）：

```tsx
  const restoreReady =
    !book ||
    book.contentMode !== 'lazy' ||
    restoreChapterIndex < 0 ||
    texts[restoreChapterIndex] !== undefined ||
    Boolean(states[restoreChapterIndex]?.error)

  useEffect(() => {
    if (!book || chapters.length === 0 || restoredRef.current || !restoreReady) return
    restoredRef.current = true
    const saved = book.progress
    const chapterIndex = saved
      ? resolveChapterIndex(book.meta, saved.chapterKey, saved.chapterIndex)
      : 0
    const paragraphIndex = saved?.paragraphIndex ?? 0
    const percent = percentFor(chapterIndex, paragraphIndex)
    const next = { chapterIndex, paragraphIndex, percent }
    anchorRef.current = { chapterIndex, paragraphIndex }
    setCurrent(next)
    scheduleSave(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (pagedRef.current) goToPosition(chapterIndex, paragraphIndex)
        else scrollToPosition(chapterIndex, paragraphIndex)
      })
    })
  }, [
    book,
    chapters.length,
    percentFor,
    restoreReady,
    scheduleSave,
    scrollToPosition,
    goToPosition
  ])
```

在 `openBook` effect 之后加自动检查（同一本书每次打开只检查一次，30 分钟内检查过就跳过）：

```tsx
  const checkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!book || book.meta.format !== 'network' || !settings.network.autoCheckOnOpen) return
    if (checkedRef.current === book.meta.id) return
    const last = book.meta.network?.lastCheckAt
    if (last && Date.now() - new Date(last).getTime() < 30 * 60 * 1000) return
    checkedRef.current = book.meta.id
    void window.api
      .updateToc(bookId)
      .then(async (result) => {
        if (result.added === 0) return
        setNotice(`目录已更新，新增 ${result.added} 章`)
        const payload = await window.api.openBook(bookId)
        setBook(payload)
        setBookmarks(payload.bookmarks)
      })
      .catch(() => undefined)
  }, [book, bookId, settings.network.autoCheckOnOpen])
```

- [ ] **Step 7: 搜索面板缓存提示**

`SearchPanelProps` 增加 `cachedOnly?: boolean`，函数签名解构增加 `cachedOnly = false`。

`run` 里的消息分支改为：

```ts
      if (result.cancelled) setMessage('已取消搜索')
      else if (result.hits.length === 0) {
        setMessage(result.cachedOnly ? '已缓存章节里没有找到匹配内容' : '没有找到匹配内容')
      } else if (result.truncated) setMessage('结果超过 300 条，已截断')
      else if (result.cachedOnly) {
        setMessage(`仅搜索已缓存章节，还有 ${result.skippedUncached} 章未缓存`)
      }
```

`Reader` 里 `<SearchPanel ... />` 加：

```tsx
              cachedOnly={book.contentMode === 'lazy'}
```

- [ ] **Step 8: 样式**

```css
.chapter-placeholder {
  margin: 18px 0;
  color: var(--muted);
  font-style: italic;
}
.chapter-placeholder.error { color: var(--danger); font-style: normal; }
.chapter-placeholder .ghost { margin-left: 8px; }
```

- [ ] **Step 9: 运行测试与类型检查**

Run: `npx vitest run tests/use-chapter-texts.test.ts && npx tsc --noEmit`
Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/renderer/src/reader/useChapterTexts.ts src/renderer/src/reader/position.ts src/renderer/src/pages/Reader.tsx src/renderer/src/components/SearchPanel.tsx src/renderer/src/styles.css tests/use-chapter-texts.test.ts
git commit -m "feat(network): lazy-load chapters in the reader"
```

---

### Task 17: 端到端验收、回归清单与文档

**Files:**
- Create: `scripts/acceptance-network.cjs`
- Modify: `docs/regression-checklist.md`
- Create: `docs/superpowers/acceptance/2026-11-07-network-book-source.md`
- Test: `tests/network-e2e.test.ts`

**Interfaces:**
- Consumes: 全部实现。
- Produces: 离屏验收脚本、回归清单、验收记录。

- [ ] **Step 1: 写主进程端到端测试**

`tests/network-e2e.test.ts` 用真实服务 + 127.0.0.1 假书源跑完整生命周期：导入 → 搜索 → 加入 → 读章 → 删除源读缓存 → 重新导入重关联 → 更新目录 → 下载全本 → 转本地 → 重洗。

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import type { FakeServer } from './helpers/networkServer'
import { HttpClient } from '../src/main/services/network/httpClient'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { SourceReader } from '../src/main/services/network/sourceReader'
import { NetworkSearchService } from '../src/main/services/network/searchService'
import { NetworkBookService } from '../src/main/services/network/bookService'
import { NetworkBookRepository } from '../src/main/storage/networkBook'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import { ReaderService } from '../src/main/services/reader'
import { SearchService } from '../src/main/services/search'
import { ReprocessService } from '../src/main/services/reprocess'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'

let root = ''
let close: (() => Promise<void>) | null = null

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-net-e2e-'))
})

afterEach(async () => {
  if (close) await close()
  close = null
  await rm(root, { recursive: true, force: true })
})

function sourceJson(url: string): Record<string, unknown> {
  return {
    bookSourceName: '假书源',
    bookSourceUrl: url,
    bookSourceGroup: '验收',
    searchUrl: '/s?q={{key}}',
    ruleSearch: {
      bookList: '.book',
      name: '.name',
      author: '.author',
      bookUrl: '.name@href',
      intro: '.intro'
    },
    ruleBookInfo: { name: 'h1', author: '.author', intro: '.intro', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
    ruleContent: { content: '#content@html' }
  }
}

async function setupFull() {
  const server: FakeServer = await startFakeServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const url = req.url ?? ''
    if (url.startsWith('/s?')) {
      res.end(
        '<div class="book"><a class="name" href="/info">测试书</a><span class="author">作者</span><p class="intro">简介</p></div>'
      )
    } else if (url.startsWith('/info')) {
      res.end('<h1>测试书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  close = server.close
  const library = new LibraryRepository(root)
  const books = new BookRepository(root)
  const networkBooks = new NetworkBookRepository(root)
  const http = new HttpClient()
  const store = new SourceStore(root)
  const sources = new SourceService(store, http, library)
  const reader = new SourceReader(http)
  const service = new NetworkBookService({
    root,
    sources,
    reader,
    networkBooks,
    books,
    library,
    cleaning: () => ({ adCleaning: true, rules: [] })
  })
  const search = new NetworkSearchService(sources, store, reader, library)
  const readerService = new ReaderService(library, books, networkBooks)
  const bookSearch = new SearchService(books, networkBooks)
  const reprocess = new ReprocessService(library, books)
  return { server, sources, search, service, readerService, bookSearch, reprocess, books }
}

describe('network book lifecycle', () => {
  it('runs import -> search -> add -> read -> relink -> download -> convert -> reclean', async () => {
    const { server, sources, search, service, readerService, bookSearch, reprocess, books } =
      await setupFull()

    const imported = await sources.importJson(JSON.stringify(sourceJson(server.url)))
    expect(imported.added).toBe(1)

    const found = await search.search(
      { requestId: 'e2e', keyword: '测试书', scope: 'quality' },
      { source: () => {}, results: () => {} }
    )
    const item = found.groups[0].items[0]
    expect(item.title).toBe('测试书')

    const entry = await service.add({ sourceId: item.sourceId, bookUrl: item.bookUrl })
    expect(entry.format).toBe('network')

    const opened = await readerService.open(entry.id)
    expect(opened.contentMode).toBe('lazy')
    expect(opened.chapters).toEqual([])

    expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
    const cachedSearch = await bookSearch.search(entry.id, '正文一', 'e2e-search', () => {})
    expect(cachedSearch.cachedOnly).toBe(true)
    expect(cachedSearch.skippedUncached).toBe(1)
    expect(cachedSearch.hits.length).toBeGreaterThan(0)

    await sources.remove(item.sourceId)
    expect((await service.readChapter(entry.id, 0)).text).toContain('正文一')
    await expect(service.readChapter(entry.id, 1)).rejects.toThrow('书源已删除')

    await sources.importJson(JSON.stringify(sourceJson(server.url)))
    await service.relinkSources()
    expect((await service.updateToc(entry.id)).total).toBe(2)

    const download = await service.downloadAll(entry.id, () => {})
    expect(download.failedChapters).toEqual([])
    expect(download.done).toBe(download.total)

    const converted = await service.convertToLocal(entry.id)
    expect(converted.chapterCount).toBe(2)
    const meta = await books.readMeta(entry.id)
    expect(meta.format).toBe('txt')
    expect(meta.chapters.every((chapter) => chapter.simhash && chapter.charCount > 0)).toBe(true)

    const after = await readerService.open(entry.id)
    expect(after.contentMode).toBe('eager')
    expect(after.chapters.join('\n')).toContain('正文一')

    const recleaned = await reprocess.reclean(entry.id)
    expect(recleaned.chapterCount).toBe(2)
  })
})
```

Run: `npx vitest run tests/network-e2e.test.ts`
Expected: PASS（若失败，修实现，不改断言口径）。

- [ ] **Step 2: 写离屏验收脚本 `scripts/acceptance-network.cjs`**

脚本自动启动假书源、用临时数据目录启动真实应用、通过 CDP 调 IPC 和检查 DOM，最后关闭应用。不改真实 `data/`，不弹窗。

```js
// 网络书源离屏验收：真实应用 + 127.0.0.1 假书源。
// READER_ACCEPTANCE=1 让窗口离屏；PORTABLE_EXECUTABLE_DIR 指向临时目录。
// Usage: node scripts/acceptance-network.cjs

const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const { createWriteStream } = require('node:fs')
const { mkdtemp, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const CDP_LIST = 'http://127.0.0.1:9222/json/list'

function sourceDefinition(url) {
  return {
    bookSourceName: '假书源',
    bookSourceUrl: url,
    bookSourceGroup: '验收',
    searchUrl: '/s?q={{key}}',
    ruleSearch: {
      bookList: '.book',
      name: '.name',
      author: '.author',
      bookUrl: '.name@href',
      intro: '.intro'
    },
    ruleBookInfo: { name: 'h1', author: '.author', intro: '.intro', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
    ruleContent: { content: '#content@html' }
  }
}

function startFakeSource() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const url = req.url ?? ''
    if (url.startsWith('/s?')) {
      res.end(
        '<div class="book"><a class="name" href="/info">测试书</a><span class="author">作者</span><p class="intro">简介</p></div>'
      )
    } else if (url.startsWith('/info')) {
      res.end('<h1>测试书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((done) => server.close(done))
      })
    })
  })
}

async function currentTarget() {
  const response = await fetch(CDP_LIST, { signal: AbortSignal.timeout(1000) })
  if (!response.ok) return null
  const list = await response.json()
  return list.find((target) => target.type === 'page') ?? null
}

async function waitForApp(timeoutMs = 120000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const target = await currentTarget()
      if (target) return target
    } catch {
      // 还没起来。
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  throw new Error('开发窗口在 120 秒内没有打开 9222 调试端口')
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })
  let nextId = 0
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 30000)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    const exception = response.result?.exceptionDetails
    if (exception) {
      throw new Error(exception.exception?.description ?? exception.text ?? '页面执行失败')
    }
    return response.result?.result?.value
  }
  return { evaluate, close: () => ws.close() }
}

async function waitFor(page, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await page.evaluate(expression)
      if (value) return value
    } catch {
      // 重载期间上下文暂时不可用。
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${label}（等待超时）`)
}

async function reload(page) {
  try {
    await page.evaluate('location.reload()')
  } catch {
    // 导航会打断这次执行，忽略。
  }
  await waitFor(
    page,
    "document.readyState === 'complete' && !!document.querySelector('.toolbar')",
    '页面重载后没有回到书架'
  )
}

async function stopApp(child) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      await fetch(CDP_LIST, { signal: AbortSignal.timeout(500) })
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程已经不在了。
  }
}

async function main() {
  if (await currentTarget().catch(() => null)) {
    throw new Error('9222 已有实例在运行，先关闭开发实例再跑验收')
  }
  const tempDir = await mkdtemp(join(tmpdir(), 'reader-acceptance-network-'))
  const logPath = join(tempDir, 'dev.log')
  const log = createWriteStream(logPath)
  const fake = await startFakeSource()
  let child = null
  let page = null
  try {
    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.READER_ACCEPTANCE = '1'
    env.PORTABLE_EXECUTABLE_DIR = tempDir
    env.READER_ALLOW_LOCAL_SOURCES = '1'
    child = spawn('npm', ['run', 'dev'], {
      cwd: ROOT,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    page = await connect(await waitForApp())
    await waitFor(page, "!!document.querySelector('.toolbar')", '书架没有加载')

    const imported = await page.evaluate(
      `window.api.importSources({ kind: 'json', json: ${JSON.stringify(
        JSON.stringify(sourceDefinition(fake.url))
      )} })`
    )
    if (imported.added !== 1) throw new Error(`导入书源失败：${JSON.stringify(imported)}`)
    console.log('PASS 导入书源')

    const found = await page.evaluate(
      "window.api.searchNetwork({ requestId: 'acc', keyword: '测试书', scope: 'quality' })"
    )
    const item = found?.groups?.[0]?.items?.[0]
    if (!item) throw new Error(`搜索没有结果：${JSON.stringify(found)}`)
    console.log('PASS 优质书源搜索')

    const entry = await page.evaluate(
      `window.api.addNetworkBook(${JSON.stringify({ sourceId: item.sourceId, bookUrl: item.bookUrl })})`
    )
    if (!entry?.id) throw new Error('加入书架没有返回书籍')
    console.log('PASS 加入书架')

    const chapter = await page.evaluate(
      `window.api.readNetworkChapter(${JSON.stringify(entry.id)}, 0)`
    )
    if (!chapter.text.includes('正文一')) throw new Error('按需读取第一章失败')
    console.log('PASS 按需读取章节')

    await reload(page)
    const cardText = await waitFor(
      page,
      "[...document.querySelectorAll('.card')].map((node) => node.textContent).join('|')",
      '书架没有卡片'
    )
    if (!cardText.includes('网络 · 假书源')) throw new Error(`书架没有网络徽标：${cardText}`)
    console.log('PASS 书架网络徽标')

    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '书源').click()"
    )
    const sourceText = await waitFor(
      page,
      "document.querySelector('.source-row')?.textContent ?? ''",
      '书源页没有列出书源'
    )
    if (!sourceText.includes('假书源')) throw new Error('书源页没有导入的书源')
    console.log('PASS 书源页')

    await page.evaluate("document.querySelector('.toolbar button').click()")
    await waitFor(page, "!!document.querySelector('.card')", '返回书架失败')
    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '网络搜索').click()"
    )
    await waitFor(page, "!!document.querySelector('.network-search-bar')", '网络搜索页没有打开')
    console.log('PASS 网络搜索页')

    const updated = await page.evaluate(`window.api.updateToc(${JSON.stringify(entry.id)})`)
    if (updated.total !== 2) throw new Error(`更新目录失败：${JSON.stringify(updated)}`)
    const downloaded = await page.evaluate(`window.api.downloadAll(${JSON.stringify(entry.id)})`)
    if (downloaded.failedChapters.length > 0) {
      throw new Error(`下载有失败章节：${JSON.stringify(downloaded.failedChapters)}`)
    }
    const converted = await page.evaluate(`window.api.convertToLocal(${JSON.stringify(entry.id)})`)
    if (converted.chapterCount !== 2) throw new Error(`转本地失败：${JSON.stringify(converted)}`)
    const opened = await page.evaluate(`window.api.openBook(${JSON.stringify(entry.id)})`)
    if (opened.contentMode !== 'eager') throw new Error('转本地后仍按懒加载打开')
    console.log('PASS 更新目录 / 下载全本 / 转本地')

    await reload(page)
    const convertedCards = await waitFor(
      page,
      "[...document.querySelectorAll('.card')].map((node) => node.textContent).join('|')",
      '转本地后书架没有卡片'
    )
    if (convertedCards.includes('网络 ·')) throw new Error('转本地后仍显示网络徽标')
    console.log('PASS 转本地后书架状态')

    await page.evaluate("window.api.updateSettings({ network: { enabled: false } })")
    await reload(page)
    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '网络搜索').click()"
    )
    const hint = await waitFor(
      page,
      "document.querySelector('.network-search-bar') ? document.body.textContent : ''",
      '关闭联网后网络搜索页没有打开'
    )
    if (!hint.includes('已关闭「允许联网」')) throw new Error('关闭联网后没有提示')
    console.log('PASS 关闭联网提示')
  } finally {
    try {
      if (page) await page.evaluate('window.close()')
    } catch {
      // 窗口可能已经关闭。
    }
    page?.close()
    if (child) await stopApp(child)
    await fake.close()
    log.end()
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await rm(tempDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
}

main()
  .then(() => {
    console.log('验收通过')
    process.exit(0)
  })
  .catch((error) => {
    console.error(`FAIL ${error.message}`)
    process.exit(1)
  })
```

注意：

- 脚本先检查 9222，占用时直接失败，避免连到用户的开发实例。
- 删除 `ELECTRON_RUN_AS_NODE`（本机 shell 会预设它，Electron 会退化成 Node）。
- 假书源只监听 127.0.0.1；主进程仅在 `READER_ALLOW_LOCAL_SOURCES=1` 时放行。
- 失败时打印的 `dev.log` 在临时目录里，进程退出后目录会被清理；需要排查时在 `rm` 前手动复制。

- [ ] **Step 3: 追加回归清单**

在 `docs/regression-checklist.md` 的「导入、合并与数据」后新增：

```md
## 网络书源（2026-11-06）

- [ ] 导入书源 JSON（粘贴/文件/链接）；JS、XPath、WebView、登录源标为「部分兼容」且不执行。
- [ ] 优质池搜索默认只查前 30 个优质源；无结果或点「用全量书源再搜一次」才查全量。
- [ ] 同名同作者的多来源合并为一组，默认显示最佳来源；展开「其他来源」可换源加入。
- [ ] 加入书架后显示「网络 · 书源名」；删除书源后显示「书源已删除」，已缓存章节仍可读。
- [ ] 未缓存章节显示「正在加载本章…」；失败可重试；断网时读缓存正常。
- [ ] 网络书进度按章节估算，拖动进度条能跳到对应章节；本地书进度仍按字数。
- [ ] 更新目录只追加新章，不删旧章、不重排；已缓存章节索引不变。
- [ ] 下载全本有进度；取消后再次下载能续传；部分失败会保留已成功章节。
- [ ] 未下载全本时重新清洗/重新切章/标记章节显示「需下载全本」；转本地书后这些功能恢复。
- [ ] 转本地书后格式变 TXT，进度/书签保留，来源名保留为来源标记。
- [ ] 关闭设置 → 网络 →「允许联网」后，网络搜索/下载不可用，已缓存章节仍可读。
```

- [ ] **Step 4: 跑全量测试、类型检查和构建**

Run:
```bash
npm test
npm run typecheck
npm run build
```
Expected: 全绿。若失败，先修到绿，不允许跳过。

- [ ] **Step 5: 跑离屏验收**

Run:
```bash
node scripts/app-status.cjs
node scripts/acceptance-network.cjs
```
Expected: `app-status` 显示未运行；验收脚本每一步 PASS，最后输出「验收通过」，临时目录已清理。

如果 `app-status` 显示正在运行：先确认是不是用户的正式实例。正式实例不占用 9222（打包版不开调试端口），验收脚本用临时数据目录和离屏窗口，可以并存；只有开发实例（9222 有响应）才必须先关闭。

- [ ] **Step 6: 写验收记录**

新建 `docs/superpowers/acceptance/2026-11-07-network-book-source.md`，记录：

```md
# 网络书源验收（2026-11-07）

## 自动化

- `npm test`：X 个测试文件 / Y 条用例全过
- `npm run typecheck`：通过
- `npm run build`：通过
- `node scripts/acceptance-network.cjs`：通过（离屏、临时数据目录、127.0.0.1 假书源）
- 未访问真实站点；未触碰 `data/`。

## 覆盖

导入书源 / 优质池搜索 / 全量搜索 / 同名分组 / 加入书架 / 按需读章 /
断网读缓存 / 书源删除 / 重新关联 / 更新目录 / 下载全本 / 取消续传 /
转本地书 / 重洗 / 关闭联网提示。

## 已知限制

- 不支持 JS、XPath、WebView、登录/验证码/DRM；这类书源标为部分兼容。
- 不内置、不推荐、不分享书源。
- 网络封面不落盘，书架用书名首字占位。
- 网络书进度按章节估算，未缓存章节没有真实字数。
```

- [ ] **Step 7: 提交与推送**

```bash
git add scripts/acceptance-network.cjs docs/regression-checklist.md docs/superpowers/acceptance/2026-11-07-network-book-source.md tests/network-e2e.test.ts
git commit -m "test(network): add offscreen acceptance and regression checklist"
git -c credential.username=clj3107140872-hue push
```

`-c credential.username` 用于避免 Windows GCM 账号选择卡住；若推送仍失败，重试一次并在最终报告里写明。

---

## 执行顺序

严格按 Task 1 → 17 顺序执行，一个任务一次提交。13–16 都会改 `styles.css`，14/15 还会先后改 `App.tsx`；并行收益小于冲突成本。只有 Task 5 与 Task 6 可以并行（不同文件）。

- Task 1→2→3→4：类型和纯函数是后面所有任务的基础。
- Task 5 与 Task 6 并行；Task 7 依赖两者。
- Task 8→9→10 顺序修改同一个 `bookService.ts`。
- Task 11、12 依赖 Task 8-10；Task 12 依赖 Task 11 的 `OpenBookPayload`。
- Task 13→14→15→16 顺序执行。
- Task 17 最后执行，必须所有测试绿。

## 完成定义

- 所有 Task 复选框完成，`npm test`、`npm run typecheck`、`npm run build` 全绿。
- 离屏验收通过，未访问真实站点，未触碰真实 `data/`。
- `docs/regression-checklist.md` 已追加，验收记录已写。
- 分支 `dev-reader-polish` 已提交并推送；最终报告列出改动、测试结果、限制和后续建议。

