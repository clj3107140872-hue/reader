# 书架批量操作与卡片信息 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让书架支持卡片悬停完整信息、多选与批量删除/重洗/重切、手动判断合并，并清理重复的核心工具。

**Architecture:** `Library.tsx` 持有全部选择/悬停/批量状态，复用现有单本 IPC 顺序执行；主进程新增只读的 `findMerges` 判断接口。两个纯函数（分段、章节定位）下沉到 `src/core`，不改变任何磁盘数据格式。

**Tech Stack:** Electron 45、React 19、TypeScript strict、electron-vite、Vitest

**Spec:** `docs/superpowers/specs/2026-11-02-library-batch-design.md`

## Global Constraints

- 不改变 `library.json`、`meta.json`、书稿文件格式，不做数据迁移。
- 不新增运行时依赖。
- 批量删除/重洗/重切不新增批量 IPC：渲染层逐本调用现有 `removeBook` / `recleanBook` / `resplitBook`。
- 新增的唯一 IPC 是 `library:find-merges`，只读，不写库。
- 所有失败提示为中文；未知 Node 错误统一映射为「操作失败，请稍后重试」。
- 选择模式：Esc 退出并清空选择；离开书架页清空；排序切换不清空。
- 悬停浮层延迟 350ms 显示，移出或滚动立即隐藏；选择模式下不显示。
- 分支名不含 `/`；Conventional Commits；未经确认不 push。
- 测试只测关键行为；渲染层无组件测试设施，以 `typecheck` + 离屏验收覆盖。
- 验收必须使用 `READER_ACCEPTANCE=1` 与临时 `PORTABLE_EXECUTABLE_DIR`，绝不触碰仓库 `data/`，不得打开可见窗口。

## Review Focus

- 鼠标快速划过卡片（停留 <350ms）时不应弹出浮层，也不应留下定时器让浮层在移出后出现；由 Task 8 验收步骤 6 覆盖。
- 进入选择模式时仍显示着浮层、或正拖拽文件悬停：浮层应立即消失，拖拽导入应被忽略；由 Task 8 验收步骤 7–8 覆盖。
- `findMerges` 遇到选中的书数据目录缺失：跳过该书并返回 warnings，其余候选仍正常返回；由 Task 2 的「skips a book whose files are missing」用例覆盖。
- 合并队列中某本书已被前一对合并掉：该对应跳过、计入汇总，而不是抛错中断队列；由 Task 6 的 `libraryList` 预检与 Task 8 手工抽查覆盖。
- 批量操作中某本书已从磁盘消失：其余书继续处理，汇总里列出失败书名与原因；由 Task 5 的逐本 try/catch 与 Task 8 验收步骤 12 覆盖。

---

## File Structure

**新建**

- `src/core/paragraphs.ts` — 统一的章节文本分段
- `src/core/position.ts` — 按标题哈希定位章节索引
- `src/renderer/src/errors.ts` — 失败提示文案归一化
- `src/renderer/src/components/BookInfo.tsx` — 书目信息列表（悬停与来源弹窗共用）
- `src/renderer/src/components/HoverCard.tsx` — 固定定位、自动避让的浮层容器
- `tests/paragraphs.test.ts` — 分段函数用例
- `docs/superpowers/acceptance/2026-11-02-reader-batch.md` — 验收记录

**修改**

- `src/main/storage/book.ts`、`src/main/services/search.ts`、`src/renderer/src/pages/Reader.tsx` — 改用 `splitParagraphs`
- `src/renderer/src/reader/position.ts`、`src/main/services/merge.ts` — 改用核心 `resolveChapterIndex`
- `src/shared/api.ts`、`src/preload/index.ts`、`src/main/index.ts` — `findMerges` 类型与 IPC
- `src/main/services/library.ts` — `findMerges` 实现
- `src/renderer/src/pages/Library.tsx`、`src/renderer/src/components/BookCard.tsx`、`src/renderer/src/styles.css` — 悬停、选择、批量、合并队列
- `tests/library-service.test.ts`、`tests/position.test.ts` — 新增用例

---

### Task 1: 下沉分段与章节定位工具

**Files:**
- Create: `src/core/paragraphs.ts`
- Create: `src/core/position.ts`
- Create: `tests/paragraphs.test.ts`
- Modify: `src/main/storage/book.ts:90-95`
- Modify: `src/main/services/search.ts:33-37`
- Modify: `src/renderer/src/pages/Reader.tsx:39-44`
- Modify: `src/renderer/src/reader/position.ts:89-101`
- Modify: `src/main/services/merge.ts:33-46,48-64`
- Test: `tests/position.test.ts`

**Interfaces:**
- Consumes: `ChapterMeta`、`BookMeta`（`src/core/model.ts`，已存在）
- Produces:
  - `splitParagraphs(text: string): string[]`
  - `resolveChapterIndex(chapters: ChapterMeta[], chapterKey: string, fallback: number): number`

- [ ] **Step 1: 写分段函数的失败测试**

创建 `tests/paragraphs.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { splitParagraphs } from '../src/core/paragraphs'

describe('splitParagraphs', () => {
  it('splits on blank lines and trims each paragraph', () => {
    expect(splitParagraphs('第一段\n\n  第二段  \n\n\n第三段')).toEqual([
      '第一段',
      '第二段',
      '第三段'
    ])
  })

  it('returns an empty list for blank text', () => {
    expect(splitParagraphs('\n\n  \n')).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/paragraphs.test.ts`

Expected: FAIL，报错 `Failed to resolve import "../src/core/paragraphs"`。

- [ ] **Step 3: 创建 `src/core/paragraphs.ts`**

```ts
/** Split a chapter's stored text into trimmed, non-empty paragraphs. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/paragraphs.test.ts`

Expected: PASS，2 passed。

- [ ] **Step 5: 写章节定位的失败测试**

在 `tests/position.test.ts` 顶部加入导入：

```ts
import { resolveChapterIndex as resolveCoreChapterIndex } from '../src/core/position'
```

在文件末尾追加：

```ts
describe('core chapter lookup', () => {
  const chapters = [
    { index: 0, title: '第一章', level: 'chapter' as const, titleHash: 'same', startLine: 0, charCount: 1, simhash: '1', flags: {} },
    { index: 1, title: '第二章', level: 'chapter' as const, titleHash: 'other', startLine: 1, charCount: 1, simhash: '2', flags: {} },
    { index: 2, title: '第一章', level: 'chapter' as const, titleHash: 'same', startLine: 2, charCount: 1, simhash: '3', flags: {} }
  ]

  it('matches the occurrence of the title hash nearest the fallback', () => {
    expect(resolveCoreChapterIndex(chapters, 'same', 0)).toBe(0)
    expect(resolveCoreChapterIndex(chapters, 'same', 2)).toBe(2)
    expect(resolveCoreChapterIndex(chapters, 'same', 1)).toBe(0)
  })

  it('clamps the fallback when the key is gone', () => {
    expect(resolveCoreChapterIndex(chapters, 'missing', 9)).toBe(2)
    expect(resolveCoreChapterIndex(chapters, 'missing', -1)).toBe(0)
    expect(resolveCoreChapterIndex([], 'missing', 3)).toBe(0)
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/position.test.ts`

Expected: FAIL，报错 `Failed to resolve import "../src/core/position"`。

- [ ] **Step 7: 创建 `src/core/position.ts`**

```ts
import type { ChapterMeta } from './model'

/**
 * Resolve a saved chapter key to an index. When the title hash occurs more
 * than once, prefer the occurrence nearest the remembered index.
 */
export function resolveChapterIndex(
  chapters: ChapterMeta[],
  chapterKey: string,
  fallback: number
): number {
  if (chapters.length === 0) return 0
  const matches: number[] = []
  chapters.forEach((chapter, index) => {
    if (chapter.titleHash === chapterKey) matches.push(index)
  })
  if (matches.length > 0) {
    return matches.reduce((best, index) =>
      Math.abs(index - fallback) < Math.abs(best - fallback) ? index : best
    )
  }
  return Math.min(Math.max(fallback, 0), chapters.length - 1)
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run tests/position.test.ts`

