# 网络书源（P2）设计规格

- 日期：2026-11-06
- 状态：待评审
- 关联：[PC 小说阅读器设计规格](2026-10-29-pc-reader-design.md)（P2 网络书源；AI 辅助理解取消）
- 目标：参考「阅读」（Legado 3.0）的书源机制，让用户导入自己的书源 JSON，按书名搜索、加入书架、在线阅读，并支持更新目录与下载全本。

## 1. 背景与目标

### 1.1 背景

原规格把「网络书源」列为 P2，同时把「无任何联网功能」写进了产品约束。用户现在明确要网络书源，AI 辅助理解砍掉。本规格把网络书源作为 P2 的唯一内容，并重新定义联网边界：

- 本地 TXT / EPUB 完全离线，行为不变；
- 只有用户主动搜索、更新、下载、读取未缓存章节时才联网；
- 提供「允许联网」总开关，关闭后已缓存章节仍可读。

### 1.2 目标

- 直接导入现成的「阅读」书源 JSON（常见规则子集），不需要用户自己写格式。
- 搜索默认只打优质书源池（默认 30 个；标星超过 30 个时按标星数量扩大），书源多时不等全量；优质池搜不到或用户主动点全量时才搜全部。
- 网络书与本地书同一个书架、同一套阅读体验；正文按需拉取并缓存，断网可读已缓存部分。
- 已下载全本的网络书可以转为本地书，继续使用重新清洗、重新切章、同书合并。
- 每个网络书带来源标识，同名书来自不同书源时可区分。

### 1.3 成功标准

- 导入一份常见「阅读」书源 JSON，能搜到书、加入书架、在线阅读并缓存、重启后继续读、断网读已缓存章节、更新目录、下载全本、转本地书后重洗/重切。
- 30 个优质书源的搜索在常见网络下 15 秒内出结果，过程可取消、界面不卡。
- 单个书源失败不影响其他结果，错误提示能看懂。
- 现有本地书功能零回归。

## 2. 范围

### 2.1 v1 要做

- 书源：文件 / 粘贴 / http(s) 链接 / `legado://` 分享链接导入；启用停用、标星、拉黑、查看原始 JSON、删除、兼容状态。
- 搜索：优质池（默认 30 个，自动评分 + 手动覆盖）、全量搜索、按书名 + 作者合并、展开其他来源、加入书架。
- 网络书：按需拉正文并缓存、断网读缓存、书内搜索仅覆盖已缓存章节、打开时自动检查更新、手动更新目录。
- 下载全本：进度、取消、失败重试、断点续传；全本后可转本地书，使用重洗/重切/合并。
- 标识：书架卡片显示「网络 · 书源名」，书源删除后显示「书源已删除」。
- 设置：「允许联网」总开关（默认开）、打开网络书自动检查更新（默认开）。

### 2.2 v1 不做

- JS 规则（`<js>`、`@js:`）、XPath（`@xpath:`）。
- 发现/分类浏览（`exploreUrl`、`ruleExplore`）。
- 阅读中换源。
- 登录、Cookie 管理、验证码、WebView 加载。
- 定时自动更新、书源订阅同步。
- 搜索翻页（每个书源只取第一页）。
- 音频/图片/文件书源（`bookSourceType != 0`）。
- 书源规则调试器、书源编辑（只读查看原始 JSON）。
- 按书源配置并发/代理。
- 加入书架时自动下载全本。
- 跨书源自动合并同一本书。

### 2.3 后续候选

JS 沙箱、XPath、发现页、阅读中换源、书源调试器、定时更新、书源订阅、图片章节、按书源配置请求参数、缓存清理面板。

## 3. 关键决策

| 决策 | 结论 |
|---|---|
| 书源兼容 | 兼容「阅读」书源 JSON 的常见子集：CSS、JSONPath、正则、模板变量、GET/POST、请求头、字符集、`nextTocUrl`、`nextContentUrl`；JS/XPath 明确不支持并标记。 |
| 优质书源 | 本机统计真实使用数据自动打分；手动标星的来源全部进入优质池（标星超过 30 个时池子按标星数量扩大），手动拉黑只排除出优质池；普通来源按分数补足到 30 个。 |
| 全量搜索 | 优质池 0 结果时显示按钮，用户点击才跑全量；任何时候也可手动点全量。 |
| 搜索结果 | 按「书名 + 作者」合并；默认选质量最高的书源；可展开「其他来源」在加入书架前换来源。 |
| 网络书存储 | 与本地书同目录；加入时只拉信息 + 目录，正文按需拉取并缓存；同时保留原始正文与清洗后正文。 |
| 阅读器加载 | 本地书保持一次性读取；网络书按需加载，只请求当前三章窗口。 |
| 下载全本 | 用户显式触发；完成后可转本地书；转本地后不再随书源更新。 |
| 书内搜索 | 网络书只搜索已缓存章节；下载全本后等同本地书。 |
| 依赖 | 新增 HTML 解析/选择器库（cheerio 一类）与 JSONPath 库；不引入 JS 执行引擎。 |
| 安全 | 只允许 http/https；拒绝 localhost/内网地址（测试开关除外）；不执行书源 JS；不内置任何书源。 |

## 4. 架构

### 4.1 分层

```
renderer（React）
  书架 · 网络搜索页 · 书源管理页 · 阅读页
        ▲ 类型化 IPC
        ▼
main
  services/network/  书源管理 · 搜索调度 · HTTP · 质量统计 · 网络书生命周期
  services/reader    本地/网络书打开、进度、书签
  storage            books/ · sources/ · settings.json
        ▲
        ▼
core/booksource（纯函数）
  Legado JSON 解析 · 规则求值 · HTML 转文本 · 结果合并 · 质量分 · 目录增量
```

- **core/booksource** 不碰 `electron`、`node:fs`、DOM；允许纯 JS 解析库（cheerio、JSONPath）。可以在 Node 环境直接单测。
- **main** 是唯一联网层，负责超时、并发、Cookie 会话、缓存写盘与错误映射。
- **renderer** 无 Node 权限，所有网络与文件操作经 IPC。

### 4.2 新增/调整文件

```
src/core/booksource/
  legado.ts          书源 JSON 规范化、必填校验、兼容状态、unsupported 检测
  rules.ts           规则表达式解析与求值（CSS / JSONPath / 正则 / 模板变量）
  html.ts            HTML 转纯文本段落
  searchResults.ts   搜索结果规范化、按书名+作者合并、最佳来源
  quality.ts         质量分与优质池选择
  toc.ts             目录解析与增量对比
  model.ts           书源、统计、搜索结果类型
src/main/services/network/
  sourceStore.ts      sources.json / stats.json 读写与 CRUD
  httpClient.ts       超时、大小上限、重定向、编码、Cookie、错误映射
  searchService.ts    多书源搜索调度、事件流、取消
  bookService.ts      加入书架、读章、更新目录、下载全本、转本地
src/main/storage/
  networkBook.ts      网络书目录创建、缓存读写、转换
src/renderer/src/pages/
  Sources.tsx         书源管理页
  NetworkSearch.tsx   网络搜索页
src/renderer/src/components/
  SourceImportDialog.tsx
  SourceList.tsx
  NetworkBookBadge.tsx
```

### 4.3 数据流

**导入书源**

```
JSON / 链接
  → 解析单个对象或数组
  → 必填校验 + 类型校验 + unsupported 检测
  → 同一 bookSourceUrl 更新定义，否则新建
  → 写 sources.json（原子 + .bak）
  → 返回导入/更新/拒绝汇总
```

**搜索**

```
关键词
  → 选优质池（或全量）
  → 并发请求各书源 searchUrl（URL,{options}）
  → 解析 ruleSearch.bookList 与字段
  → 规范化结果，按书名+作者合并，选最佳来源
  → 流式返回分组结果
  → 每个书源的成功/空结果/失败与耗时写入统计
```

**加入书架**

```
选中的搜索结果（sourceId + bookUrl）
  → 同一 sourceId + bookUrl 已在书架则直接打开
  → 拉书籍信息（ruleBookInfo）+ 目录（ruleToc + nextTocUrl）
  → 写 meta.json / progress.json / cover.bin
  → 书架新增「网络书」
```

**阅读**

```
打开书
  → 本地书：一次性返回全部章节（现有逻辑）
  → 网络书：返回目录、缓存章节列表、进度、书签
  → 阅读页请求当前三章窗口
  → 有缓存读缓存；没有则拉正文、转文本、清洗、写 raw/ + chapters/
  → 失败显示占位与重试
```

**更新 / 下载 / 转换**

```
更新目录：拉 TOC → 与现有章节按 URL/标题匹配 → 只追加新章节，已有索引与缓存不变
下载全本：遍历未缓存章节 → 并发拉取 → 进度/取消/失败重试 → 完成判定
转本地：确认 → 用 raw/ 拼 source.txt 与 startLine → 清除 network 绑定 → format=txt
```

### 4.4 IPC 增量

沿用现有 `ipcRenderer.invoke` + 事件推送模式（参考 `import:progress`）。

```
source:list()                                   → SourceListItem[]
source:import({ kind: 'file'|'json'|'url', ... }) → ImportSourcesResult
source:set-flags(id, { enabled?, starred?, blacklisted? })
source:raw(id)                                  → object
source:delete(id)

search:network({ requestId, keyword, scope: 'quality'|'all' })
search:cancel(requestId)
事件：search:source / search:results / search:done / search:error

book:add-network({ sourceId, bookUrl, title?, author? }) → LibraryEntry
book:update-toc(id)                             → { added, total, warnings }
book:download-all(id)                           → 事件 download:progress / download:done
book:download-cancel(id)
book:read-chapter(id, index)                    → { text, cached }
book:open(id)                                   → OpenBookPayload（扩展 contentMode/cachedChapters）
book:convert-to-local(id)                       → 转换结果
事件：book:toc-updated { id, added, total }（自动检查发现新章时推送）
```

- 搜索与下载都带 `requestId` / bookId，事件里回传，渲染层只处理当前请求。
- 搜索取消通过 `AbortController` 中止进行中的请求；下载取消只停止调度新章节，进行中的请求允许完成。已完成的请求不重复处理。

## 5. 书源兼容

### 5.1 导入格式

- 支持单个 JSON 对象或数组；数组里非对象项跳过并计数。
- 只支持 `bookSourceType = 0`（文字）；1 音频、2 图片、3 文件直接拒绝并说明；`bookSourceType` 缺省按 0 处理。
- `bookSourceUrl` 必须是合法的 http(s) 地址；搜索 URL 为相对路径时按它解析。
- 单次导入上限：5 MB、500 个书源；同一批次内 `bookSourceUrl` 相同的条目合并，后者覆盖前者。
- 必填字段：
  - `bookSourceName`
  - `bookSourceUrl`
  - `searchUrl`
  - `ruleSearch.bookList`
  - `ruleSearch.name`
  - `ruleSearch.bookUrl`
  - `ruleToc.chapterList`
  - `ruleToc.chapterName`
  - `ruleToc.chapterUrl`
  - `ruleContent.content`
- 缺任一必填字段视为「不支持」，拒绝导入并列出缺项。
- `bookSourceUrl` 相同的再次导入视为更新：替换定义，保留 `id`、启用状态、标星/拉黑、统计。
- `enabled` 字段尊重书源自带值；缺省为 true；`bookSourceType` 接受数字或数字字符串。
- `header` 必须是合法 JSON 字符串；解析失败时忽略并给出警告。
- `bookSourceGroup` 仅用于展示与筛选；`customOrder` 用于同分排序。
- 读取文件/链接内容时去掉 UTF-8 BOM，再按 JSON 解析。
- 导入结果：`{ added, updated, rejected: [{ name?, url?, reason }], warnings: string[] }`。

### 5.2 兼容状态

| 状态 | 含义 |
|---|---|
| 完全支持 | 必填字段齐全，且所有用到的规则都是支持的语法。 |
| 部分支持 | 必填字段齐全，但某些规则用了 JS/XPath/WebView 等；相关操作会失败并给出明确提示，其他操作仍可用。 |
| 不支持 | 缺必填字段、非文字书源、或无法解析 JSON；拒绝导入。 |

`partial` 的来源要记录 `issues: string[]`，例如「正文规则使用了 JS」「目录规则使用了 XPath」「搜索 URL 使用 WebView」。

部分支持按操作生效：

- 搜索规则不支持 → 搜索失败；
- 书籍信息规则不支持 → 跳过书籍信息，用搜索结果的书名/作者继续加入；
- 目录规则不支持 → 加入书架/更新目录失败；
- 正文规则不支持 → 读章/下载全本失败。

### 5.3 规则语法（v1）

**选择器与取值**

- 默认 CSS；`@css:` 显式 CSS；`@json:` JSONPath；前缀大小写不敏感。
- 取值后缀：`@text`、`@ownText`、`@html`、`@textNode`、`@href`、`@src`；后缀大小写不敏感。
- 数字索引：`.0`、`.-1` 这类简单索引支持；复杂 CSS 伪类（如 `:contains()`）不保证。
- 规则可以链式组合：
  - `||`：依次尝试，取第一个非空结果。
  - `&&`：把多个规则的结果合并（列表拼接；文本按换行拼接）。
  - `##正则##替换##`：对结果做正则替换；支持 `###` 结尾的 OnlyOne 写法（只处理第一个匹配）。