Expected: PASS，全部用例通过。

- [ ] **Step 9: 替换三处分段实现**

`src/main/storage/book.ts`：在文件顶部导入区加入

```ts
import { splitParagraphs } from '../../core/paragraphs'
```

把 `readBook` 中的

```ts
        paragraphs: text
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
```

替换为

```ts
        paragraphs: splitParagraphs(text)
```

`src/main/services/search.ts`：在文件顶部加入

```ts
import { splitParagraphs } from '../../core/paragraphs'
```

把

```ts
      const paragraphs = text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)
```

替换为

```ts
      const paragraphs = splitParagraphs(text)
```

`src/renderer/src/pages/Reader.tsx`：删除本地函数

```ts
function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}
```

并在文件顶部导入区加入

```ts
import { splitParagraphs } from '../../../core/paragraphs'
```

- [ ] **Step 10: 让渲染层与合并服务复用核心章节定位**

`src/renderer/src/reader/position.ts`：在顶部加入

```ts
import { resolveChapterIndex as resolveCoreChapterIndex } from '../../../core/position'
```

把文件末尾的 `resolveChapterIndex` 整个函数

```ts
export function resolveChapterIndex(meta: BookMeta, chapterKey: string, fallback: number): number {
  if (meta.chapters.length === 0) return 0
  const matches: number[] = []
  meta.chapters.forEach((chapter, index) => {
    if (chapter.titleHash === chapterKey) matches.push(index)
  })
  if (matches.length > 0) {
    return matches.reduce((best, index) =>
      Math.abs(index - fallback) < Math.abs(best - fallback) ? index : best
    )
  }
  return Math.min(Math.max(fallback, 0), meta.chapters.length - 1)
}
```

替换为

```ts
export function resolveChapterIndex(meta: BookMeta, chapterKey: string, fallback: number): number {
  return resolveCoreChapterIndex(meta.chapters, chapterKey, fallback)
}
```

`src/main/services/merge.ts`：把导入区改为

```ts
import type {
  Bookmark,
  BookMeta,
  BookProgress,
  ChapterMeta,
  ImportStats,
  LibraryEntry
} from '../../core/model'
import { resolveChapterIndex } from '../../core/position'
```

（`ChapterMeta` 仍用于 `remapBookmark` / `remapProgress` 的参数类型，保留。）

删除注释与整个本地函数

```ts
/** Same rule as resolveChapterIndex in the reader: nearest chapter by title hash. */
function remapChapterIndex(chapters: ChapterMeta[], chapterKey: string, fallback: number): number {
  if (chapters.length === 0) return 0
  const matches: number[] = []
  chapters.forEach((chapter, index) => {
    if (chapter.titleHash === chapterKey) matches.push(index)
  })
  if (matches.length > 0) {
    return matches.reduce((best, index) =>
      Math.abs(index - fallback) < Math.abs(best - fallback) ? index : best
    )
  }
  return Math.min(Math.max(fallback, 0), chapters.length - 1)
}
```

把 `remapBookmark` 与 `remapProgress` 中的

```ts
    chapterIndex: remapChapterIndex(chapters, bookmark.chapterKey, bookmark.chapterIndex)
```

替换为

```ts
    chapterIndex: resolveChapterIndex(chapters, bookmark.chapterKey, bookmark.chapterIndex)
```

以及

```ts
    chapterIndex: remapChapterIndex(chapters, progress.chapterKey, progress.chapterIndex)
```

替换为

```ts
    chapterIndex: resolveChapterIndex(chapters, progress.chapterKey, progress.chapterIndex)
```

- [ ] **Step 11: 运行全量测试与类型检查**

Run: `npm test`

Expected: PASS，22 个测试文件全部通过。

Run: `npm run typecheck`

Expected: 无输出错误。

- [ ] **Step 12: 提交**

```bash
git add src/core/paragraphs.ts src/core/position.ts tests/paragraphs.test.ts tests/position.test.ts src/main/storage/book.ts src/main/services/search.ts src/main/services/merge.ts src/renderer/src/pages/Reader.tsx src/renderer/src/reader/position.ts
git commit -m "refactor(core): Share paragraph and chapter lookup" -m "The paragraph splitter and chapter-key lookup existed in three
places. Move both into src/core so the reader, search, merge and
storage layers use one implementation.

无关联工单"
```

---

### Task 2: 主进程 findMerges 判断接口

**Files:**
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/services/library.ts`
- Modify: `src/main/index.ts`
- Test: `tests/library-service.test.ts`

**Interfaces:**
- Consumes: `chapterMatchRate`（`src/core/sameBook.ts`，已存在）、`LibraryRepository.list()`、`BookRepository.readMeta(id)`
- Produces:
  - `interface MergeCandidate { targetId: string; targetTitle: string; sourceId: string; sourceTitle: string; overlap: number }`
  - `interface FindMergesResult { candidates: MergeCandidate[]; warnings: string[] }`
  - `LibraryService.findMerges(ids: string[]): Promise<FindMergesResult>`
  - `window.api.findMerges(ids: string[]): Promise<FindMergesResult>`

- [ ] **Step 1: 写 findMerges 的失败测试**

在 `tests/library-service.test.ts` 的 `seed` 函数之后加入辅助函数：

```ts
function chapterMetas(id: string, count: number): BookMeta['chapters'] {
  return Array.from({ length: count }, (_, index) => ({
    index,
    title: `第${index + 1}章`,
    level: 'chapter' as const,
    titleHash: `${id}-h${index}`,
    startLine: index,
    charCount: 3,
    simhash: '1',
    flags: {}
  }))
}

async function seedBook(
  id: string,
  title: string,
  normalizedTitle: string,
  chapterCount: number,
  importedAt: string
): Promise<void> {
  const chapters = chapterMetas(id, chapterCount)
  await books.writeBook({
    meta: { ...meta(id, title), chapters },
    sourceText: '',
    chapters: chapters.map((chapter) => ({
      title: chapter.title,
      level: chapter.level,
      startLine: chapter.startLine,
      paragraphs: [`${title}正文。`]
    }))
  })
  await library.add({
    ...entry(id, title),
    normalizedTitle,
    importedAt,
    chapterCount
  })
}
```

在 `describe('LibraryService')` 末尾追加：

```ts
  it('finds books with the same normalized title and keeps the longer one', async () => {
    await seedBook('book-1', '分卷书', '分卷书', 1, '2026-01-01T00:00:00.000Z')
    await seedBook('book-2', '分卷书', '分卷书', 3, '2026-01-02T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.warnings).toEqual([])
    expect(result.candidates).toEqual([
      {
        targetId: 'book-2',
        targetTitle: '分卷书',
        sourceId: 'book-1',
        sourceTitle: '分卷书',
        overlap: 0
      }
    ])
  })

  it('prefers the earlier import when chapter counts are equal', async () => {
    await seedBook('book-1', '同书', '同书', 2, '2026-01-02T00:00:00.000Z')
    await seedBook('book-2', '同书', '同书', 2, '2026-01-01T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.candidates[0]).toMatchObject({ targetId: 'book-2', sourceId: 'book-1' })
  })

  it('returns no candidates for unrelated books', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')
    await seedBook('book-2', '乙书', '乙书', 2, '2026-01-02T00:00:00.000Z')

    const result = await service.findMerges(['book-1', 'book-2'])

    expect(result.candidates).toEqual([])
  })

  it('returns empty candidates for fewer than two books', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')

    const result = await service.findMerges(['book-1'])

    expect(result.candidates).toEqual([])
    expect(result.warnings).toEqual([])
  })

  it('skips a book whose files are missing', async () => {
    await seedBook('book-1', '甲书', '甲书', 2, '2026-01-01T00:00:00.000Z')
    await library.add(entry('book-2', '乙书'))

    const result = await service.findMerges(['book-1', 'book-2', 'missing'])

    expect(result.candidates).toEqual([])
    expect(result.warnings).toContain('《乙书》数据缺失，已跳过')
    expect(result.warnings).toContain('有 1 本书已不在书架，已跳过')
  })
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/library-service.test.ts`

Expected: FAIL，报错 `service.findMerges is not a function`。

- [ ] **Step 3: 在共享 API 中加类型**

`src/shared/api.ts`：在 `ImportSummary` 之后加入

```ts
export interface MergeCandidate {
  targetId: string
  targetTitle: string
  sourceId: string
  sourceTitle: string
  /** Chapter overlap ratio, 0..1. */
  overlap: number
}