- `ruleSearch.init` / `ruleBookInfo.init`：作为后续规则的上下文容器；使用 JS 的 init 标记为 partial。

**模板变量**

- 支持：`{{key}}`、`{{searchKey}}`、`{{page}}`、`{{searchPage}}`、`{{pageIndex}}`、`{{baseUrl}}`、`{{bookUrl}}`、`{{book.name}}`、`{{book.author}}`、`{{chapter.name}}`、`{{chapter.url}}`。
- `{{key}}` 在 URL 中按 UTF-8 做百分号编码；在 POST body 中原样使用。
- 未知变量替换为空字符串并记一条警告，不中断请求。
- `{{}}` 内是 JS 表达式（如 `{{(page-1)*20}}`、`{{java.encodeURI(key,'gbk')}}`）的规则不支持，标记为 partial。GBK 站点的搜索词编码因此可能不兼容。

**请求**

- `searchUrl` 支持「阅读」的 `URL,{JSON options}` 写法：
  ```json
  "searchUrl": "https://example.com/search,{\"method\":\"POST\",\"body\":\"key={{key}}&page={{page}}\",\"charset\":\"gbk\",\"headers\":{\"Referer\":\"https://example.com\"}}"
  ```
- 支持 options：`method`（GET/POST）、`body`、`charset`、`headers`、`retry`；`method` 缺省 GET，`retry` 最大 3。
- `searchUrl` 不是 `URL,{JSON}` 形式时按普通 URL 处理；options 段从右往左找第一个能解析为 JSON 的 `,{...}`，解析失败则按普通 URL 处理并记一条警告。
- POST body 只做模板替换，不做 URL 编码或 JSON 转义；发送前按 `charset` 编码为字节（GBK 站点可正常提交中文）。
- GET 查询参数统一按 UTF-8 编码；需要 GBK 编码的源通常依赖 JS 编码，v1 会标记为 partial。
- 不支持 `webView: true`；遇到时该来源标记 partial。
- 请求头合并顺序：书源 `header` → URL options `headers`；后者覆盖前者；请求头值也做模板替换（可用 `bookUrl`、`chapter.url` 等）。
- 字符集优先级：URL options `charset` → 书源 `charset` → HTTP 响应头 → 自动探测（BOM / meta charset）；支持 UTF-8、GBK、GB18030、Big5，未知字符集按 UTF-8 处理并警告。
- Cookie：书源 `header` 里的 Cookie 原样使用；响应 `Set-Cookie` 按来源 + 域名保存在内存会话中，只发给同域请求；不落盘。

**各规则支持的字段**

- `ruleSearch`：`init`、`bookList`、`name`、`author`、`intro`、`kind`、`coverUrl`、`bookUrl`、`lastChapter`；`wordCount` 忽略。
- `ruleBookInfo`：`init`、`name`、`author`、`intro`、`kind`、`coverUrl`、`tocUrl`、`lastChapter`；`wordCount`、`relatedBooks` 忽略。
- `ruleToc`：`chapterList`、`chapterName`、`chapterUrl`、`isVolume`、`nextTocUrl`。
- `ruleContent`：`content`、`nextContentUrl`、`sourceRegex`、`replaceRegex`；`webJs` 不支持。
- 缺失的可选字段按空值处理；`name`/`bookUrl`/`chapterName`/`chapterUrl`/`content` 缺失或为空时跳过该条或该章。
- 规则以 `@json:` 开头时按 JSON 解析响应，其余按 HTML；JSONPath 在 JSON 对象/数组上求值，CSS 在 HTML 上求值。

**目录与正文**

- `ruleToc.nextTocUrl`：支持翻页拉完整目录，最多 50 页；单书目录上限 20,000 章，超出截断并警告。
- `ruleContent.nextContentUrl`：支持正文分页拼接，最多 20 页。
- `ruleContent.sourceRegex` / `replaceRegex`：支持纯正则写法；使用 JS 的标记为 partial。
- `ruleContent.webJs`：不支持，标记 partial。
- `isVolume`：解析为 `level: 'volume'`；卷条目不拉正文，阅读页显示标题，TOC 保留。
- 搜索结果在同一书源内按 `bookUrl` 去重；目录按 `chapterUrl` 去重。缺 `name`/`bookUrl` 的搜索结果、缺 `chapterName`/`chapterUrl` 的非卷目录项直接跳过。
- `nextTocUrl` / `nextContentUrl` 记录已访问 URL，重复即停止，防止死循环。
- 相对 URL 一律相对于触发它的响应 URL 解析（搜索页 / 书籍页 / 目录页 / 正文页）。

### 5.4 不支持规则的检测

导入时扫描所有规则字符串与 URL options：

- 包含 `<js>`、`@js:`、`@js` 取值后缀、`@xpath:`、`webView: true`、`loginUrl`、`loginUi`、`loginCheckJs`（不区分大小写）。
- 记录字段路径与原因；兼容状态设为 `partial`。
- 搜索/目录/正文运行时再次检查；如果命中的正是当前操作要用的规则，直接返回「该书源的部分规则暂不支持」并记录失败。

## 6. 数据模型与存储

### 6.1 书源

`data/sources/sources.json`：

```ts
interface SourcesFile {
  version: 1
  sources: StoredSource[]
}

interface StoredSource {
  id: string                  // 内部 uuid，导入时生成
  definition: Record<string, unknown> // 原始「阅读」书源 JSON
  enabled: boolean
  starred: boolean            // 手动标为优质
  blacklisted: boolean        // 只排除出优质池
  compat: {
    level: 'full' | 'partial'
    issues: string[]
  }
  importedAt: string
  updatedAt: string
}

interface SourceListItem {
  id: string
  name: string
  url: string
  group: string
  enabled: boolean
  starred: boolean
  blacklisted: boolean
  compat: { level: 'full' | 'partial'; issues: string[] }
  score: number
  searchSuccessRate: number
  avgMs: number
  lastError?: { operation: string; message: string; at: string }
}
```

`data/sources/stats.json`：

```ts
interface StatsFile {
  version: 1
  bySource: Record<string, SourceStats>
}

interface SourceStats {
  search: OperationStats
  info: OperationStats
  toc: OperationStats
  content: OperationStats
  score: number               // 0..100
  lastError?: { operation: string; message: string; at: string }
  lastUsedAt: string | null
}

interface OperationStats {
  attempts: number
  successes: number
  empties: number             // 请求成功但 0 条结果；目录/正文为空也算
  errors: number
  totalMs: number
}
```

- `sources.json` 原子写入 + `.bak`；损坏时回滚并提示。
- `stats.json` 独立存储，写入防抖 2 秒，退出前 flush；损坏时重置为空统计，不影响书源定义。
- 书源统计只存本机，不上传。

### 6.2 网络书

扩展现有模型（全部为可选字段，旧数据不受影响）：

```ts
type BookFormat = 'txt' | 'epub' | 'network'

interface NetworkBookInfo {
  sourceId: string
  sourceUrl: string           // 用于书源删除后按 URL 重新关联
  sourceName: string          // 快照，书源删除后仍能显示
  bookUrl: string
  tocUrl: string
  lastChapter?: string
  lastTocAt: string | null
  lastCheckAt: string | null
  lastDownloadAt?: string | null
}

interface ChapterMeta {
  // ...现有字段
  url?: string                // 网络章节地址
}

interface BookMeta {
  // ...现有字段
  format?: BookFormat
  intro?: string
  kind?: string
  network?: NetworkBookInfo
}

interface LibraryEntry {
  // ...现有字段
  format?: BookFormat
  intro?: string
  kind?: string
  sourceName?: string         // 网络书来源；转换后保留作来源说明
  networkCache?: { cached: number; total: number }
  downloadState?: 'none' | 'partial' | 'complete'
  lastUpdateAt?: string
}
```

目录结构：

```
data/books/<id>/
  meta.json          # format=network + network 信息 + chapters
  progress.json
  cover.bin          # 可选
  chapters/00000.txt # 清洗后正文（阅读用）
  raw/00000.txt      # 原始正文（HTML 转文本、清洗前；供重新清洗）
```

- 网络书没有 `source.txt` 与 `original.bin`；原始正文放在 `raw/`，清洗后正文放在 `chapters/`。
- 加入书架时只写 `meta.json`、`progress.json`，`chapters/` 与 `raw/` 为空。
- 网络书 `encoding = 'utf-8'`（正文统一转 UTF-8 存储）；`chapterStarts` 不写；章节初始 `startLine = 0`、`charCount = 0`、`simhash = ''`，`titleHash` 按标题计算，拉正文后不强制回写。
- `intro` / `kind` / `lastChapter` 从书籍信息或搜索结果写入 `BookMeta`、`LibraryEntry`、`NetworkBookInfo`；目录更新时刷新 `lastChapter`。
- 缓存章节以 `chapters/` 文件存在且**非空**为准；空文件视为未缓存并重新拉取。打开书时一次 `readdir` 得到已缓存索引。
- `LibraryEntry.networkCache.total` = 有 URL 的章节数（卷条目不参与）；`cached` = 对应的已缓存章节数。
- `LibraryEntry.networkCache` 与 `downloadState` 是冗余字段，供书架快速显示；打开书、读章、更新、下载后校准。
- `downloadState` 定义：
  - `none`：0 章缓存；
  - `partial`：有缓存但未覆盖全部有 URL 的章节；
  - `complete`：全部有 URL 的章节都已缓存（卷条目不参与统计）；`total = 0` 也视为 `complete`。
- `BookFormat` 新增 `network` 后，所有按 `format` 分支的地方（书架卡片、详情、重洗/切章/合并入口）都要显式处理；`BookCard` 的格式标签要显示「网络」，不能落到 TXT。
- `BookRepository` 增量：`createNetworkBook`、`writeNetworkMeta`、`listCachedChapters`、`writeNetworkChapter`、`readRawChapter`、`readNetworkChapter`；本地书的 `writeBook`/`readBook` 行为不变。
- 删除网络书时连同 `raw/`、`chapters/`、`cover.bin` 一起删除。

### 6.3 数据安全

- `meta.json`、`progress.json`、`sources.json`、`stats.json` 全部原子写入；正文缓存按章原子写入（临时文件 + rename）。
- 转本地书使用临时快照（复制整个网络书目录，含 `raw/`）：失败自动回滚，成功后删除；不进入常规「恢复备份」列表。
- 本地书的 `writeBook` 备份机制不变；网络书不参与该备份列表。
- 旧版本书目（没有 `format`）一律按 TXT 处理；不需要数据迁移。
- 网络书的 `progress.json` 格式与本地书一致，`chapterKey` 优先、章节序号兜底。

## 7. 搜索与质量

### 7.1 质量统计

每完成一次操作，更新对应 `OperationStats`：

- 搜索：请求成功并解析出结果记 success；解析成功但 0 条记 empty；请求失败、规则不匹配、编码失败记 error。
- 书籍信息 / 目录 / 正文：成功且内容非空记 success；成功但为空记 empty；失败记 error。
- 用户取消的请求不计入 attempts/success/error；只有真正完成的请求才更新统计。
- 耗时按毫秒累计，平均耗时 = `totalMs / attempts`。
- `info` 统计用于排查问题，不参与质量分。

### 7.2 质量分

```
searchRate  = (search.successes + 0.5 * search.empties) / max(1, search.attempts)
tocRate     = toc.successes / max(1, toc.attempts)
contentRate = content.successes / max(1, content.attempts)
speedScore  = 1 - min(avgMs / 10000, 1)

score = 35 * searchRate + 20 * tocRate + 30 * contentRate + 15 * speedScore
```

- `avgMs` 使用搜索平均耗时；没有搜索数据时 `speedScore = 0.5`。
- 某项没有尝试时，该项比率按 0.5 计（中性），避免新书源直接判死刑。
- `search`/`toc`/`content` 都没有尝试时，直接使用初始分：`full = 60`、`partial = 40`，不套公式；有任何统计后按公式计算。
- `partial` 来源额外减 10 分，最低 0。
- 手动标星不改变分数，只改变优质池入选与排序优先级。
- 手动拉黑不影响分数，只把书源排除出优质池；全量搜索仍会搜。
- 分数范围 0–100，保留一位小数。

### 7.3 优质池

- 候选：`enabled = true` 且 `blacklisted = false`。
- 优质池 = 全部标星候选 + 其余候选按分数从高到低补足到 30 个。
- 标星候选超过 30 个时，池为全部标星候选（不截断）；界面提示「优质池较大，搜索会变慢」。
- 排序：标星组在前、非标星组在后；组内按 `score` 降序，同分按 `customOrder`（若有）再按 `importedAt` 升序。
- 新书源初始分：`full` 60 分，`partial` 40 分。
- 普通候选的补足目标 30 在 v1 固定，不做设置项；标星候选不截断。优质池为空时提示去书源页启用书源或直接全量搜索。

### 7.4 搜索调度