export interface FindMergesResult {
  candidates: MergeCandidate[]
  warnings: string[]
}
```

在 `ReaderApi` 的 `mergeBooks` 前加入

```ts
  findMerges(ids: string[]): Promise<FindMergesResult>
```

- [ ] **Step 4: 实现 LibraryService.findMerges**

把 `src/main/services/library.ts` 整体改为：

```ts
import type { BookMeta, LibraryEntry } from '../../core/model'
import { chapterMatchRate } from '../../core/sameBook'
import type { FindMergesResult, MergeCandidate } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

interface CandidateBook {
  entry: LibraryEntry
  meta: BookMeta
}

function pickDirection(a: CandidateBook, b: CandidateBook): [CandidateBook, CandidateBook] {
  const aCount = a.meta.chapters.length
  const bCount = b.meta.chapters.length
  if (aCount !== bCount) return aCount > bCount ? [a, b] : [b, a]
  const byImported = a.entry.importedAt.localeCompare(b.entry.importedAt)
  if (byImported !== 0) return byImported < 0 ? [a, b] : [b, a]
  return a.entry.id.localeCompare(b.entry.id) <= 0 ? [a, b] : [b, a]
}

export class LibraryService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async remove(id: string): Promise<void> {
    assertBookId(id)
    let removed = false
    await this.library.runExclusive(async () => {
      const entries = await this.library.list()
      if (!entries.some((entry) => entry.id === id)) return
      removed = true
      await this.library.save(entries.filter((entry) => entry.id !== id))
    })
    if (removed) await this.books.remove(id)
  }

  async findMerges(ids: string[]): Promise<FindMergesResult> {
    const unique = [...new Set(ids)]
    for (const id of unique) assertBookId(id)

    const warnings: string[] = []
    const entries = await this.library.list()
    const wanted = new Set(unique)
    const selected = new Map<string, LibraryEntry>()
    for (const entry of entries) {
      if (wanted.has(entry.id)) selected.set(entry.id, entry)
    }
    const missing = unique.filter((id) => !selected.has(id))
    if (missing.length > 0) warnings.push(`有 ${missing.length} 本书已不在书架，已跳过`)

    const books: CandidateBook[] = []
    for (const entry of selected.values()) {
      try {
        books.push({ entry, meta: await this.books.readMeta(entry.id) })
      } catch {
        warnings.push(`《${entry.title}》数据缺失，已跳过`)
      }
    }

    const candidates: MergeCandidate[] = []
    for (let i = 0; i < books.length; i++) {
      for (let j = i + 1; j < books.length; j++) {
        const a = books[i]
        const b = books[j]
        const overlap = chapterMatchRate(a.meta, b.meta)
        const sameTitle =
          Boolean(a.entry.normalizedTitle) && a.entry.normalizedTitle === b.entry.normalizedTitle
        if (!sameTitle && overlap < 0.05) continue
        const [target, source] = pickDirection(a, b)
        candidates.push({
          targetId: target.entry.id,
          targetTitle: target.entry.title,
          sourceId: source.entry.id,
          sourceTitle: source.entry.title,
          overlap
        })
      }
    }

    candidates.sort(
      (a, b) =>
        b.overlap - a.overlap ||
        a.targetId.localeCompare(b.targetId) ||
        a.sourceId.localeCompare(b.sourceId)
    )
    return { candidates, warnings }
  }
}
```

- [ ] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/library-service.test.ts`

Expected: PASS，8 passed（原有 3 条 + 新增 5 条）。

- [ ] **Step 6: 接上 IPC 与 preload**

`src/preload/index.ts`：在 `mergeBooks` 之前加入

```ts
  findMerges: (ids) => ipcRenderer.invoke('library:find-merges', ids),
```

`src/main/index.ts`：在 `library:list` 处理器之后加入

```ts
  ipcMain.handle('library:find-merges', (_event, ids: unknown) => {
    const safeIds = Array.isArray(ids)
      ? ids.filter((id): id is string => typeof id === 'string')
      : []
    return libraryService.findMerges(safeIds)
  })
```

- [ ] **Step 7: 类型检查与全量测试**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm test`

Expected: PASS，全部测试通过。

- [ ] **Step 8: 提交**

```bash
git add src/shared/api.ts src/preload/index.ts src/main/services/library.ts src/main/index.ts tests/library-service.test.ts
git commit -m "feat(library): Add findMerges for selected books" -m "Manual merge needs the same same-book rule the importer uses,
computed on demand for any selected subset.

Candidates are sorted by overlap; direction is the longer book, then
the earlier import. Missing books are skipped with warnings.

无关联工单"
```

---

### Task 3: 卡片悬停信息

**Files:**
- Create: `src/renderer/src/components/BookInfo.tsx`
- Create: `src/renderer/src/components/HoverCard.tsx`
- Modify: `src/renderer/src/components/BookCard.tsx`
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `LibraryEntry`
- Produces:
  - `<BookInfo entry={entry} />`
  - `<HoverCard anchor={{ left, right, top }}>{children}</HoverCard>`
  - `BookCardProps.onHoverStart: (entry: LibraryEntry, rect: DOMRect) => void`
  - `BookCardProps.onHoverEnd: () => void`

- [ ] **Step 1: 创建 BookInfo**

创建 `src/renderer/src/components/BookInfo.tsx`：

```tsx
import type { LibraryEntry } from '../../../core/model'

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

export default function BookInfo({ entry }: { entry: LibraryEntry }) {
  const progress = entry.lastReadAt
    ? `${entry.progressPercent}% · 最近 ${formatTime(entry.lastReadAt)}`
    : '未阅读'
  return (
    <dl className="info-list">
      <dt>书名</dt>
      <dd>{entry.title}</dd>
      <dt>源文件</dt>
      <dd>{(entry.sourceFileNames ?? [entry.sourceFileName]).join('、')}</dd>
      <dt>章节</dt>
      <dd>{entry.chapterCount} 章</dd>
      <dt>编码</dt>
      <dd>{entry.encoding}</dd>
      <dt>阅读</dt>
      <dd>{progress}</dd>
      <dt>清洗</dt>
      <dd>
        广告 {entry.stats.adLinesRemoved} 行 · 重复段 {entry.stats.duplicateParagraphsMerged} 处
      </dd>
      {entry.stats.suspectedDuplicateChapters > 0 && (
        <>
          <dt>提示</dt>
          <dd>疑似重复章节 {entry.stats.suspectedDuplicateChapters}</dd>
        </>
      )}
      <dt>导入</dt>
      <dd>{formatTime(entry.importedAt)}</dd>
    </dl>
  )
}
```

- [ ] **Step 2: 创建 HoverCard**

创建 `src/renderer/src/components/HoverCard.tsx`：

```tsx
import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface HoverCardProps {
  anchor: { left: number; right: number; top: number }
  children: ReactNode
}