- 关键词去空白后为空时不发起搜索。
- 同一时间只允许一个搜索请求；发起新搜索会取消旧搜索。
- 并发上限：6 个书源同时请求。
- 单书源超时：10 秒；超时后记录 error，不影响其他结果。
- 搜索结果每个书源只取第一页：`{{page}} = 1`；每个书源最多保留前 100 条结果。
- 结果流式推送：每个书源完成后更新一次分组结果；首屏通常 2–3 秒出现，全部完成受最慢书源影响；界面可随时取消。
- 优质池搜索返回 0 组：
  - 显示「优质书源没找到，全量搜索（N 个书源）」按钮；
  - 只有用户点击才发起全量，不自动。
- 全部书源都是 error（没有任何 success/empty）：
  - 显示错误汇总与「重试」，不显示「全量搜索」作为误导；
  - 用户仍可手动切全量。
- 全量搜索：所有 `enabled = true` 的书源（含黑名单），同样并发/超时/取消；结果按质量排序。
- 搜索会更新所有被搜索书源的统计，因此跑一次全量后排名会更准。

### 7.5 结果合并与展示

```ts
interface NetworkSearchItem {
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
}

interface NetworkSearchGroup {
  key: string
  title: string
  author: string
  items: NetworkSearchItem[]
  bestSourceId: string
}
```

- `normalizeSearchTitle` / `normalizeSearchAuthor` 放在 `searchResults.ts`：去首尾空白、合并连续空白、全角空格转半角、拉丁字母转小写；不做书名模糊匹配。
- 合并键：`normalizeSearchTitle(title) + '|' + normalizeSearchAuthor(author)`。
  - 作者为空时按空字符串处理；同名但作者不同的结果不合并。
  - 同一组内每个书源最多保留一条结果（按该来源搜索返回顺序取第一条）。
- 每组选「最佳来源」：
  1. 手动标星优先；
  2. 质量分高者；
  3. 搜索平均耗时短者；
  4. 导入早者。
- 展示字段：书名、作者、封面（可选）、最新章节、来源书源、质量标识、是否已在书架。
- 搜索结果不主动拉封面，显示书名首字占位；加入书架后再拉封面。
- 每组默认显示最佳来源；展开「其他来源（N）」可看到组内所有来源，手动选择后再加入书架。
- 「已在书架」按条目判断：`sourceId + bookUrl` 相同则该项标记「已在书架」，点击直接打开；同组其他来源仍可加入。
- 全量结果同样按最佳来源的质量分排序。

### 7.6 加入书架

- 必填：`sourceId`、`bookUrl`。
- 先查重：同一 `sourceId + bookUrl` 已存在则直接打开，不新增；同一目标正在加入时复用进行中的 Promise，避免双击重复建书。
- 拉书籍信息（有 `ruleBookInfo` 时）与目录（`ruleToc` + `nextTocUrl`）。
- 目录为空或拉取失败：不加入书架，提示「目录获取失败，换一个书源试试」。
- 书信息失败但目录成功：仍可加入，书名/作者/简介/分类/最新章节用搜索结果补齐，缺失字段留空，给出警告。
- 封面异步拉取；失败不影响加入。
- 书架条目：
  - `format: 'network'`、`encoding: 'utf-8'`、`normalizedTitle` 用 `normalizeSearchTitle(title)`
  - `sourceName`、`networkCache: { cached: 0, total: 有 URL 的章节数 }`、`downloadState: 'none'`
  - `fileHash` 用 `sourceId + bookUrl` 的稳定哈希（用于查重）
  - `sourceFileName` 设为 `<title>.txt`（去掉 `\\/:*?"<>|` 等文件名字符，保证转换后合并时标题推导正常）
  - `chapterCount` = 目录章节数，`progressPercent = 0`，`lastReadAt = null`
  - `stats` 清零
  - `lastCheckAt`、`lastTocAt` 设为加入时间
- 书籍目录用 `BookRepository` 的网络书写入方法创建，不写 `source.txt`。

## 8. 网络书生命周期

### 8.1 打开与读章

- `book:open`：
  - 本地书：`contentMode = 'eager'`，`chapters: string[]`，现有行为不变；跳过网络书的缺章恢复逻辑。
  - 网络书：`contentMode = 'lazy'`，`chapters: []`，`cachedChapters: number[]`；同时返回 meta、进度、书签、警告（书源已删除等）。
- `book:read-chapter(id, index)`：
  1. 校验书 id、章节索引；
  2. 有非空的 `chapters/<index>.txt` 直接返回，`cached = true`；
  3. 卷章节（`level = 'volume'`）：返回空文本，`cached = true`，不联网；非卷章节没有 URL 时报「章节地址缺失」；
  4. 网络书且允许联网：检查书源存在/启用；
  5. 拉正文 → HTML 转纯文本段落 → 应用清洗规则 → 写 `raw/` 与 `chapters/`（原子写）；
  6. 更新 `LibraryEntry.networkCache` 与 `downloadState`（防抖；缓存覆盖全部章节时变为 `complete`）；
  7. 返回 `{ text, cached: false }`。
- 同一章并发请求共享同一个 Promise，避免重复下载。
- 每本书的读章 + 下载合计最多 2 个正文请求；读章全局最多 6 个，下载另有全局 4 个；读章与下载共用每本书的信号量。
- 单章正文上限 2 MB（转文本后）；超出截断并记警告。
- 清洗后正文为空时保留原始文本并给出警告，不能返回空章；完全无内容视为失败，不写缓存。
- 失败不写缓存；渲染层显示占位和「重试」。

### 8.2 更新目录

- 触发：手动「更新目录」，或打开网络书时自动检查（可关）。
- 自动检查节流：同一本书 30 分钟内最多一次；联网关闭、书源已删除或正在下载时跳过。
- 拉取 `tocUrl`（没有则 `bookUrl`），支持 `nextTocUrl` 翻页。
- 对比规则：
  - 先按 `url` 匹配现有章节；
  - 再按 `chapterTitleHash` 匹配；
  - 匹配到则更新标题/URL，保留原索引与缓存；标题变化时重算 `titleHash`；
  - 未匹配到的新章节追加到末尾；
  - 目录里消失的章节保留，不删除。
- 只追加，不重排，保证缓存文件名与进度索引不变；旧进度/书签找不到 `titleHash` 时按章节索引兜底。
- 更新 `meta.chapters`、`chapterCount`、`lastTocAt`、`lastCheckAt`；有新增内容章节时更新 `lastUpdateAt`，重算 `networkCache.total`（新增章节显示为未缓存），并把 `downloadState` 从 `complete` 改为 `partial`。
- 自动检查失败只写日志，不打扰用户；手动更新失败要提示原因。
- 更新与下载、转本地互斥；同一本书同时只允许一个更新任务。

### 8.3 下载全本

- 触发：书架右键「下载全本」。
- 范围：所有有 URL 且 `chapters/` 不存在或为空的章节；卷条目跳过。
- 并发：每本书同时 2 个，同一书源同时 2 个，全局最多 4 个；每个请求 10 秒超时；失败自动重试 1 次。
- 事件：`download:progress { done, total, failed }`；完成时 `download:done { done, total, failedChapters }`。
- 取消：停止调度新章节；进行中的请求允许完成；状态按实际缓存保持 `none` / `partial`。
- 单章失败继续下载其他章节；结束后列出失败章节，可「重试失败章节」。
- 全部成功后 `downloadState = 'complete'`，`lastDownloadAt` 更新；`networkCache.cached` 校准为 `total`。
- 下载过程中可以继续阅读；读章与下载共享每本书的信号量与缓存，不重复写。
- 同一本书同时只允许一个下载任务；下载与更新、转本地互斥。
- 下载中途书源被删除/停用：剩余章节记为失败并结束，已缓存章节保留。

### 8.4 转为本地书

- 触发：对「已下载全本」的网络书执行重新清洗 / 重新切章 / 同书合并时，或从右键菜单直接点「转为本地书」。
- 前置检查：`downloadState = 'complete'`；否则提示「本书未下载全本，无法重新清洗/切章/合并」并给「去下载全本」按钮。服务层也要校验，不能只靠界面置灰。
- 确认弹窗：
  > 此操作会修改章节结构，之后不再随书源更新。继续后会转为本地书。
- 转换步骤：
  1. 取消该书的下载任务、停止更新；等待进行中的读章请求结束；
  2. 创建临时快照（复制整个网络书目录，含 `raw/`）；失败自动回滚，成功后删除；
  3. 按章节顺序拼接 `source.txt`：每章写入标题行 + `raw/` 段落，章间空行；卷章节只写标题；raw 首行与章节标题相同时去掉，避免重复标题；
  4. 按 `source.txt` 实际行数计算每章 `startLine`（空行也计数）；保留 `title`、`level`、`titleHash`；
  5. 用清洗后正文回填 `charCount` 与 `simhash`，保证转换后同书合并、重复章节检测正常；
  6. 删除 `ChapterMeta.url`，删除 `network` 字段；`format = 'txt'`、`encoding = 'utf-8'`；
  7. 删除 `raw/`（内容已进 `source.txt`）；
  8. 更新书库索引：`format = 'txt'`；清除 `networkCache`、`downloadState`，保留 `sourceName`（作为来源说明）、`lastUpdateAt` 与 `sourceFileName`。
- 转换时 `raw/` 缺失的章节用 `chapters/` 清洗后正文回退，并记警告。
- 转换后的书没有 `original.bin`，切换编码入口禁用，提示「网络书转换后不支持切换编码」。
- 转换后：
  - 可以重新清洗、重新切章、合并；
  - 不再有「网络」徽标（徽标只看 `format`），不再更新；书源删除不影响；
  - 进度、书签按 `chapterKey`/索引保留。
- 合并场景：
  - 目标书或源书任一为网络书，先按上述流程转本地；
  - 合并结果始终是本地书；
  - 转换确认在合并确认之前，避免用户误以为还能更新。

### 8.5 删除书源与删除书

- 删除书源：
  - 先取消该来源正在进行的搜索、更新、下载任务；
  - 从 `sources.json` 删除定义，从 `stats.json` 删除统计；
  - 已加入书架的 N 本网络书保留：可读已缓存章节，不能更新/下载/拉新章；
  - 书架显示「书源已删除」；重新导入同一 `bookSourceUrl` 时，导入流程立即扫描书库，按 `NetworkBookInfo.sourceUrl` 重新关联，把 `sourceId` 更新为新 id、刷新 `sourceName` 快照后持久化。
- 停用书源：与删除一样取消该来源进行中的搜索/更新/下载任务，但保留定义与统计。
- 删除网络书：
  - 有下载/更新任务先取消；
  - 删除整个书籍目录（含 `raw/`、`chapters/`、`cover.bin`）；
  - 从书库索引移除。

## 9. 阅读器接入

### 9.1 数据加载

```ts
interface OpenBookPayload {
  // ...现有字段（meta、progress、bookmarks、warnings）
  contentMode: 'eager' | 'lazy'
  chapters: string[]          // 本地书：全部章节；网络书：[]
  cachedChapters: number[]    // 网络书：已缓存章节索引；本地书：[]
}
```

- 新增章节提供层，阅读页通过统一接口取正文：
  - 本地书：`EagerChapterProvider`，直接使用 `OpenBookPayload.chapters`（现有行为）。
  - 网络书：`LazyChapterProvider`，按索引调用 `book:read-chapter`，维护 `loading / loaded / error` 状态。
- 卷轴模式只请求 `chapterWindow` 的三章；窗口滑动时请求新增章节。
- 翻页模式只请求当前章；章末进入下一章时再请求。
- 未加载章节显示占位（标题 + 加载中/失败重试），不阻塞其他章节渲染。
- 书源已删除/未联网时，打开仍成功；未缓存章节显示对应错误与「去书源页」/「打开联网」提示。

### 9.2 进度与定位

- 进度、书签、目录、搜索跳转的定位逻辑不变。
- 跳转到未缓存章节：先显示占位并加载，加载完成后按段落定位；加载失败显示错误与重试。
- 翻页模式加载完成后重新分页并按锚点定位。
- 自动更新追加章节不影响当前章节索引与进度。

### 9.3 书内搜索

- 网络书只搜索已缓存章节：
  - `SearchService` 跳过 `chapters/` 中不存在或为空的章节；
  - 搜索面板显示「仅搜索已缓存章节（x/y）」；
  - 搜到的结果可以跳转；未缓存章节不参与。
- 下载全本后，所有章节都可搜索，提示消失。

### 9.4 自动检查更新

- 打开网络书时后台调用一次目录检查；不阻塞打开。
- 节流：同一本书 30 分钟内最多检查一次；联网关闭或书源已删除时跳过。
- 发现新章节：顶部 toast「发现 N 个新章节」，点击可刷新目录。
- 失败：静默记录日志；手动更新时才提示。
- 设置关闭后不自动检查，手动更新仍可用。

### 9.5 样式与模式

- 网络书与本地书共用排版、主题、翻页、摸鱼模式、代码伪装。
- 加载占位、错误条、网络徽标走现有主题变量，夜间模式可见。
- 代码伪装模式下不显示网络相关的额外 UI，保持伪装效果。

## 10. 界面

### 10.1 书架