export default function HoverCard({ anchor, children }: HoverCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const gap = 10
    let left = anchor.right + gap
    if (left + width > window.innerWidth - 8) left = anchor.left - width - gap
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))
    setPosition({ left, top })
  }, [anchor])

  return (
    <div
      ref={ref}
      className="hover-card"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>
  )
}
```

- [ ] **Step 3: 给卡片加悬停事件**

把 `src/renderer/src/components/BookCard.tsx` 整体改为：

```tsx
import { useRef } from 'react'
import type { LibraryEntry } from '../../../core/model'

interface BookCardProps {
  entry: LibraryEntry
  onOpen: () => void
  onMenu: (entry: LibraryEntry, x: number, y: number) => void
  onHoverStart: (entry: LibraryEntry, rect: DOMRect) => void
  onHoverEnd: () => void
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function BookCard({
  entry,
  onOpen,
  onMenu,
  onHoverStart,
  onHoverEnd
}: BookCardProps) {
  const cardRef = useRef<HTMLElement>(null)

  const hoverStart = (): void => {
    const rect = cardRef.current?.getBoundingClientRect()
    if (rect) onHoverStart(entry, rect)
  }

  return (
    <article
      ref={cardRef}
      className="card"
      onMouseEnter={hoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={hoverStart}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoverEnd()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(entry, event.clientX, event.clientY)
      }}
    >
      <button className="card-open" onClick={onOpen}>
        <div className="cover">{coverInitial(entry.title)}</div>
        <div className="meta">
          <div className="title" title={entry.title}>
            {entry.title}
          </div>
          <div className="sub">
            {entry.chapterCount} 章 · {entry.encoding}
          </div>
          <div className="sub">
            进度 {entry.progressPercent}% · 广告 {entry.stats.adLinesRemoved} 行 · 重复段{' '}
            {entry.stats.duplicateParagraphsMerged}
          </div>
          {entry.stats.suspectedDuplicateChapters > 0 && (
            <div className="sub warn">疑似重复章节 {entry.stats.suspectedDuplicateChapters}</div>
          )}
        </div>
      </button>
      <button
        className="card-more"
        aria-label={`管理《${entry.title}》`}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onMenu(entry, rect.right, rect.bottom)
        }}
      >
        ⋯
      </button>
    </article>
  )
}
```

- [ ] **Step 4: 在 Library 中接上悬停状态**

`src/renderer/src/pages/Library.tsx`：

在导入区加入

```tsx
import BookInfo from '../components/BookInfo'
import HoverCard from '../components/HoverCard'
```

删除本地 `formatTime` 函数：

```tsx
function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}
```

在 `mergeQueue` 状态之后加入

```tsx
  const [hovered, setHovered] = useState<{ entry: LibraryEntry; rect: DOMRect } | null>(null)
  const hoverTimer = useRef<number | null>(null)
```

在 `notify` 之后加入

```tsx
  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const startHover = (entry: LibraryEntry, rect: DOMRect): void => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setHovered({ entry, rect })
    }, 350)
  }

  const endHover = (): void => {
    clearHoverTimer()
    setHovered(null)
  }
```

在现有 `toast` 定时器 effect 之后加入

```tsx
  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!hovered) return
    const hide = (): void => setHovered(null)
    window.addEventListener('scroll', hide, true)
    return () => window.removeEventListener('scroll', hide, true)
  }, [hovered])
```

把 `BookCard` 的渲染改为：

```tsx
            <BookCard
              key={entry.id}
              entry={entry}
              onHoverStart={startHover}
              onHoverEnd={endHover}
              onOpen={() => {
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                endHover()
                onOpen(entry.id)
              }}
              onMenu={(target, x, y) => {
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                endHover()
                setMenu({ entry: target, ...clampMenu(x, y) })
              }}
            />
```

在网格 `</div>` 之后、`{menu && (` 之前加入：

```tsx
      {hovered && (
        <HoverCard anchor={hovered.rect}>
          <BookInfo entry={hovered.entry} />
        </HoverCard>
      )}
```

把来源信息弹窗的内容整体替换为：

```tsx
      {dialog?.kind === 'source' && (
        <Modal title="来源信息" onClose={() => setDialog(null)}>
          <BookInfo entry={dialog.entry} />
        </Modal>
      )}
```

- [ ] **Step 5: 加浮层样式**

在 `src/renderer/src/styles.css` 末尾加入：

```css
.hover-card {
  position: fixed;
  z-index: 50;
  width: 300px;
  padding: 12px 14px;
  background: #fffdf8;
  border: 1px solid #e2ddd2;
  border-radius: 8px;
  box-shadow: 0 10px 30px rgba(0, 0, 0, 0.18);
  pointer-events: none;
}
.hover-card .info-list {
  grid-template-columns: 64px 1fr;
  font-size: 12px;
}
```

- [ ] **Step 6: 类型检查与构建**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm run build`

Expected: 构建成功。

- [ ] **Step 7: 提交**

```bash
git add src/renderer/src/components/BookInfo.tsx src/renderer/src/components/HoverCard.tsx src/renderer/src/components/BookCard.tsx src/renderer/src/pages/Library.tsx src/renderer/src/styles.css
git commit -m "feat(library): Show full book info on card hover" -m "Truncated titles make similar volumes hard to tell apart. After
350ms on a card, a fixed popover shows the full title, every source
file name and the rest of the entry details.

The same BookInfo list now backs the 来源信息 dialog.

无关联工单"
```

---

### Task 4: 书架选择模式

**Files:**
- Modify: `src/renderer/src/components/BookCard.tsx`
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 3 的 `BookCard` 悬停 props
- Produces:
  - `BookCardProps.selectable?: boolean`
  - `BookCardProps.selected?: boolean`
  - `BookCardProps.onToggle?: () => void`
  - Library 内部：`selectionMode`、`selected: Set<string>`、`enterSelection`、`exitSelection`、`toggleSelected`、`toggleSelectAll`、`allSelected`

- [ ] **Step 1: 给 BookCard 加选择态**

把 `src/renderer/src/components/BookCard.tsx` 整体改为：

```tsx
import { useRef } from 'react'
import type { LibraryEntry } from '../../../core/model'

interface BookCardProps {
  entry: LibraryEntry
  onOpen: () => void
  onMenu: (entry: LibraryEntry, x: number, y: number) => void
  onHoverStart: (entry: LibraryEntry, rect: DOMRect) => void
  onHoverEnd: () => void
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function BookCard({
  entry,
  onOpen,
  onMenu,
  onHoverStart,
  onHoverEnd,
  selectable = false,
  selected = false,
  onToggle
}: BookCardProps) {
  const cardRef = useRef<HTMLElement>(null)

  const hoverStart = (): void => {
    if (selectable) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (rect) onHoverStart(entry, rect)
  }

  return (
    <article
      ref={cardRef}
      className={`card${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      onMouseEnter={hoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={hoverStart}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoverEnd()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        if (selectable) return
        onMenu(entry, event.clientX, event.clientY)
      }}
    >
      {selectable && (
        <span className="card-check" aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}
      <button
        className="card-open"
        onClick={selectable ? onToggle : onOpen}
        aria-pressed={selectable ? selected : undefined}
      >
        <div className="cover">{coverInitial(entry.title)}</div>
        <div className="meta">
          <div className="title" title={entry.title}>
            {entry.title}
          </div>
          <div className="sub">
            {entry.chapterCount} 章 · {entry.encoding}
          </div>
          <div className="sub">
            进度 {entry.progressPercent}% · 广告 {entry.stats.adLinesRemoved} 行 · 重复段{' '}
            {entry.stats.duplicateParagraphsMerged}
          </div>
          {entry.stats.suspectedDuplicateChapters > 0 && (
            <div className="sub warn">疑似重复章节 {entry.stats.suspectedDuplicateChapters}</div>
          )}
        </div>
      </button>
      {!selectable && (
        <button
          className="card-more"
          aria-label={`管理《${entry.title}》`}
          onClick={(event) => {
            event.stopPropagation()
            const rect = event.currentTarget.getBoundingClientRect()
            onMenu(entry, rect.right, rect.bottom)
          }}
        >
          ⋯
        </button>
      )}
    </article>
  )
}
```

- [ ] **Step 2: 在 Library 中加入选择状态与工具栏**

`src/renderer/src/pages/Library.tsx`：

在 `hovered` 状态之后加入

```tsx
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
```

在 `endHover` 之后加入

```tsx
  const enterSelection = (): void => {
    endHover()
    setMenu(null)
    setSelectionMode(true)
    setSelected(new Set())
  }

  const exitSelection = (): void => {
    setSelectionMode(false)
    setSelected(new Set())
  }

  const toggleSelected = (id: string): void => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id))

  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.id)))
  }