- 顶栏新增「网络搜索」「书源」两个入口。
- 网络书卡片：
  - 「网络 · 书源名」徽标；
  - 格式标签显示「网络」，不能落到 TXT/EPUB；
  - 下载状态：`未缓存` / `已缓存 x/y 章` / `已下载全本`；
  - 下载中显示进度条与「取消」。
- 右键菜单：
  - 通用：打开、删除；
  - 网络专属：更新目录、下载全本、取消下载、查看书源、转为本地书（仅全本时可用）；
  - 网络书的本地操作（重新清洗/切章/合并）：未全本时置灰，点击提示「本书未下载全本，无法…」并给「去下载全本」；本地书正常可用。
- 同名书靠「网络 · 书源名」徽标区分；书源删除后徽标显示「网络 · 书源已删除」。徽标只看 `format === 'network'`，转换后的本地书即使保留 `sourceName` 也不显示网络徽标。

### 10.2 网络搜索页

- 顶部搜索框 + 范围切换：`优质书源（N）` / `全部书源（M）`，N 为实际池大小。
- 搜索中显示进度：已搜索 / 失败 / 剩余书源；可取消。
- 结果列表：封面、书名、作者、最新章节、来源书源、质量标识、加入书架/已在书架；搜索阶段不拉远程封面，用书名首字占位。
- 展开「其他来源（N）」：显示该组内每个来源的书籍信息与质量分，选择后再加入。
- 「已在书架」按条目显示；同组其他来源仍可加入。
- 优质池 0 结果时显示「全量搜索」按钮；全部失败时显示错误汇总和重试。

### 10.3 书源管理页

- 顶部：书源总数、已启用、优质池数量、「导入书源」。
- 筛选：全部 / 优质池 / 部分支持 / 已停用 / 已拉黑；按分组过滤。
- 列表行：名称、站点、分组、兼容状态、质量分/排名、搜索成功率、平均耗时、最近失败原因。
- 操作：启用/停用、标星、拉黑、查看原始 JSON（只读）、删除。
- 删除书源确认文案：说明已加入书架的 N 本书将无法更新和下载新章节，已缓存内容仍可读。
- 顶部「网络设置」：
  - 允许联网（默认开）
  - 打开网络书时自动检查更新（默认开）
- 同一组设置在阅读页设置面板的「网络」分组也出现，读写同一字段；v1 只做这两个入口。

### 10.4 导入书源

- 三种方式：选择 JSON 文件、粘贴 JSON、输入链接。
- 链接支持：
  - `http://` / `https://` 的 JSON 地址；
  - `legado://import/bookSource?src=<url>`，先 URL 解码再提取 `src` 后下载；
  - 其他私有协议拒绝。
- 链接下载上限 5 MB，超限或返回非 JSON 时给出明确错误。
- 导入前预览：
  - 新增 N 个、更新 N 个、拒绝 N 个；
  - 拒绝项列出名称/URL（能解析时）和原因。
- 导入结果汇总：成功、更新、拒绝及原因。
- 导入对话框底部固定说明：程序不提供任何书源；书源由用户自行导入；内容合规由用户自行负责。

### 10.5 书籍详情

- 显示来源书源、最后更新时间、缓存章节数 / 总章节数、下载状态。
- 书源删除后显示「书源已删除」，更新/下载按钮禁用。
- 转为本地书后用 `sourceName` 显示「原网络书源：X」，不影响功能。

## 11. 错误处理与安全

### 11.1 用户可见错误

| 场景 | 文案 |
|---|---|
| 联网关闭 | 已关闭联网功能，请到设置里打开后再搜索/更新/下载 |
| 超时 | 连接《书源名》超时，请稍后重试或换个书源 |
| 403 | 《书源名》拒绝访问（403），可能需要登录或更换书源 |
| 404 | 《书源名》页面不存在（404），书源可能已失效 |
| 429 | 《书源名》请求太频繁（429），请稍后再试 |
| 5xx | 《书源名》站点暂时不可用（5xx），请稍后再试 |
| 规则不匹配 | 《书源名》的搜索页/目录/正文解析失败，可能站点改版了 |
| 不支持规则 | 《书源名》使用了暂不支持的 JS/XPath 规则 |
| 章节未缓存 | 本章还没缓存，需要联网下载 |
| 书源已删除 | 这本书的书源已删除，只能阅读已缓存章节 |
| 书源已停用 | 这本书的书源已停用，只能阅读已缓存章节 |
| 正文为空 | 这一章没有解析出正文，可能书源规则失效了 |
| 下载不完整 | 下载完成 X/Y 章，N 章失败 |
| 本地地址 | 不允许访问本地或内网地址 |

- 所有错误必须映射为中文，不出现 Electron IPC 前缀或裸 Node 错误。
- 用户主动取消不算错误；下载状态按实际缓存保持 `none` / `partial`。
- 错误同时写入 `data/logs/app.log`：书源名、操作、状态码、耗时；不记录正文、关键词、请求头和 Cookie。

### 11.2 安全边界

- 只允许 `http://` 与 `https://`；拒绝 `file://`、`data:`、`ftp://` 等。
- 拒绝 localhost、`127.0.0.0/8`、`::1`、`10/8`、`172.16/12`、`192.168/16`、`169.254/16`、`fc00::/7`、`fe80::/10`。
- 请求前解析域名；解析结果命中上述内网/本地地址时拒绝（防止域名指向内网）。测试环境用 `READER_ALLOW_LOCAL_SOURCES=1` 放行 `127.0.0.1`。
- 每次请求：
  - 超时 10 秒；
  - 响应体上限 10 MB（解压后按流计数，超限中止）；
  - 最多 5 次重定向，每次重定向都重新校验协议与地址；
  - GET 超时自动重试 1 次；4xx 不重试。
- 不执行书源 JS，不 `eval`，不 `new Function`，不加载 WebView。
- HTML 只解析取文本；`<script>`、`<style>`、`<iframe>` 等剥离。渲染层不使用 `dangerouslySetInnerHTML` 展示搜索/书籍/正文内容。
- 封面由主进程下载，校验图片类型与大小（上限 5 MB），以 data URL 传给渲染层；不接受 SVG。
- Cookie 仅内存会话，不落盘；不做登录、验证码、DRM 绕过。
- 书源 JSON 里的 Cookie/令牌会原样保存在本地 `sources.json`；不要提交到 git 或分享。
- 书源统计只存本机；无遥测、无云端。
- 不内置、不推荐、不分享任何书源；导入界面显示合规说明。

## 12. 设置

```ts
interface AppSettings {
  // ...现有字段
  network: {
    enabled: boolean          // 默认 true
    autoCheckOnOpen: boolean  // 默认 true
  }
}
```