```

在现有 `menu` 的 Esc effect 之后加入：

```tsx
  useEffect(() => {
    if (!selectionMode) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      if (dialog || mergeQueue.length > 0) return
      exitSelection()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectionMode, dialog, mergeQueue.length])
```

把工具栏 JSX 整体替换为：

```tsx
      <header className="toolbar">
        <h1>{selectionMode ? `已选 ${selected.size} 本` : '我的书架'}</h1>
        <div className="toolbar-actions">
          {selectionMode ? (
            <>
              <button className="ghost" onClick={toggleSelectAll}>
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button className="ghost" onClick={exitSelection}>
                退出选择
              </button>
            </>
          ) : (
            <>
              <select
                className="sort-select"
                value={sort}
                onChange={(event) => setSort(event.target.value as SortMode)}
                aria-label="排序方式"
              >
                <option value="recent">最近阅读</option>
                <option value="imported">导入时间</option>
                <option value="title">书名</option>
              </select>
              <button onClick={() => void handleImport()} disabled={busy}>
                {busy ? '导入中…' : '导入 TXT'}
              </button>
              {entries.length > 0 && (
                <button className="ghost" onClick={enterSelection}>
                  选择
                </button>
              )}
            </>
          )}
        </div>
      </header>
```

把 `BookCard` 的 props 补上：

```tsx
              selectable={selectionMode}
              selected={selected.has(entry.id)}
              onToggle={() => toggleSelected(entry.id)}
```

在 `onMenu` 回调开头加入

```tsx
                if (selectionMode) return
```

把拖拽导入回调改为：

```tsx
  const dragging = useFileDrop((paths) => {
    if (dialog || pendingMerge || selectionMode) return
    void importPaths(paths)
  })