- 旧设置文件缺少 `network` 时补默认值，不迁移数据；设置面板与书源页读写同一字段。
- `enabled = false`：
  - 网络搜索、加入书架、更新目录、下载全本、拉未缓存章节、通过链接导入书源全部拒绝；
  - 已缓存章节、书籍信息、目录、本地文件导入照常；
  - 所有网络入口显示「已关闭联网」提示。
- `autoCheckOnOpen = false` 时打开网络书不自动检查目录；手动更新仍可用。
- 书源管理、搜索范围、超时、并发、普通候选补足目标（30）不在 v1 暴露为设置项。

## 13. 测试与验收

遵循全局测试规范：只测关键行为，不追覆盖率，测行为不测实现。

### 13.1 core 单测

- 书源解析与校验：单个/数组、缺字段、`bookSourceType` 非 0/缺省、同 URL 更新、同批次去重、`header` 非法 JSON。
- 不支持检测：`<js>`、`@js:`、`@xpath:`、`webView: true`、登录字段；兼容状态与 issues。
- URL options：`URL,{method,body,charset,headers,retry}`；非法 JSON 回退为普通 URL。
- 模板变量：`{{key}}`/`{{page}}`/`{{baseUrl}}`/书籍/章节变量；URL 编码；JS 表达式标记 partial。
- 规则求值：CSS、`@css:`、`@json:`、`@text`/`@href`/`@src`/`@html`、`||`、`&&`、`##正则##替换##`、简单索引、`init` 上下文。
- HTML 转文本：实体、`<br>`、块级元素、脚本/样式剥离、嵌套标签、空内容。
- 结果合并：同书名+作者合并、不同作者不合并、缺失作者、最佳来源选择。
- 质量分：无统计初始分 60/40、有统计后的中性项、全成功、有错误、耗时、partial 扣分、标星/拉黑、标星超过 30 个时池扩大。
- 目录增量：追加新章、更新标题/URL、不删除消失章节、不重排、卷条目。
- 下载状态：none / partial / complete、卷条目不参与、空缓存文件视为未缓存。
- 转本地：`source.txt` 行号与章节对齐、进度/书签保留、`raw/` 清理、失败回滚、`charCount`/`simhash` 回填。

### 13.2 main 集成测试（本地假书源服务器）

- 测试服务器绑定 `127.0.0.1`，通过 `READER_ALLOW_LOCAL_SOURCES=1` 放行。
- 完整链路：导入书源 → 搜索 → 加入书架 → 按需读章 → 断网读缓存 → 更新目录 → 下载全本 → 转本地书 → 重洗/重切。
- 故障夹具：404、500、超时、返回非 HTML、规则不匹配、JS 规则、音频书源、坏编码、超大响应、重定向循环、空正文。
- 并发与取消：搜索取消、下载取消后续传、下载中继续阅读、同一章并发只拉一次。
- 安全：`file://`、localhost/内网地址被拒（测试开关除外），JS 规则不执行。
- 数据安全：`sources.json` 损坏回滚、删除书源取消任务且不影响已缓存正文、删除网络书清理缓存。

### 13.3 离屏验收

- `READER_ACCEPTANCE=1` + 临时数据目录 + 本地假书源服务器。
- CDP 驱动 UI：导入书源、优质池搜索、全量搜索按钮、同名书分组、加入书架、读缓存/未缓存、更新、下载全本、转本地书、书源删除、联网开关。
- 不打开可见窗口、不触碰真实 `data/`。

### 13.4 手工清单

在 [regression-checklist.md](../regression-checklist.md) 增加：

- 导入真实书源 JSON（文件/粘贴/链接）。
- 优质池搜索、全量搜索、同名书展开其他来源。
- 断网读缓存、未缓存章节提示。
- 更新目录、下载全本、取消、失败重试。
- 转本地书后重洗/重切/合并。
- 删除书源后已缓存章节仍可读。
- 关闭「允许联网」后网络入口的提示。

### 13.5 真实站点

- 自动化测试一律不访问真实站点。
- 只用用户手头的书源做手工冒烟；不在仓库中提交真实书源或抓取内容。

## 14. 风险与对策

| 风险 | 对策 |
|---|---|
| 站点改版导致书源失效 | 兼容状态 + 最近失败原因；一个书源失败不影响其他结果；用户可换源/换书源。 |
| 反爬、登录、验证码 | 明确提示 403/429；不做绕过；用户可以换书源或换来源。 |
| 只支持规则子集 | 导入时标记 partial 并列出原因；相关操作失败、其他操作可用；后续再加 JS/XPath。 |
| 搜索 30 个书源仍慢 | 并发 6、单源 10 秒超时、流式结果、可取消；优质池默认 30 个。 |
| 冷启动评分不准 | 初始按兼容状态 + customOrder/导入顺序；跑一次全量后所有来源都有真实数据。 |
| 下载全本耗时长/占空间 | 用户显式触发；进度、取消、失败重试；正文为纯文本，占用可控；删书时清理。 |
| 网络书与书源更新冲突 | 转本地书前确认；转本地后不再更新，语义清晰。 |
| 依赖增加 | 只引入纯 JS 的 HTML/JSONPath 解析库；不引入 JS 执行引擎；锁定版本。 |
| 恶意或错误正则拖慢主进程 | 单页正文/HTML 大小设上限，避免在超大文本上跑复杂正则；记录慢规则；后续把规则求值移入 worker 并加超时。 |
| 版权与合规 | 不内置、不推荐书源；导入界面说明用户自行负责；不绕过 DRM/登录。 |
| 本地书回归 | 本地书路径不改；现有测试保持绿色；网络书走独立分支。 |

## 15. 路线图更新

- **P2**：AI 辅助理解正式取消；网络书源作为 P2 唯一内容，按本规格实施。
- **P3**：TTS 听书、其他格式不变。
- **产品定位**：从「无任何联网功能」调整为「本地书完全离线；网络功能由用户主动触发，并提供总开关」。

## 16. 参考

- 「阅读」书源 URL 参数（`URL,{options}`、POST、charset、headers）：<https://hapelee.github.io/legado-with-MD3/dev/url-options.html>
- 「阅读」搜索规则与模板变量：<https://docs.readori.com/guide/search>
- Legado 3.0 书源字段与规则语法：<https://blog.gitcode.com/62301f8de5804db8564474392ec908be.html>
- 阅读 3.0 规则说明：<https://celeter.github.io/>
- Legado 书源制作提示：<https://docs.legadoteam.org/prompt/booksource.html>

> 兼容实现以「阅读」3.0 的字段语义为准；本规格只承诺第 5 节列出的子集，超出部分在导入时标记为「部分支持」。