```

把拖拽遮罩条件改为：

```tsx
      {dragging && !dialog && !pendingMerge && !selectionMode && (
```

- [ ] **Step 3: 加选择样式**

在 `src/renderer/src/styles.css` 末尾加入：

```css
.toolbar button.ghost {
  background: transparent;
  color: #4a6741;
  border: 1px solid #d8d3c8;
}
.card-check {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  width: 20px;
  height: 20px;
  border: 1px solid #cfc9bc;
  border-radius: 4px;
  background: #fff;
  color: #fff;
  font-size: 13px;
  line-height: 18px;
  text-align: center;
}
.card.selected {
  outline: 2px solid #4a6741;
  outline-offset: -2px;
}
.card.selected .card-check {
  background: #4a6741;
  border-color: #4a6741;
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm run build`

Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/components/BookCard.tsx src/renderer/src/pages/Library.tsx src/renderer/src/styles.css
git commit -m "feat(library): Add selection mode to the shelf" -m "Selection is the entry point for batch work. Clicking a card
toggles it instead of opening, the card menu and drop import pause,
and Esc or 退出选择 clears the selection.

无关联工单"
```

---

### Task 5: 批量删除 / 重新清洗 / 重新切章

**Files:**
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 4 的 `selectionMode`、`selected`、`selectedEntries`
- Produces: 批量操作栏（重新清洗、重新切章、删除）、`runBatch(kind)`、`batch` 进度状态

- [ ] **Step 1: 加批量状态与执行函数**

`src/renderer/src/pages/Library.tsx`：

在 `SortMode` 类型之后加入

```tsx
type BatchKind = 'delete' | 'reclean' | 'resplit'

const BATCH_LABELS: Record<BatchKind, string> = {
  delete: '删除',
  reclean: '重新清洗',
  resplit: '重新切章'
}
```

在 `selectionMode` 状态之后加入

```tsx
  const [batchConfirm, setBatchConfirm] = useState<BatchKind | null>(null)
  const [batch, setBatch] = useState<{ kind: BatchKind; total: number; done: number } | null>(null)
```

在 `toggleSelectAll` 之后加入

```tsx
  const selectedEntries = entries.filter((entry) => selected.has(entry.id))

  const runBatch = async (kind: BatchKind): Promise<void> => {
    const targets = selectedEntries
    if (targets.length === 0) return
    setBatchConfirm(null)
    setActionBusy(true)
    let done = 0
    const failures: string[] = []

    for (let index = 0; index < targets.length; index++) {
      const entry = targets[index]
      setBatch({ kind, total: targets.length, done: index + 1 })
      try {
        if (kind === 'delete') await window.api.removeBook(entry.id)
        else if (kind === 'reclean') await window.api.recleanBook(entry.id)
        else await window.api.resplitBook(entry.id)
        done += 1
      } catch (reason) {
        failures.push(`《${entry.title}》：${errorText(reason)}`)
      }
    }

    setBatch(null)
    setActionBusy(false)
    if (failures.length > 0) {
      notify(
        `${BATCH_LABELS[kind]}完成 ${done} 本，失败 ${failures.length} 本：${failures.join('；')}`
      )
    } else {
      notify(`${BATCH_LABELS[kind]}完成，共 ${done} 本`)
    }
    if (kind === 'delete') exitSelection()
    await refresh()
  }
```

在 `toggleSelected` 开头加入

```tsx
    if (actionBusy) return
```

把卡片 `onOpen` 回调改为：

```tsx
              onOpen={() => {
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                if (actionBusy) return
                endHover()
                onOpen(entry.id)
              }}
```

把卡片 `onMenu` 回调改为：

```tsx
              onMenu={(target, x, y) => {
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                if (actionBusy) return
                setMenu({ entry: target, ...clampMenu(x, y) })
              }}
```

（Task 3 在这里已有 `endHover()`，保留它。）

- [ ] **Step 2: 渲染批量操作栏与进度**

在 `</header>` 之后加入：

```tsx
      {selectionMode && (
        <div className="batch-bar">
          <button
            disabled={selected.size === 0 || actionBusy}
            onClick={() => setBatchConfirm('reclean')}
          >
            重新清洗
          </button>
          <button
            disabled={selected.size === 0 || actionBusy}
            onClick={() => setBatchConfirm('resplit')}
          >
            重新切章
          </button>
          <button
            className="danger"
            disabled={selected.size === 0 || actionBusy}
            onClick={() => setBatchConfirm('delete')}
          >
            删除
          </button>
        </div>
      )}
```

在现有 `{progress && <p className="hint">{progress}</p>}` 之后加入：

```tsx
      {batch && (
        <p className="hint">
          {BATCH_LABELS[batch.kind]} 第 {batch.done}/{batch.total} 本
        </p>
      )}
```

在三个单本操作弹窗之后、最外层 `</div>` 之前加入三个确认弹窗：

```tsx
      {batchConfirm === 'delete' && (
        <Modal
          title="批量删除"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button danger"
                disabled={actionBusy}
                onClick={() => void runBatch('delete')}
              >
                删除
              </button>
            </>
          }
        >
          <p>
            将删除 {selectedEntries.length} 本书：
            {selectedEntries
              .slice(0, 3)
              .map((entry) => `《${entry.title}》`)
              .join('、')}
            {selectedEntries.length > 3 ? ' 等' : ''}。
          </p>
          <p className="modal-note">
            会移除书架记录、软件内的书籍数据和备份；你导入的原始 TXT 文件不会被删除。
          </p>
        </Modal>
      )}

      {batchConfirm === 'reclean' && (
        <Modal
          title="批量重新清洗"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void runBatch('reclean')}
              >
                重新清洗
              </button>
            </>
          }
        >
          <p>将按当前内置清洗规则重新处理选中的 {selectedEntries.length} 本书。</p>
          <p className="modal-note">原数据会自动备份，阅读进度和书签保留。</p>
        </Modal>
      )}

      {batchConfirm === 'resplit' && (
        <Modal
          title="批量重新切章"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void runBatch('resplit')}
              >
                重新切章
              </button>
            </>
          }
        >
          <p>将重新识别源文件中的章节标题并切分选中的 {selectedEntries.length} 本书。</p>
          <p className="modal-note">
            识别不到至少 3 个章节标题的书会保持原样。原数据会自动备份，阅读进度和书签保留。
          </p>
        </Modal>
      )}
```

- [ ] **Step 3: 加批量操作栏样式**

在 `src/renderer/src/styles.css` 末尾加入：

```css
.batch-bar {
  display: flex;
  gap: 8px;
  margin: 0 0 16px;
}
.batch-bar button {
  border: 1px solid #d8d3c8;
  border-radius: 6px;
  background: #fff;
  color: #2b2b2b;
  padding: 7px 14px;
  font-size: 13px;
  cursor: pointer;
}
.batch-bar button:hover:not(:disabled) {
  background: #f1ede4;
}
.batch-bar button:disabled {
  opacity: 0.55;
  cursor: default;
}
.batch-bar button.danger {
  color: #a4402f;
  border-color: #e0c4bd;
}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm run build`

Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/pages/Library.tsx src/renderer/src/styles.css
git commit -m "feat(library): Add batch delete and reprocess" -m "Selected books can now be deleted, recleaned or re-split in one
pass. The renderer runs the existing single-book APIs one by one,
reports 第 i/N 本 progress, keeps going after a failure and lists the
failed titles in the summary.

无关联工单"
```

---

### Task 6: 判断合并队列

**Files:**
- Modify: `src/renderer/src/pages/Library.tsx`

**Interfaces:**
- Consumes: Task 2 的 `window.api.findMerges(ids)`、`MergeCandidate`；Task 4 的 `selected`；现有 `window.api.mergeBooks(targetId, sourceId)`
- Produces: 批量操作栏第一项「判断合并」与逐对确认弹窗

- [ ] **Step 1: 加合并队列状态与处理函数**

`src/renderer/src/pages/Library.tsx`：

把导入行改为

```tsx
import type {
  FindMergesResult,
  ImportSummary,
  ImportSuspect,
  MergeCandidate
} from '../../../shared/api'
```

在 `SortMode` 类型之后加入

```tsx
interface MergeTally {
  merged: number
  skipped: number
  failed: number
}
```

在 `batch` 状态之后加入

```tsx
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([])
  const [mergeTally, setMergeTally] = useState<MergeTally>({ merged: 0, skipped: 0, failed: 0 })
```

在 `runBatch` 之后加入

```tsx
  const finishMerge = (remaining: MergeCandidate[], tally: MergeTally): void => {
    setMergeCandidates(remaining)
    if (remaining.length > 0) return
    notify(
      `判断合并完成：合并 ${tally.merged} 对、跳过 ${tally.skipped} 对、失败 ${tally.failed} 对`
    )
    setMergeTally({ merged: 0, skipped: 0, failed: 0 })
    void refresh()
  }

  const findMerges = async (): Promise<void> => {
    if (selected.size < 2) {
      notify('请至少勾选 2 本书')
      return
    }
    setActionBusy(true)
    try {
      const result: FindMergesResult = await window.api.findMerges([...selected])
      if (result.warnings.length > 0) notify(result.warnings.join('；'))
      if (result.candidates.length === 0) {
        if (result.warnings.length === 0) notify('没有发现可能是同一本书的候选')
        return
      }
      setMergeTally({ merged: 0, skipped: 0, failed: 0 })
      setMergeCandidates(result.candidates)
    } catch (reason) {
      notify(`判断合并失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const skipCandidate = (): void => {
    if (mergeCandidates.length === 0) return
    const tally = { ...mergeTally, skipped: mergeTally.skipped + 1 }
    setMergeTally(tally)
    finishMerge(mergeCandidates.slice(1), tally)
  }

  const confirmCandidate = async (): Promise<void> => {
    const candidate = mergeCandidates[0]
    if (!candidate) return
    setActionBusy(true)
    try {
      const existing = new Set((await window.api.libraryList()).map((entry) => entry.id))
      if (!existing.has(candidate.targetId) || !existing.has(candidate.sourceId)) {
        notify(`《${candidate.targetTitle}》或《${candidate.sourceTitle}》已不在书架，已跳过这一对`)
        const tally = { ...mergeTally, skipped: mergeTally.skipped + 1 }
        setMergeTally(tally)
        finishMerge(mergeCandidates.slice(1), tally)
        return
      }

      await window.api.mergeBooks(candidate.targetId, candidate.sourceId)
      setSelected((current) => {
        const next = new Set(current)
        next.delete(candidate.sourceId)
        return next
      })
      const tally = { ...mergeTally, merged: mergeTally.merged + 1 }
      setMergeTally(tally)
      finishMerge(mergeCandidates.slice(1), tally)
    } catch (reason) {
      notify(`合并失败：${errorText(reason)}`)
      const tally = { ...mergeTally, failed: mergeTally.failed + 1 }
      setMergeTally(tally)
      finishMerge(mergeCandidates.slice(1), tally)
    } finally {
      setActionBusy(false)
    }
  }
```

把 `exitSelection` 改为：

```tsx
  const exitSelection = (): void => {
    setSelectionMode(false)
    setSelected(new Set())
    setMergeCandidates([])
    setMergeTally({ merged: 0, skipped: 0, failed: 0 })
  }
```

在 `selectionMode` 的 Esc effect 中把守卫改为：

```tsx
      if (dialog || mergeQueue.length > 0 || mergeCandidates.length > 0) return
```

并把 `mergeCandidates.length` 加入 effect 依赖数组：

```tsx
  }, [selectionMode, dialog, mergeQueue.length, mergeCandidates.length])
```

- [ ] **Step 2: 在批量操作栏加「判断合并」**

在 `.batch-bar` 的 `{selectionMode && (` 之后、第一个「重新清洗」按钮之前加入：

```tsx
          <button disabled={selected.size === 0 || actionBusy} onClick={() => void findMerges()}>
            判断合并
          </button>
```

- [ ] **Step 3: 渲染逐对确认弹窗**

在导入的 `{pendingMerge && (...)}` 弹窗之后加入：

```tsx
      {mergeCandidates[0] && (
        <Modal
          title="判断合并"
          onClose={skipCandidate}
          footer={
            <>
              <button className="modal-button ghost" disabled={actionBusy} onClick={skipCandidate}>
                跳过
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmCandidate()}
              >
                {actionBusy ? '合并中…' : `合并到《${mergeCandidates[0].targetTitle}》`}
              </button>
            </>
          }
        >
          <p>
            《{mergeCandidates[0].targetTitle}》 ⇄ 《{mergeCandidates[0].sourceTitle}》 · 章节重叠{' '}
            {(mergeCandidates[0].overlap * 100).toFixed(0)}%
          </p>
          <p>
            将《{mergeCandidates[0].sourceTitle}》合并到《{mergeCandidates[0].targetTitle}》。
          </p>
          <p className="modal-note">合并后会保留阅读进度和书签，并自动备份原书数据。</p>
        </Modal>
      )}
```

- [ ] **Step 4: 类型检查与构建**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm run build`

Expected: 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/pages/Library.tsx
git commit -m "feat(library): Add manual merge check queue" -m "After selecting books, 判断合并 asks the main process for candidate
pairs and confirms them one at a time. The longer book is always the
target; a pair whose books disappeared is skipped and counted.

无关联工单"
```

---

### Task 7: 统一失败提示文案

**Files:**
- Create: `src/renderer/src/errors.ts`
- Modify: `src/renderer/src/pages/Library.tsx`

**Interfaces:**
- Consumes: 无
- Produces: `errorText(reason: unknown): string`

- [ ] **Step 1: 创建 errors 模块**

创建 `src/renderer/src/errors.ts`：

```ts
const KNOWN_MESSAGES = [
  '无效的书籍编号',
  '找不到',
  '不能把一本书合并到它自己',
  '书籍数据缺失',
  '没有识别到至少 3 个章节标题',
  '重新清洗后没有可阅读的正文'
]

/**
 * Strip Electron's IPC wrapper and show only messages the app itself wrote.
 * Raw filesystem errors are replaced so users never see ENOENT/EACCES codes.
 */
export function errorText(reason: unknown): string {
  const message = (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )
  return KNOWN_MESSAGES.some((known) => message.includes(known))
    ? message
    : '操作失败，请稍后重试'
}
```

- [ ] **Step 2: 让 Library 使用它**

`src/renderer/src/pages/Library.tsx`：

在导入区加入

```tsx
import { errorText } from '../errors'
```

删除本地函数

```tsx
function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}
```

- [ ] **Step 3: 类型检查与全量测试**

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm test`

Expected: PASS，全部测试通过。

- [ ] **Step 4: 提交**

```bash
git add src/renderer/src/errors.ts src/renderer/src/pages/Library.tsx
git commit -m "refactor(library): Unify operation failure copy" -m "Known app errors stay readable after Electron's IPC prefix is
stripped; raw filesystem errors become one fixed Chinese sentence
instead of leaking ENOENT-style codes.

无关联工单"
```

---

### Task 8: 全量验证与离屏验收

**Files:**
- Create: `docs/superpowers/acceptance/2026-11-02-reader-batch.md`

**Interfaces:**
- Consumes: 前七个任务的全部功能
- Produces: 验收记录，供用户手工抽查

- [ ] **Step 1: 跑全量测试、类型检查与构建**

Run: `npm test`

Expected: PASS，22 个测试文件全部通过（预计 138 条用例）。

Run: `npm run typecheck`

Expected: 无输出错误。

Run: `npm run build`

Expected: 构建成功。

- [ ] **Step 2: 准备临时验收数据**

Run:

```bash
ACCEPT="$TEMP/reader-plan4-acceptance"
rm -rf "$ACCEPT"
mkdir -p "$ACCEPT/txt" "$ACCEPT/data-root"
printf '第一章 开端\n\n第一部分正文。\n\n第二章 相遇\n\n第二部分正文。\n\n第三章 分别\n\n第三部分正文。\n' > "$ACCEPT/txt/验收书A.txt"
printf '第一章 开端\n\n第一部分正文。\n\n第二章 相遇\n\n第二部分正文。\n\n第三章 分别\n\n第三部分正文。\n\n第四章 重聚\n\n第四部分正文。\n\n第五章 结局\n\n第五部分正文。\n' > "$ACCEPT/txt/验收书B.txt"
printf '第一章 独行\n\n另一本书的正文。\n' > "$ACCEPT/txt/验收书C.txt"
ACCEPT_WIN=$(cygpath -m "$ACCEPT")
echo "$ACCEPT_WIN"
```

Expected: 输出类似 `C:/Users/Administrator/AppData/Local/Temp/reader-plan4-acceptance`。

- [ ] **Step 3: 启动离屏应用**

Run（后台启动，日志写入临时目录）：

```bash
PORTABLE_EXECUTABLE_DIR="$ACCEPT/data-root" READER_ACCEPTANCE=1 npm run dev > "$ACCEPT/dev.log" 2>&1 &
```

等待 CDP 就绪（最多 60 秒）：

```bash
for i in $(seq 1 60); do node -e "fetch('http://127.0.0.1:9222/json/list').then(r=>r.json()).then(()=>process.exit(0)).catch(()=>process.exit(1))" && break; node -e "setTimeout(()=>{},1000)"; done
```

Expected: 循环退出，无连接错误。若 60 秒仍失败，检查 `$ACCEPT/dev.log`，不要打开可见窗口。

- [ ] **Step 4: 导入三本验收书并刷新**

Run:

```bash
node scripts/debug-eval.cjs "window.api.debugImport(['$ACCEPT_WIN/txt/验收书A.txt','$ACCEPT_WIN/txt/验收书B.txt','$ACCEPT_WIN/txt/验收书C.txt'])"
node scripts/debug-eval.cjs "location.reload()" || true
node -e "setTimeout(()=>{},2000)"
node scripts/debug-eval.cjs "document.querySelectorAll('.card').length"
```

Expected: 导入结果 `imported: 3`；刷新后卡片数为 `3`。

- [ ] **Step 5: 检查悬停浮层（含完整书名与源文件）**

Run:

```bash
node scripts/debug-eval.cjs "const card=document.querySelector('.card'); card.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); 'ok'"
node -e "setTimeout(()=>{},450)"
node scripts/debug-eval.cjs "[...document.querySelectorAll('.hover-card .info-list dd')].map((el)=>el.textContent)"
```

Expected: 返回的数组中包含完整书名（如 `验收书C`）与源文件名（如 `验收书C.txt`），且浮层存在。

- [ ] **Step 6: 检查快速划过不残留浮层**

Run:

```bash
node scripts/debug-eval.cjs "const card=document.querySelector('.card'); card.dispatchEvent(new MouseEvent('mouseout',{bubbles:true})); card.dispatchEvent(new MouseEvent('mouseover',{bubbles:true})); card.dispatchEvent(new MouseEvent('mouseout',{bubbles:true})); 'ok'"
node -e "setTimeout(()=>{},450)"
node scripts/debug-eval.cjs "document.querySelector('.hover-card') === null"
```

Expected: `true`（移出后不会延迟弹出）。

- [ ] **Step 7: 进入选择模式并确认悬停被禁用**

Run:

```bash
node scripts/debug-eval.cjs "[...document.querySelectorAll('button')].find((b)=>b.textContent==='选择').click(); 'ok'"
node -e "setTimeout(()=>{},200)"
node scripts/debug-eval.cjs "({checks: document.querySelectorAll('.card-check').length, hover: document.querySelector('.hover-card') === null, heading: document.querySelector('.toolbar h1').textContent})"
```

Expected: `checks: 3`、`hover: true`、`heading: '已选 0 本'`。

- [ ] **Step 8: 勾选两本并判断合并**

Run:

```bash
node scripts/debug-eval.cjs "['验收书A','验收书B'].forEach((title)=>{const card=[...document.querySelectorAll('.card')].find((c)=>c.querySelector('.title')?.textContent===title); card.querySelector('.card-open').click()}); 'ok'"
node scripts/debug-eval.cjs "document.querySelector('.toolbar h1').textContent"
node scripts/debug-eval.cjs "[...document.querySelectorAll('.batch-bar button')].find((b)=>b.textContent==='判断合并').click(); 'ok'"
node -e "setTimeout(()=>{},800)"
node scripts/debug-eval.cjs "({body: document.querySelector('.modal-body')?.textContent, button: document.querySelector('.modal-footer .modal-button:last-child')?.textContent})"
```

Expected: 标题为 `已选 2 本`；弹窗正文包含 `验收书A`、`验收书B`、`章节重叠 100%`；按钮文本为 `合并到《验收书B》`（B 章数多，是目标）。

- [ ] **Step 9: 执行合并并检查汇总**

Run:

```bash
node scripts/debug-eval.cjs "document.querySelector('.modal-footer .modal-button:last-child').click(); 'ok'"
node -e "setTimeout(()=>{},1500)"
node scripts/debug-eval.cjs "({cards: [...document.querySelectorAll('.title')].map((el)=>el.textContent), toast: document.querySelector('.toast')?.textContent})"
```

Expected: 卡片只剩 `验收书B` 与 `验收书C`；toast 为 `判断合并完成：合并 1 对、跳过 0 对、失败 0 对`。

- [ ] **Step 10: 批量重新清洗**

Run:

```bash
node scripts/debug-eval.cjs "[...document.querySelectorAll('button')].find((b)=>b.textContent==='全选').click(); 'ok'"
node scripts/debug-eval.cjs "[...document.querySelectorAll('.batch-bar button')].find((b)=>b.textContent==='重新清洗').click(); 'ok'"
node -e "setTimeout(()=>{},200)"
node scripts/debug-eval.cjs "document.querySelector('.modal-footer .modal-button:last-child').click(); 'ok'"
node -e "setTimeout(()=>{},2500)"
node scripts/debug-eval.cjs "({toast: document.querySelector('.toast')?.textContent, cards: document.querySelectorAll('.card').length})"
```

Expected: toast 为 `重新清洗完成，共 2 本`；卡片数仍为 `2`。

- [ ] **Step 11: 批量操作失败后继续（删除一本的目录后再重洗）**

Run:

```bash
node scripts/debug-eval.cjs "window.api.libraryList().then((list)=>{const c=list.find((e)=>e.title==='验收书C'); return window.api.removeBook(c.id)})"
node scripts/debug-eval.cjs "[...document.querySelectorAll('.batch-bar button')].find((b)=>b.textContent==='重新清洗').click(); 'ok'"
node -e "setTimeout(()=>{},200)"
node scripts/debug-eval.cjs "document.querySelector('.modal-footer .modal-button:last-child').click(); 'ok'"
node -e "setTimeout(()=>{},2500)"
node scripts/debug-eval.cjs "document.querySelector('.toast')?.textContent"
```

Expected: toast 含 `失败 1 本`、`《验收书C》`、`书籍数据缺失`，并且 `验收书B` 已处理成功（`完成 1 本`）。

- [ ] **Step 12: 批量删除并退出选择模式**

Run:

```bash
node scripts/debug-eval.cjs "[...document.querySelectorAll('.batch-bar button')].find((b)=>b.textContent==='删除').click(); 'ok'"
node -e "setTimeout(()=>{},200)"
node scripts/debug-eval.cjs "document.querySelector('.modal-footer .modal-button:last-child').click(); 'ok'"
node -e "setTimeout(()=>{},1500)"
node scripts/debug-eval.cjs "({cards: document.querySelectorAll('.card').length, empty: document.querySelector('.empty')?.textContent, heading: document.querySelector('.toolbar h1').textContent})"
```

Expected: `cards: 0`；出现「书架还是空的…」；标题回到 `我的书架`（已退出选择模式）。

- [ ] **Step 13: 关闭离屏应用**

Run:

```bash
node scripts/debug-eval.cjs "window.close(); 'ok'" || true
node -e "setTimeout(()=>{},1000)"
```

若进程仍在，`ps` 找到本任务启动的 `npm run dev` 进程树并只终止它（先核对父进程；不得终止用户的其他 Electron 窗口）。

- [ ] **Step 14: 写验收记录并提交**

创建 `docs/superpowers/acceptance/2026-11-02-reader-batch.md`，把实际结果填入：

```markdown
# Plan 4 验收记录（2026-11-02）

- 测试：`npm test` 全绿（记录实际文件数与用例数）
- 类型检查：`npm run typecheck` 通过
- 构建：`npm run build` 通过
- 离屏验收：临时数据目录 `%TEMP%/reader-plan4-acceptance`，未触碰仓库 `data/`
- 悬停：完整书名与源文件可见；快速划过不残留浮层
- 选择模式：复选框显示，悬停浮层隐藏，拖拽导入暂停
- 判断合并：A(3 章) 与 B(5 章) 识别为候选，目标为 B，合并后 A 移除
- 批量重新清洗：2 本成功；删除 C 目录后重洗，C 失败但 B 继续成功
- 批量删除：书架归零并退出选择模式
- 未自动化的 UI：拖拽导入暂停的视觉反馈、合并队列跳过计数 —— 待用户手工确认
```

提交：

```bash
git add docs/superpowers/acceptance/2026-11-02-reader-batch.md
git commit -m "docs: Record Plan 4 acceptance" -m "Offscreen acceptance covered hover info, selection mode, the
manual merge queue and batch operations; manual checks remain for
drag-pause feedback and merge-skip counts.

无关联工单"
```

---

## Self-Review

**Spec coverage**

- 卡片悬停信息：Task 3（350ms、键盘焦点、左右翻转、选择模式隐藏、完整书名/章数/编码/进度/最近阅读/清洗统计/源文件/导入时间）。
- 选择模式：Task 4（工具栏、复选框、点击切换、右键/⋯禁用、拖拽暂停、Esc 退出、全选/取消全选、排序保留、离开页面清空）。
- 判断合并：Task 2 + Task 6（规则、降序、方向、逐对确认、失败继续、已被合并的跳过、汇总）。
- 批量操作：Task 5（删除/重洗/重切、确认文案、逐本进度、失败继续、汇总、删除后退出选择、重洗后保留选择）。
- 内部整理：Task 1（分段/章节定位）、Task 7（错误文案）。
- 测试策略：Task 1 核心函数 2+2 条；Task 2 findMerges 5 条；渲染层由 Task 8 离屏验收覆盖。

**Placeholder scan**

无 TBD/TODO；每个代码步骤都给出了完整代码或完整替换片段。Task 8 的验收记录要求填入实际结果，这是验收步骤本身，不是实现占位。

**Type consistency**

- `MergeCandidate` 字段在 Task 2 定义，Task 6 直接使用 `targetId/targetTitle/sourceId/sourceTitle/overlap`。
- `BookInfo` 的 `formatTime` 与 Library 原有实现一致，Task 3 删除旧副本后无重复。
- `BookCard` 在 Task 3 增加 `onHoverStart/onHoverEnd`，Task 4 保持并新增 `selectable/selected/onToggle`；Library 两处调用最终 props 完整。
- `errorText` 在 Task 5 仍使用 Library 本地函数，Task 7 才迁移到 `../errors`；Task 5 的提交不依赖 Task 7。
- `resolveChapterIndex` 核心签名用 `ChapterMeta[]`，渲染层 wrapper 与 `MergeService` 均按此调用。

**Review Focus 覆盖**

- 快速划过：Task 8 步骤 6。
- 选择模式隐藏浮层/暂停拖拽：Task 8 步骤 7；拖拽暂停的视觉反馈列为手工抽查。
- findMerges 缺失书：Task 2 第 5 条用例。
- 合并队列跳过：Task 6 的 `libraryList` 预检 + Task 8 手工抽查。
- 批量失败继续：Task 5 逐本 try/catch + Task 8 步骤 11。
