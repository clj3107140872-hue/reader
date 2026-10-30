# 阅读器 Plan 3：书架治理与导入体验 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让书架能安全地管书——同书合并、重新清洗、重新切章、删除、查看来源，以及拖拽导入、大文件确认和导入阶段提示。

**Architecture:** 存储层用进程内互斥锁把 `library.json` 的读改写串行化；新增 `MergeService` 读取两本书、调用已有的 `planMerge`、用 `buildBookDocuments` 重建书名/章节/源文本，写入时自动备份并保留进度书签；新增 `ReprocessService` 按保存的行号重洗、按标题重新切章；新增 `ImportQueue` 统一批量导入、大文件确认和阶段事件；渲染层用卡片右键菜单、统一 `Modal`、合并提示和拖拽遮罩承接这些能力。

**Tech Stack:** TypeScript strict、React 19、Electron 45、electron-vite、Vitest；运行时仅 `iconv-lite`，不新增依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-pc-reader-design.md`

## Global Constraints

- 严格 TypeScript；UI 文案用中文，错误信息必须可直接给用户看，不出现 Electron 原始 IPC 前缀。
- 数据目录只通过 `resolveDataDir()` 解析；单元测试一律用 `mkdtemp` 临时目录；自动化验收用 `PORTABLE_EXECUTABLE_DIR` 指向临时目录并加 `READER_ACCEPTANCE=1`，绝不读写仓库下真实的 `data/`。
- `debug:import` 只存在于开发构建；打包构建不得注册该 IPC。本计划不改变这个边界。
- 书稿重写只能走 `BookRepository.writeBook`（原子写入 + 自动备份）；不得直接写 `meta.json`/章节文件。
- `library.json` 新增字段一律可选，旧数据不带这些字段也必须能正常列出、打开、删除。
- 合并、删除、重洗、重切只从书架页发起；阅读页不提供这些入口。
- 每个任务结束必须跑 `npm run typecheck` 和对应测试；提交信息遵守 Conventional Commits，标题 ≤50 字符，正文每行 ≤72 字符；**不 push**，是否合并由用户决定。
- 分支名不含 `/`：`dev-reader-library`，基线 `main`（Plan 3 开始时为 `7e08aa4`）。

## Review Focus

1. **合并的数据保全**：两卷合并后必须保留目标书的阅读进度和书签，源书章节不能丢失，删除源书只能发生在目标书写入成功之后；旧数据要备份。由 Task 2 的 `merge-service` 测试覆盖。
2. **合并后源文本与行号一致**：合并书重新生成的 `source.txt`、`startLine`、章节正文必须互相对齐，之后的重洗/重切不能把章节打乱。由 Task 1/2 的 compose 测试与 Task 5 的 reprocess 测试覆盖。
3. **书架并发写**：导入、保存进度、合并、删除同时发生时不丢条目、不把已删除的书“复活”。由 Task 1 的并发测试覆盖。
4. **导入确认与坏输入**：超过 50MB 的文件在自动化验收里不能卡在原生对话框；用户拒绝时必须跳过并报告；拖入非 TXT、文件夹或路径失效时不能崩溃或误报成功。由 Task 7 的 `import-queue` 测试覆盖，取消对话框由手工清单覆盖。
5. **重洗/重切的安全阀**：规则把正文清空时必须中止且不覆盖原书；识别不到章节标题时保持原样；两种情况都要保留进度/书签。由 Task 5 的 `reprocess-service` 测试覆盖。

---

## 范围与后续

本计划承接 Plan 2 的遗留清单中**书架治理与导入体验**部分：

| 规格章节 | 本计划任务 |
|---|---|
| §6.5 跨章重复段落（>50 字）在同书合并时去重 | Task 2 |
| §6.6 同书合并、备份、保留进度/书签 | Task 2、Task 4 |
| §7 导入 >50MB 确认、疑似同书、拖拽、阶段、取消文案 | Task 4、Task 7 |
| §7 重新清洗、重新切章（自动） | Task 5、Task 6 |
| §8 书架右键：查看来源、删除 | Task 3 |
| §9 IPC：`library:remove`、`import:resolve`、`book:reclean`、`book:resplit` | Task 2、3、5、7 |
| §10 错误文案 | Task 3、Task 7 |
| §11 测试 | 每个任务 |
| §6.7 手动标记重切、来源行浏览 | **Plan 4** |
| §6.5 用户自定义规则编辑器、红绿预览 | **Plan 4** |
| §7 编码预览/手动选择 | **Plan 4** |
| §12 打包、`library.json` 自检、单实例、CSP、日志、窗口校验 | **Plan 4** |

## 实现裁决

1. **导入后合并，不引入“暂存导入”**：沿用现有流程，导入完成后用疑似列表提示，用户选择合并或保留两本。规格 §6.6 的②「作为新书导入」与③「取消」在此合并为一个「先不合并」——书已经导入成功，“取消”由用户手动删除；要真正丢弃新书需要再弹一次删除确认，不值得在一个合并对话框里做。代价：拒绝合并时书架里会留下第二本，用户可手动删除。
2. **合并书重建 `source.txt`；重洗/重切保留原 `source.txt`**：两卷合并没有唯一的原始源文件，必须由合并后的章节重建；重洗/重切要依赖原始行号，因此保留源文本并用 `startLine` 定位。代价：合并书的“来源”是清洗后的合并文本，原始文件只能从目标书备份或用户磁盘上找回。
3. **合并后的书名取目标源文件名去掉分卷/噪音后的展示名**（`displayBookTitle`，保留大小写和空格，如《斗罗大陆》《Harry Potter》），匹配仍用 `normalizedTitle`；并把两本书的文件名和哈希都记在条目里。代价：书名会从“斗罗大陆_1-50章”变成“斗罗大陆”。
4. **`LibraryRepository` 自带进程内互斥锁**；跨书籍文件的合并/重洗/重切也持有该锁。代价：这些慢操作会短暂阻塞进度保存；跨进程保护留给 Plan 4 的单实例锁。
5. **先移除书架记录，再删书籍目录；合并时先写目标书，最后删源书**。代价：极端崩溃可能留下孤儿目录（无害），但不会留下指向缺失目录的书架条目。
6. **书签在服务端按 `chapterKey + paragraphIndex` 去重**。代价：同一段不能收藏两条书签。
7. **合并统计是两本相加的近似值**：`adLinesRemoved`、`duplicateParagraphsMerged` 直接相加，重叠章节会重复计数，再加上本次跨章去重实际移除的段数；只作展示，不参与逻辑。
8. **条目新增可选字段 `fileHashes?: string[]`、`sourceFileNames?: string[]`**，旧数据兼容。代价：旧版本程序忽略这些字段，在旧版本里重新导入已合并的分卷会被当成新书。
9. **手动标记重切延后到 Plan 4**：当前自动切章已覆盖用户现有书；手动标记是独立的虚拟列表 + 正则批量标记子系统。代价：自动切错的 1-2 章书暂时只能等后续计划。
10. **50MB 阈值按 `50 * 1024 * 1024`，严格大于才确认**；没有可用对话框时默认拒绝。
11. **`debugImport` 走同一条导入队列**：自动验收模式下大文件确认自动通过；调试入口现在也会过滤非 TXT。代价：验收脚本只能用 `.txt` 夹具。
12. **合并要求两本书都存在且可读**，不做部分合并。代价：损坏的书必须先删除或修复。
13. **重洗保留原源文本，统计只反映本次清洗**；重复重洗会得到相同计数。代价：来源视图里仍能看到原广告行。
14. **重切在识别不到至少 3 个章节标题时拒绝执行**，返回提示而不写盘。代价：两章书无法自动重切（等手动标记）。
15. **重叠章节只按“清洗后字数更长”保留，不比较广告命中数**：规格 §6.6 要求“字数更多、广告命中更少”，但 `ChapterMeta` 没有逐章广告计数；为一次合并在数据模型里加逐章统计不划算。代价：同一章两版广告量不同时，可能留下字数更多但广告也更多的一版；用户可对它单独「重新清洗」。

## 文件结构

- 新增 `src/main/storage/mutex.ts`：串行化异步临界区。
- 新增 `src/main/bookId.ts`：书籍编号校验（从 `services/bookId.ts` 移出，供存储层复用）。
- 新增 `src/core/compose.ts`：由章节重建 `meta` 与 `sourceText`，或保留现有源文本只重建元数据。
- 新增 `src/core/reprocess.ts`：按 `meta.chapters.startLine` 从源文本还原章节段落。
- 新增 `src/main/services/merge.ts`：同书合并执行。
- 新增 `src/main/services/library.ts`：删除书籍。
- 新增 `src/main/services/reprocess.ts`：重新清洗、重新切章。
- 新增 `src/main/services/importQueue.ts`：批量导入、大小确认、阶段事件、疑似来源标记。
- 新增 `src/renderer/src/components/Modal.tsx`：通用对话框。
- 新增 `src/renderer/src/components/BookCard.tsx`：书架卡片与右键入口。
- 新增 `src/renderer/src/hooks/useFileDrop.ts`：窗口级拖拽导入。
- 修改 `src/core/model.ts`：条目来源哈希/文件名。
- 修改 `src/core/dedupe.ts`：合并时跨章去重长段落。
- 修改 `src/main/storage/library.ts`：互斥、按任意哈希查找。
- 修改 `src/main/storage/book.ts`：整本读取、删除目录。
- 修改 `src/main/services/import.ts`：阶段回调、条目来源字段。
- 修改 `src/main/services/reader.ts`：书签去重。
- 修改 `src/core/cleaning.ts`：补广告短句。
- 修改 `src/main/index.ts`：新 IPC 与导入队列。
- 修改 `src/shared/api.ts`、`src/preload/index.ts`：新 API。
- 修改 `src/renderer/src/pages/Library.tsx`、`src/renderer/src/styles.css`：书架交互。
- 测试：`tests/storage.test.ts`、`tests/import-service.test.ts`、`tests/reader-service.test.ts`、`tests/cleaning.test.ts`、`tests/dedupe.test.ts`、`tests/sameBook.test.ts`，新增 `tests/compose.test.ts`、`tests/merge-service.test.ts`、`tests/library-service.test.ts`、`tests/reprocess.test.ts`、`tests/reprocess-service.test.ts`、`tests/import-queue.test.ts`。

---

### Task 0: 提交已批准的计划

**Files:**
- Commit: `docs/superpowers/plans/2026-10-30-reader-library.md`

**Interfaces:**
- Produces: 基线分支上已跟踪的计划文件，供后续 worktree 直接读取。

- [ ] **Step 1: 确认工作树只包含计划文件**

Run: `git status --short`

Expected: 只有 `?? docs/superpowers/plans/2026-10-30-reader-library.md`；如果还有别的未提交文件，先停下来问用户。

- [ ] **Step 2: 在创建 worktree 之前提交计划**

这一步由主会话在 `using-git-worktrees` 之前执行，确保 worktree 从包含计划文件的基线创建：

```bash
git add docs/superpowers/plans/2026-10-30-reader-library.md
git commit -m "docs: Add Plan 3 implementation plan" -m "Record the library governance and import plan before execution
so the implementation worktree carries the same plan file."
```

Expected: `git status --short` 为空；`git log -1 --oneline` 显示该 commit。

---

### Task 1: 存储层互斥、来源字段与删除

**Files:**
- Create: `src/main/storage/mutex.ts`
- Create: `src/main/bookId.ts`（从 `src/main/services/bookId.ts` 移出）
- Delete: `src/main/services/bookId.ts`
- Modify: `src/main/services/reader.ts:6`
- Modify: `src/main/services/search.ts:3`
- Modify: `src/main/storage/library.ts`
- Modify: `src/main/storage/book.ts`
- Modify: `src/core/model.ts:36-48`
- Modify: `src/main/services/import.ts:44-56`
- Test: `tests/storage.test.ts`
- Test: `tests/import-service.test.ts`

**Interfaces:**
- Produces:
  - `class Mutex { runExclusive<T>(task: () => Promise<T>): Promise<T> }`
  - `LibraryRepository.runExclusive<T>(task: () => Promise<T>): Promise<T>`
  - `LibraryEntry.fileHashes?: string[]`、`LibraryEntry.sourceFileNames?: string[]`
  - `BookRepository.readBook(id: string): Promise<BookFiles>`
  - `BookRepository.remove(id: string): Promise<void>`
  - `assertBookId(id: unknown): void`（从 `src/main/bookId.ts` 导入）

- [ ] **Step 1: 写并发写入的失败测试**

在 `tests/storage.test.ts` 的 `describe('LibraryRepository')` 里加：

```ts
it('serializes concurrent additions without losing entries', async () => {
  const library = new LibraryRepository(root)
  await Promise.all(
    Array.from({ length: 8 }, (_, index) => library.add(entry(`book-${index}`, `书${index}`)))
  )
  expect((await library.list()).map((item) => item.id).sort()).toEqual(
    Array.from({ length: 8 }, (_, index) => `book-${index}`).sort()
  )
})

it('finds a book by any of its merged source hashes', async () => {
  const library = new LibraryRepository(root)
  await library.add({ ...entry('a', '甲书'), fileHashes: ['hash-a', 'hash-b'] })
  expect((await library.findByFileHash('hash-b'))?.id).toBe('a')
})
```

在 `describe('BookRepository')` 里加：

```ts
it('removes a book directory', async () => {
  const books = new BookRepository(root)
  await books.writeBook({
    meta: meta('book-3'),
    sourceText: '第一章\n第一段。\n第二章\n第二段。',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
    ]
  })
  await books.remove('book-3')
  await expect(books.readMeta('book-3')).rejects.toThrow('书籍数据缺失')
})

it('reads a whole book back for merge and reprocess', async () => {
  const books = new BookRepository(root)
  await books.writeBook({
    meta: meta('book-4'),
    sourceText: '第一章\n第一段。\n第二章\n第二段。',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
    ]
  })

  const files = await books.readBook('book-4')
  expect(files.chapters.map((chapter) => chapter.paragraphs)).toEqual([['第一段。'], ['第二段。']])
  expect(files.sourceText).toContain('第一章')
})
```

在 `tests/import-service.test.ts` 的第一条用例里补：

```ts
expect(outcome.entry.fileHashes).toEqual([expect.any(String)])
expect(outcome.entry.sourceFileNames).toEqual(['斗罗大陆_1-50章.txt'])
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage.test.ts tests/import-service.test.ts`

Expected: FAIL —— 并发用例只保留 1 个条目；`fileHashes`/`sourceFileNames` 为 `undefined`；`books.remove`、`books.readBook` 不是函数。

- [ ] **Step 3: 新增 `Mutex`**

`src/main/storage/mutex.ts`：

```ts
/**
 * Serializes async critical sections. Tasks run in call order; a failed task
 * does not block the next one.
 */
export class Mutex {
  private tail: Promise<unknown> = Promise.resolve()

  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.tail.then(task, task)
    this.tail = run.catch(() => undefined)
    return run
  }
}
```

- [ ] **Step 4: 移动书籍编号校验并加类型检查**

删除 `src/main/services/bookId.ts`，新建 `src/main/bookId.ts`：

```ts
export function assertBookId(id: unknown): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error('无效的书籍编号')
  }
}
```

把 `src/main/services/reader.ts` 和 `src/main/services/search.ts` 的导入改成：

```ts
import { assertBookId } from '../bookId'
```

- [ ] **Step 5: 给书架仓库加互斥**

`src/main/storage/library.ts` 改成：

```ts
import { join } from 'node:path'
import type { LibraryEntry } from '../../core/model'
import { atomicWriteJson, readJson } from './fsUtil'
import { Mutex } from './mutex'

interface LibraryFile {
  version: 1
  entries: LibraryEntry[]
}

export class LibraryRepository {
  private readonly mutex = new Mutex()

  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'library.json')
  }

  async list(): Promise<LibraryEntry[]> {
    const main = await readJson<LibraryFile>(this.file)
    if (main?.entries) return main.entries
    const backup = await readJson<LibraryFile>(`${this.file}.bak`)
    return backup?.entries ?? []
  }

  /** Runs a read-modify-write against the library without interleaving. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(task)
  }

  /** Only call while holding runExclusive (repository mutations do this). */
  async save(entries: LibraryEntry[]): Promise<void> {
    await atomicWriteJson(this.file, { version: 1, entries })
  }

  async add(entry: LibraryEntry): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.list()
      if (entries.some((existing) => existing.id === entry.id)) return
      entries.push(entry)
      await this.save(entries)
    })
  }

  async update(id: string, patch: Partial<LibraryEntry>): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.list()
      const index = entries.findIndex((entry) => entry.id === id)
      if (index < 0) return
      entries[index] = { ...entries[index], ...patch }
      await this.save(entries)
    })
  }

  async remove(id: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.save((await this.list()).filter((entry) => entry.id !== id))
    })
  }

  async findByFileHash(fileHash: string): Promise<LibraryEntry | null> {
    const entries = await this.list()
    return (
      entries.find(
        (entry) => entry.fileHash === fileHash || entry.fileHashes?.includes(fileHash)
      ) ?? null
    )
  }
}
```

- [ ] **Step 6: 扩展条目类型**

`src/core/model.ts` 的 `LibraryEntry` 里，在 `fileHash` 后加：

```ts
  /** Every source file represented by this entry; set when volumes are merged. */
  fileHashes?: string[]
```

在 `sourceFileName` 后加：

```ts
  /** Every original file name; set when volumes are merged. */
  sourceFileNames?: string[]
```

- [ ] **Step 7: 导入时记录来源字段**

`src/main/services/import.ts` 的 `entry` 对象里，`fileHash` 后加：

```ts
      fileHashes: [fileHash],
```

`sourceFileName` 后加：

```ts
      sourceFileNames: [fileName],
```

- [ ] **Step 8: 给书籍仓库加整本读取与删除**

`src/main/storage/book.ts` 顶部：

```ts
import { assertBookId } from '../bookId'
```

在 `readSource` 后加：

```ts
  async readBook(id: string): Promise<BookFiles> {
    const meta = await this.readMeta(id)
    const chapters: CleanedChapter[] = []
    for (const chapter of meta.chapters) {
      const text = await this.readChapter(id, chapter.index)
      chapters.push({
        title: chapter.title,
        level: chapter.level,
        startLine: chapter.startLine,
        paragraphs: text
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
      })
    }
    return { meta, sourceText: await this.readSource(id), chapters }
  }
```

在 `writeProgress` 后加：

```ts
  async remove(id: string): Promise<void> {
    assertBookId(id)
    await fs.rm(this.bookDir(id), { recursive: true, force: true })
    await fs.rm(join(this.booksDir(), `.tmp-${id}`), { recursive: true, force: true })
  }
```

- [ ] **Step 9: 运行测试确认通过**

Run: `npx vitest run tests/storage.test.ts tests/import-service.test.ts tests/reader-service.test.ts tests/search-service.test.ts`

Expected: PASS（全绿）。

- [ ] **Step 10: 类型检查**

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 11: 提交**

```bash
git add src/main/storage/mutex.ts src/main/bookId.ts src/main/storage/library.ts src/main/storage/book.ts src/core/model.ts src/main/services/import.ts src/main/services/reader.ts src/main/services/search.ts tests/storage.test.ts tests/import-service.test.ts
git commit -m "feat(storage): Serialize library writes" -m "Concurrent imports could overwrite each other because every
mutation read and rewrote library.json without a lock. Merge and
delete also need one critical section across book files and the
library index.

- Add an in-process mutex to LibraryRepository
- Track every source hash and file name for merged books
- Add whole-book reading and directory removal to BookRepository
- Reject non-string or malformed book ids"
```

---

### Task 2: 合并文档与合并服务

**Files:**
- Create: `src/core/compose.ts`
- Create: `src/main/services/merge.ts`
- Modify: `src/core/sameBook.ts`
- Modify: `src/core/dedupe.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Test: `tests/compose.test.ts`
- Test: `tests/sameBook.test.ts`
- Test: `tests/dedupe.test.ts`
- Test: `tests/merge-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `LibraryEntry.fileHashes/sourceFileNames`、`LibraryRepository.runExclusive`、`BookRepository.readBook/remove`、`assertBookId`。
- Produces:
  - `buildBookDocuments(input: BookDocumentsInput): BookDocuments`
  - `displayBookTitle(fileName: string): string`
  - `dedupeCrossChapterParagraphs(chapters: CleanedChapter[]): ParagraphDedupeResult`（`{ chapters; removed }`）
  - `class MergeService { constructor(library, books); merge(targetId: string, sourceId: string): Promise<MergeResult> }`
  - `MergeResult { targetId; title; chapterCount; removedId; warning? }`
  - `ReaderApi.mergeBooks(targetId, sourceId): Promise<MergeResult>`
  - IPC `import:resolve`

- [ ] **Step 1: 写合并文档的失败测试**

新建 `tests/compose.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { splitChapters } from '../src/core/chapters'
import { buildBookDocuments } from '../src/core/compose'

describe('buildBookDocuments', () => {
  it('rebuilds source text and line numbers from merged chapters', () => {
    const documents = buildBookDocuments({
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      createdAt: '2026-01-01T00:00:00.000Z',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 99, paragraphs: ['第一段。', '第二段。'] },
        { title: '第二章', level: 'chapter', startLine: 99, paragraphs: ['第三段。'] },
        { title: '第三章', level: 'chapter', startLine: 99, paragraphs: ['第四段。'] }
      ]
    })

    expect(documents.chapters.map((chapter) => chapter.startLine)).toEqual([0, 5, 8])
    expect(documents.sourceText.split('\n').filter(Boolean)).toEqual([
      '第一章',
      '第一段。',
      '第二段。',
      '第二章',
      '第三段。',
      '第三章',
      '第四段。'
    ])
    expect(documents.meta.chapters.map((chapter) => chapter.title)).toEqual([
      '第一章',
      '第二章',
      '第三章'
    ])

    const resplit = splitChapters(documents.sourceText)
    expect(resplit.detected).toBe(true)
    expect(resplit.chapters.map((chapter) => [chapter.title, chapter.paragraphs])).toEqual([
      ['第一章', ['第一段。', '第二段。']],
      ['第二章', ['第三段。']],
      ['第三章', ['第四段。']]
    ])
  })

  it('keeps an existing source and its chapter line numbers', () => {
    const documents = buildBookDocuments({
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceText: '第一章\n原文。\n第二章\n更多。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['原文。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['更多。'] }
      ]
    })

    expect(documents.sourceText).toBe('第一章\n原文。\n第二章\n更多。')
    expect(documents.chapters.map((chapter) => chapter.startLine)).toEqual([0, 2])
    expect(documents.meta.chapters.map((chapter) => chapter.startLine)).toEqual([0, 2])
  })
})
```

在 `tests/sameBook.test.ts` 的现有 import 中加入 `displayBookTitle`，并在文件末尾追加：

```ts
describe('displayBookTitle', () => {
  it('keeps display casing and spaces when stripping volume suffixes', () => {
    expect(displayBookTitle('Harry Potter 1-3章.txt')).toBe('Harry Potter')
    expect(displayBookTitle('测试书_1-3章.txt')).toBe('测试书')
  })
})
```

在 `tests/dedupe.test.ts` 的 import 里加 `dedupeCrossChapterParagraphs`，并在文件末尾追加：

```ts
const longDuplicate =
  '这是一段超过五十个字的重复正文，用来验证同书合并时跨章节的完全相同段落只保留一次，避免分卷重叠造成重复阅读。'
const shortDuplicate = '短句。'

describe('dedupeCrossChapterParagraphs', () => {
  it('keeps only the first copy of a long paragraph repeated across chapters', () => {
    const result = dedupeCrossChapterParagraphs([
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: [longDuplicate, '第一章正文。'] },
      { title: '第二章', level: 'chapter', startLine: 3, paragraphs: [longDuplicate, '第二章正文。'] }
    ])
    expect(result.chapters[1].paragraphs).toEqual(['第二章正文。'])
    expect(result.removed).toBe(1)
  })

  it('leaves short repeated paragraphs alone', () => {
    const result = dedupeCrossChapterParagraphs([
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: [shortDuplicate] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: [shortDuplicate] }
    ])
    expect(result.chapters[1].paragraphs).toEqual([shortDuplicate])
    expect(result.removed).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/compose.test.ts tests/sameBook.test.ts tests/dedupe.test.ts`

Expected: FAIL —— `compose` 模块不存在，`displayBookTitle` 与 `dedupeCrossChapterParagraphs` 未导出。

- [ ] **Step 3: 实现 `buildBookDocuments`**

`src/core/compose.ts`：

```ts
import type { BookMeta, CleanedChapter } from './model'
import { buildChapterMetas } from './pipeline'

export interface BookDocumentsInput {
  id: string
  title: string
  encoding: string
  createdAt: string
  chapters: CleanedChapter[]
  /** Keep an existing source file; otherwise rebuild it from the chapters. */
  sourceText?: string
}

export interface BookDocuments {
  meta: BookMeta
  sourceText: string
  chapters: CleanedChapter[]
}

export function buildBookDocuments(input: BookDocumentsInput): BookDocuments {
  const chapters =
    input.sourceText === undefined
      ? assignLines(input.chapters)
      : input.chapters

  return {
    meta: {
      version: 1,
      id: input.id,
      title: input.title,
      encoding: input.encoding,
      chapters: buildChapterMetas(chapters),
      createdAt: input.createdAt
    },
    sourceText: input.sourceText ?? serializeChapters(chapters),
    chapters
  }
}

function assignLines(chapters: CleanedChapter[]): CleanedChapter[] {
  let line = 0
  return chapters.map((chapter) => {
    const startLine = line
    line += 1
    for (const paragraph of chapter.paragraphs) {
      line += 2
    }
    return { ...chapter, startLine }
  })
}

function serializeChapters(chapters: CleanedChapter[]): string {
  const lines: string[] = []
  for (const chapter of chapters) {
    lines.push(chapter.title)
    for (const paragraph of chapter.paragraphs) {
      lines.push(paragraph, '')
    }
  }
  return lines.join('\n')
}
```

在 `src/core/sameBook.ts` 的 `normalizeBookTitle` 后加：

```ts
/** Strips volume ranges and quality noise for display, keeping case and spaces. */
export function displayBookTitle(fileName: string): string {
  let title = toHalfWidth(fileName.replace(/\.txt$/i, ''))
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, '')
  return (
    title
      .replace(/[_-—]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || fileName.replace(/\.txt$/i, '')
  )
}
```

`src/core/dedupe.ts` 顶部加 `import type { CleanedChapter } from './model'`，并把 `./text` 的导入改成：

```ts
import { hammingBig, normalizeForHash, toBig } from './text'
```

在文件末尾追加：

```ts
export interface ParagraphDedupeResult {
  chapters: CleanedChapter[]
  removed: number
}

/**
 * Removes cross-chapter duplicates of paragraphs longer than 50 characters,
 * keeping the first copy. Only used when merging two volumes.
 */
export function dedupeCrossChapterParagraphs(chapters: CleanedChapter[]): ParagraphDedupeResult {
  const seen = new Set<string>()
  let removed = 0
  const deduped = chapters.map((chapter) => ({
    ...chapter,
    paragraphs: chapter.paragraphs.filter((paragraph) => {
      if (paragraph.length <= 50) return true
      const key = normalizeForHash(paragraph)
      if (!key) return true
      if (seen.has(key)) {
        removed += 1
        return false
      }
      seen.add(key)
      return true
    })
  }))
  return { chapters: deduped, removed }
}
```

- [ ] **Step 4: 运行 compose、书名与跨章去重测试**

Run: `npx vitest run tests/compose.test.ts tests/sameBook.test.ts tests/dedupe.test.ts`

Expected: PASS。

- [ ] **Step 5: 写合并服务的失败测试**

新建 `tests/merge-service.test.ts`：

```ts
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { LibraryEntry } from '../src/core/model'
import { splitChapters } from '../src/core/chapters'
import { parseBookFile } from '../src/core/pipeline'
import { normalizeBookTitle } from '../src/core/sameBook'
import { MergeService } from '../src/main/services/merge'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: MergeService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-merge-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new MergeService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function volumeText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(
      `第${i}章 风起`,
      `第${i}章正文第一段。`,
      `第${i}章正文第二段。`,
      ''
    )
  }
  return lines.join('\n')
}

async function importVolume(
  id: string,
  fileName: string,
  from: number,
  to: number
): Promise<LibraryEntry> {
  const parsed = parseBookFile(Buffer.from(volumeText(from, to), 'utf8'), fileName, {
    id,
    now: '2026-01-01T00:00:00.000Z'
  })
  await books.writeBook({
    meta: parsed.meta,
    sourceText: parsed.sourceText,
    chapters: parsed.chapters
  })
  const entry: LibraryEntry = {
    id,
    title: parsed.title,
    normalizedTitle: normalizeBookTitle(fileName),
    sourceFileName: fileName,
    fileHash: `hash-${id}`,
    fileHashes: [`hash-${id}`],
    sourceFileNames: [fileName],
    encoding: parsed.encoding,
    importedAt: parsed.meta.createdAt,
    lastReadAt: null,
    chapterCount: parsed.meta.chapters.length,
    progressPercent: 0,
    stats: parsed.stats
  }
  await library.add(entry)
  return entry
}

describe('MergeService', () => {
  it('merges two volumes into one book and deletes the source', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)

    const result = await service.merge('a', 'b')

    expect(result).toMatchObject({
      targetId: 'a',
      title: '测试书',
      chapterCount: 6,
      removedId: 'b'
    })
    const meta = await books.readMeta('a')
    expect(meta.title).toBe('测试书')
    expect(meta.chapters.map((chapter) => chapter.title)).toEqual([
      '第1章 风起',
      '第2章 风起',
      '第3章 风起',
      '第4章 风起',
      '第5章 风起',
      '第6章 风起'
    ])

    const entries = await library.list()
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ id: 'a', title: '测试书', chapterCount: 6 })
    expect(entries[0].fileHashes).toEqual(['hash-a', 'hash-b'])
    expect(entries[0].sourceFileNames).toEqual(['测试书_1-3章.txt', '测试书_4-6章.txt'])
    expect(await library.findByFileHash('hash-b')).not.toBeNull()

    await expect(books.readMeta('b')).rejects.toThrow('书籍数据缺失')
  })

  it('keeps the rebuilt source aligned with the merged chapters', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)
    await service.merge('a', 'b')

    const source = await books.readSource('a')
    const split = splitChapters(source)
    expect(split.detected).toBe(true)
    expect(split.chapters.map((chapter) => chapter.title)).toEqual([
      '第1章 风起',
      '第2章 风起',
      '第3章 风起',
      '第4章 风起',
      '第5章 风起',
      '第6章 风起'
    ])
    expect(split.chapters[5].paragraphs).toEqual(['第6章正文第一段。', '第6章正文第二段。'])
  })

  it('keeps target progress and merges source bookmarks', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)

    const targetBook = await books.readBook('a')
    const targetKey = targetBook.meta.chapters[0].titleHash
    await books.writeProgress('a', {
      progress: {
        chapterKey: targetKey,
        chapterIndex: 0,
        paragraphIndex: 1,
        percent: 17,
        updatedAt: '2026-01-02T00:00:00.000Z'
      },
      bookmarks: [
        {
          id: 'mark-a',
          chapterKey: targetKey,
          chapterIndex: 0,
          paragraphIndex: 1,
          excerpt: '第一段',
          createdAt: '2026-01-02T00:00:00.000Z'
        }
      ]
    })

    const sourceBook = await books.readBook('b')
    const sourceKey = sourceBook.meta.chapters[0].titleHash
    await books.writeProgress('b', {
      progress: null,
      bookmarks: [
        {
          id: 'mark-b',
          chapterKey: sourceKey,
          chapterIndex: 0,
          paragraphIndex: 0,
          excerpt: '第四段',
          createdAt: '2026-01-03T00:00:00.000Z'
        }
      ]
    })

    await service.merge('a', 'b')

    const stored = await books.readProgress('a')
    expect(stored.progress?.percent).toBe(17)
    expect(stored.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mark-a', 'mark-b'])
  })

  it('deduplicates overlapping chapters from the source', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_1-3章.txt', 1, 3)

    const result = await service.merge('a', 'b')
    expect(result.chapterCount).toBe(3)
  })

  it('backs up the target before rewriting', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)
    await importVolume('b', '测试书_4-6章.txt', 4, 6)
    await service.merge('a', 'b')

    const backups = await readdir(join(root, 'books', 'a', 'backup'))
    expect(backups).toHaveLength(1)
  })

  it('leaves both books alone when the source is missing', async () => {
    await importVolume('a', '测试书_1-3章.txt', 1, 3)

    await expect(service.merge('a', 'missing')).rejects.toThrow('找不到要合并的书')
    expect(await library.list()).toHaveLength(1)
    expect((await books.readMeta('a')).chapters).toHaveLength(3)
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/merge-service.test.ts tests/storage.test.ts`

Expected: FAIL with "Cannot find module '../src/main/services/merge'"。

- [ ] **Step 7: 实现合并服务**

`src/main/services/merge.ts`：

```ts
import type { Bookmark, BookMeta, ImportStats, LibraryEntry } from '../../core/model'
import { buildBookDocuments } from '../../core/compose'
import { dedupeCrossChapterParagraphs } from '../../core/dedupe'
import { displayBookTitle, planMerge } from '../../core/sameBook'
import type { MergeResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

function bookmarkKey(bookmark: Bookmark): string {
  return `${bookmark.chapterKey}:${bookmark.paragraphIndex}`
}

function mergeBookmarks(target: Bookmark[], source: Bookmark[]): Bookmark[] {
  const seen = new Set(target.map(bookmarkKey))
  const merged = [...target]
  for (const bookmark of source) {
    const key = bookmarkKey(bookmark)
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(bookmark)
  }
  return merged
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))]
}

function mergedFileHashes(target: LibraryEntry, source: LibraryEntry): string[] {
  return unique([
    target.fileHash,
    ...(target.fileHashes ?? []),
    source.fileHash,
    ...(source.fileHashes ?? [])
  ])
}

function mergedFileNames(target: LibraryEntry, source: LibraryEntry): string[] {
  return unique([
    target.sourceFileName,
    ...(target.sourceFileNames ?? []),
    source.sourceFileName,
    ...(source.sourceFileNames ?? [])
  ])
}

function mergedStats(
  target: LibraryEntry,
  source: LibraryEntry,
  chapters: BookMeta['chapters'],
  crossChapterRemoved: number
): ImportStats {
  return {
    adLinesRemoved: target.stats.adLinesRemoved + source.stats.adLinesRemoved,
    duplicateParagraphsMerged:
      target.stats.duplicateParagraphsMerged +
      source.stats.duplicateParagraphsMerged +
      crossChapterRemoved,
    suspectedDuplicateChapters: chapters.filter((chapter) => chapter.flags.suspectedDuplicate).length
  }
}

export class MergeService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async merge(targetId: string, sourceId: string): Promise<MergeResult> {
    assertBookId(targetId)
    assertBookId(sourceId)
    if (targetId === sourceId) throw new Error('不能把一本书合并到它自己')

    return this.library.runExclusive(async () => {
      const entries = await this.library.list()
      const target = entries.find((entry) => entry.id === targetId)
      if (!target) throw new Error('找不到要合并到的书，可能已被删除')
      const source = entries.find((entry) => entry.id === sourceId)
      if (!source) throw new Error('找不到要合并的书，可能已被删除')

      const targetBook = await this.books.readBook(targetId)
      const sourceBook = await this.books.readBook(sourceId)
      const title = displayBookTitle(target.sourceFileName) || target.title
      const merged = dedupeCrossChapterParagraphs(
        planMerge(
          { meta: targetBook.meta, chapters: targetBook.chapters },
          { meta: sourceBook.meta, chapters: sourceBook.chapters }
        )
      )
      const documents = buildBookDocuments({
        id: targetId,
        title,
        encoding: targetBook.meta.encoding,
        createdAt: targetBook.meta.createdAt,
        chapters: merged.chapters
      })

      const targetProgress = await this.books.readProgress(targetId)
      const sourceProgress = await this.books.readProgress(sourceId)
      const progress = targetProgress.progress ?? sourceProgress.progress
      const bookmarks = mergeBookmarks(targetProgress.bookmarks, sourceProgress.bookmarks)

      await this.books.writeBook(documents)
      await this.books.writeProgress(targetId, { progress, bookmarks })

      const nextEntries = entries
        .filter((entry) => entry.id !== sourceId)
        .map((entry) =>
          entry.id === targetId
            ? {
                ...entry,
                title,
                chapterCount: documents.meta.chapters.length,
                fileHashes: mergedFileHashes(target, source),
                sourceFileNames: mergedFileNames(target, source),
                stats: mergedStats(target, source, documents.meta.chapters, merged.removed)
              }
            : entry
        )
      await this.library.save(nextEntries)

      let warning: string | undefined
      try {
        await this.books.remove(sourceId)
      } catch {
        warning = '合并已完成，但旧书文件没有删除干净'
      }

      return {
        targetId,
        title,
        chapterCount: documents.meta.chapters.length,
        removedId: sourceId,
        warning
      }
    })
  }
}
```

- [ ] **Step 8: 声明 API 类型与 IPC**

`src/shared/api.ts` 在 `OpenBookPayload` 前加：

```ts
export interface MergeResult {
  targetId: string
  title: string
  chapterCount: number
  removedId: string
  warning?: string
}
```

在 `ReaderApi` 里加：

```ts
  mergeBooks(targetId: string, sourceId: string): Promise<MergeResult>
```

`src/preload/index.ts` 的 `api` 对象里加：

```ts
  mergeBooks: (targetId, sourceId) => ipcRenderer.invoke('import:resolve', targetId, sourceId),
```

`src/main/index.ts`：

```ts
import { MergeService } from './services/merge'
```

在 `const search = new SearchService(books)` 后加：

```ts
const merger = new MergeService(library, books)
```

在 `bookmark:remove` handler 后加：

```ts
  ipcMain.handle('import:resolve', (_event, targetId: string, sourceId: string) =>
    merger.merge(targetId, sourceId)
  )
```

- [ ] **Step 9: 运行测试与类型检查**

Run: `npx vitest run tests/compose.test.ts tests/sameBook.test.ts tests/dedupe.test.ts tests/merge-service.test.ts tests/storage.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 10: 提交**

```bash
git add src/core/compose.ts src/core/sameBook.ts src/core/dedupe.ts src/main/services/merge.ts src/shared/api.ts src/preload/index.ts src/main/index.ts tests/compose.test.ts tests/sameBook.test.ts tests/dedupe.test.ts tests/merge-service.test.ts
git commit -m "feat(merge): Merge book volumes with backup" -m "Volumes imported separately stay as two books. Merging needs one
coherent book file, a preserved reading position, and a rollback
point.

- Rebuild source text and chapter line numbers from merged chapters
- Keep target progress and append non-duplicate source bookmarks
- Deduplicate long paragraphs repeated across merged chapters
- Record every source hash and file name on the merged entry
- Remove the source book only after the target is written"
```

---

### Task 3: 书架卡片菜单、删除与来源信息

**Files:**
- Create: `src/main/services/library.ts`
- Create: `src/renderer/src/components/Modal.tsx`
- Create: `src/renderer/src/components/BookCard.tsx`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/library-service.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `BookRepository.remove`、`assertBookId`、`LibraryRepository.runExclusive`。
- Produces:
  - `class LibraryService { constructor(library, books); remove(id: string): Promise<void> }`
  - `ReaderApi.removeBook(id: string): Promise<void>`
  - IPC `library:remove`
  - `Modal` 组件：`{ title, children, footer?, onClose }`
  - `BookCard` 组件：`{ entry, onOpen, onMenu(entry, x, y) }`

- [ ] **Step 1: 写删除服务的失败测试**

新建 `tests/library-service.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BookMeta, LibraryEntry } from '../src/core/model'
import { LibraryService } from '../src/main/services/library'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: LibraryService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-library-service-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new LibraryService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function meta(id: string, title: string): BookMeta {
  return {
    version: 1,
    id,
    title,
    encoding: 'utf8',
    chapters: [
      {
        index: 0,
        title: '第一章',
        level: 'chapter',
        titleHash: `${id}-hash`,
        startLine: 0,
        charCount: 3,
        simhash: '1',
        flags: {}
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function entry(id: string, title: string): LibraryEntry {
  return {
    id,
    title,
    normalizedTitle: title,
    sourceFileName: `${title}.txt`,
    fileHash: `hash-${id}`,
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount: 1,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

async function seed(id: string, title: string): Promise<void> {
  await books.writeBook({
    meta: meta(id, title),
    sourceText: `第一章\n${title}正文。`,
    chapters: [{ title: '第一章', level: 'chapter', startLine: 0, paragraphs: [`${title}正文。`] }]
  })
  await library.add(entry(id, title))
}

describe('LibraryService', () => {
  it('removes the entry and the book files', async () => {
    await seed('book-1', '甲书')

    await service.remove('book-1')

    expect(await library.list()).toEqual([])
    await expect(books.readMeta('book-1')).rejects.toThrow('书籍数据缺失')
  })

  it('keeps other books and ignores an unknown id', async () => {
    await seed('book-1', '甲书')
    await seed('book-2', '乙书')

    await service.remove('missing')
    expect((await library.list()).map((item) => item.id)).toEqual(['book-1', 'book-2'])

    await service.remove('book-1')
    expect((await library.list()).map((item) => item.id)).toEqual(['book-2'])
    expect((await books.readMeta('book-2')).title).toBe('乙书')
  })

  it('rejects an invalid id', async () => {
    await expect(service.remove('../escape')).rejects.toThrow('无效的书籍编号')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/library-service.test.ts`

Expected: FAIL with "Cannot find module '../src/main/services/library'"。

- [ ] **Step 3: 实现删除服务**

`src/main/services/library.ts`：

```ts
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

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
}
```

- [ ] **Step 4: 运行删除服务测试**

Run: `npx vitest run tests/library-service.test.ts`

Expected: PASS。

- [ ] **Step 5: 暴露删除 API**

`src/shared/api.ts` 的 `ReaderApi` 里加：

```ts
  removeBook(id: string): Promise<void>
```

`src/preload/index.ts` 里加：

```ts
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
```

`src/main/index.ts` 里导入：

```ts
import { LibraryService } from './services/library'
```

在 `const merger = ...` 后加：

```ts
const libraryService = new LibraryService(library, books)
```

在 `import:resolve` handler 后加：

```ts
  ipcMain.handle('library:remove', (_event, id: string) => libraryService.remove(id))
```

- [ ] **Step 6: 通用对话框**

`src/renderer/src/components/Modal.tsx`：

```tsx
import { useEffect } from 'react'
import type { ReactNode } from 'react'

interface ModalProps {
  title: string
  children: ReactNode
  footer?: ReactNode
  onClose: () => void
}

export default function Modal({ title, children, footer, onClose }: ModalProps) {
  useEffect(() => {
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      onClose()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [onClose])

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <header className="modal-header">
          <h2>{title}</h2>
          <button className="drawer-close" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </header>
        <div className="modal-body">{children}</div>
        {footer && <footer className="modal-footer">{footer}</footer>}
      </div>
    </div>
  )
}
```

- [ ] **Step 7: 书架卡片组件**

`src/renderer/src/components/BookCard.tsx`：

```tsx
import type { LibraryEntry } from '../../../core/model'

interface BookCardProps {
  entry: LibraryEntry
  onOpen: () => void
  onMenu: (entry: LibraryEntry, x: number, y: number) => void
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function BookCard({ entry, onOpen, onMenu }: BookCardProps) {
  return (
    <article
      className="card"
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

- [ ] **Step 8: 重写书架页（删除与来源）**

用以下完整内容替换 `src/renderer/src/pages/Library.tsx`：

```tsx
import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'
import BookCard from '../components/BookCard'
import Modal from '../components/Modal'

type SortMode = 'recent' | 'imported' | 'title'

type Dialog =
  | { kind: 'source'; entry: LibraryEntry }
  | { kind: 'delete'; entry: LibraryEntry }

const SORTERS: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
  recent: (a, b) => (b.lastReadAt ?? b.importedAt).localeCompare(a.lastReadAt ?? a.importedAt),
  imported: (a, b) => b.importedAt.localeCompare(a.importedAt),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function clampMenu(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 168)),
    y: Math.max(8, Math.min(y, window.innerHeight - 196))
  }
}

export default function Library({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ entry: LibraryEntry; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const notify = (text: string): void => setToast({ id: Date.now(), text })

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName}`)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    if (!menu) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [menu])

  const handleImport = async (): Promise<void> => {
    setBusy(true)
    setProgress('')
    try {
      const summary = await window.api.chooseAndImport()
      const parts: string[] = []
      if (summary.imported > 0) parts.push(`成功导入 ${summary.imported} 本`)
      if (summary.duplicates.length > 0) parts.push(`已在书库：${summary.duplicates.join('、')}`)
      if (summary.suspects.length > 0) {
        parts.push(
          `疑似同一本书（暂未合并）：${summary.suspects
            .map((item) => `${item.title}，内容重叠 ${(item.overlap * 100).toFixed(0)}%`)
            .join('；')}`
        )
      }
      if (summary.errors.length > 0) parts.push(`失败：${summary.errors.join('；')}`)
      if (summary.warnings.length > 0) parts.push(`提示：${summary.warnings.join('；')}`)
      notify(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
      await refresh()
    } catch (reason) {
      notify(`导入失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const confirmDelete = async (entry: LibraryEntry): Promise<void> => {
    setActionBusy(true)
    try {
      await window.api.removeBook(entry.id)
      setDialog(null)
      notify(`已删除《${entry.title}》`)
      await refresh()
    } catch (reason) {
      notify(`删除失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const sorted = [...entries].sort(SORTERS[sort])

  return (
    <div className="app">
      <header className="toolbar">
        <h1>我的书架</h1>
        <div className="toolbar-actions">
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
        </div>
      </header>

      {progress && <p className="hint">{progress}</p>}
      {toast && (
        <div className="toast" role="status">
          {toast.text}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="empty">书架还是空的，点击右上角「导入 TXT」开始阅读。</p>
      ) : (
        <div className="grid">
          {sorted.map((entry) => (
            <BookCard
              key={entry.id}
              entry={entry}
              onOpen={() => onOpen(entry.id)}
              onMenu={(target, x, y) => setMenu({ entry: target, ...clampMenu(x, y) })}
            />
          ))}
        </div>
      )}

      {menu && (
        <>
          <div className="card-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="card-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              onClick={() => {
                setDialog({ kind: 'source', entry: menu.entry })
                setMenu(null)
              }}
            >
              查看来源
            </button>
            <button
              className="danger"
              onClick={() => {
                setDialog({ kind: 'delete', entry: menu.entry })
                setMenu(null)
              }}
            >
              删除
            </button>
          </div>
        </>
      )}

      {dialog?.kind === 'source' && (
        <Modal title="来源信息" onClose={() => setDialog(null)}>
          <dl className="info-list">
            <dt>书名</dt>
            <dd>{dialog.entry.title}</dd>
            <dt>源文件</dt>
            <dd>{(dialog.entry.sourceFileNames ?? [dialog.entry.sourceFileName]).join('、')}</dd>
            <dt>编码</dt>
            <dd>{dialog.entry.encoding}</dd>
            <dt>导入时间</dt>
            <dd>{formatTime(dialog.entry.importedAt)}</dd>
            <dt>章节</dt>
            <dd>{dialog.entry.chapterCount} 章</dd>
            <dt>清洗</dt>
            <dd>
              广告 {dialog.entry.stats.adLinesRemoved} 行 · 合并重复段{' '}
              {dialog.entry.stats.duplicateParagraphsMerged} 处
            </dd>
          </dl>
        </Modal>
      )}

      {dialog?.kind === 'delete' && (
        <Modal
          title="删除书籍"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button danger"
                disabled={actionBusy}
                onClick={() => void confirmDelete(dialog.entry)}
              >
                {actionBusy ? '删除中…' : '删除'}
              </button>
            </>
          }
        >
          <p>确定删除《{dialog.entry.title}》吗？</p>
          <p className="modal-note">
            会移除书架记录和软件内的书籍数据；你导入的原始 TXT 文件不会被删除。
          </p>
        </Modal>
      )}
    </div>
  )
}
```

- [ ] **Step 9: 替换卡片与新增对话框样式**

在 `src/renderer/src/styles.css` 中，把现有的两段 `.card` 规则（约 33-40 行与 92-100 行）整体替换为：

```css
.card {
  position: relative;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
  overflow: hidden;
}
.card-open {
  display: flex;
  gap: 12px;
  width: 100%;
  padding: 12px 34px 12px 12px;
  border: none;
  background: transparent;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
}
.card-open:focus-visible { outline: 2px solid #4a6741; outline-offset: -2px; }
.card:hover { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); }
.card-more {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 26px;
  height: 26px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.88);
  color: #6b6b6b;
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
  opacity: 0;
}
.card:hover .card-more,
.card:focus-within .card-more,
.card-more:focus { opacity: 1; }
.card-more:hover { background: #eee9dd; }
.card-menu-backdrop { position: fixed; inset: 0; z-index: 60; }
.card-menu {
  position: fixed;
  z-index: 61;
  min-width: 140px;
  padding: 4px;
  background: #fff;
  border: 1px solid #e2ddd2;
  border-radius: 8px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.18);
  display: flex;
  flex-direction: column;
}
.card-menu button {
  border: none;
  background: transparent;
  text-align: left;
  padding: 8px 12px;
  border-radius: 5px;
  font-size: 13px;
  color: #2b2b2b;
  cursor: pointer;
}
.card-menu button:hover { background: #f1ede4; }
.card-menu button.danger { color: #a4402f; }
```

在文件末尾追加：

```css
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 90;
  background: rgba(20, 20, 20, 0.42);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
}
.modal {
  width: min(520px, 100%);
  max-height: calc(100vh - 48px);
  overflow: auto;
  background: #fffdf8;
  color: #2b2b2b;
  border-radius: 10px;
  box-shadow: 0 18px 60px rgba(0, 0, 0, 0.28);
}
.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #e2ddd2;
}
.modal-header h2 { margin: 0; font-size: 16px; }
.modal .drawer-close { color: #6b6b6b; }
.modal-body { padding: 16px 18px; font-size: 14px; line-height: 1.65; }
.modal-body p { margin: 0 0 10px; }
.modal-note { color: #6b6b6b; font-size: 12px; }
.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  padding: 12px 18px;
  border-top: 1px solid #e2ddd2;
}
.modal-button {
  border: none;
  border-radius: 6px;
  padding: 8px 16px;
  font-size: 13px;
  cursor: pointer;
  background: #4a6741;
  color: #fff;
}
.modal-button.ghost { background: transparent; color: #4a6741; border: 1px solid #d8d3c8; }
.modal-button.danger { background: #a4402f; }
.modal-button:disabled { opacity: 0.55; cursor: default; }
.info-list {
  display: grid;
  grid-template-columns: 76px 1fr;
  gap: 8px 12px;
  margin: 0;
  font-size: 13px;
}
.info-list dt { color: #6b6b6b; }
.info-list dd { margin: 0; overflow-wrap: anywhere; }
```

- [ ] **Step 10: 类型检查与全量测试**

Run: `npm run typecheck`

Expected: PASS。

Run: `npm test`

Expected: PASS。

本任务不启动可见窗口；卡片菜单、来源信息和删除确认在 Task 9 的离屏 DOM 验收与用户手工清单中检查。

- [ ] **Step 11: 提交**

```bash
git add src/main/services/library.ts src/renderer/src/components/Modal.tsx src/renderer/src/components/BookCard.tsx src/renderer/src/pages/Library.tsx src/renderer/src/styles.css src/shared/api.ts src/preload/index.ts src/main/index.ts tests/library-service.test.ts
git commit -m "feat(library): Delete books and show sources" -m "The library offered no way to remove a book or inspect where it
came from. Both actions need a confirmation path and a readable
source summary.

- Add LibraryService with a serialized remove
- Replace inline cards with BookCard and a context menu
- Add a shared Modal for confirmations
- Show every source file name and the import statistics"
```

---

### Task 4: 导入队列与合并提示

**Files:**
- Create: `src/main/services/importQueue.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/renderer/src/pages/Library.tsx`
- Test: `tests/import-queue.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `MergeService`/`mergeBooks`；Task 3 的 `Modal`/`BookCard`/`notify`。
- Produces:
  - `ImportSuspect { sourceId; sourceTitle; id; title; overlap }`
  - `ImportSummary.suspects: ImportSuspect[]`
  - `class ImportQueue { importFiles(files: string[]): Promise<ImportSummary> }`（Task 7 再扩展）
  - IPC `debug:import` / `library:choose-import` 都走该队列

- [ ] **Step 1: 写导入队列的失败测试**

新建 `tests/import-queue.test.ts`：

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportQueue } from '../src/main/services/importQueue'
import { ImportService } from '../src/main/services/import'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-import-queue-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeBookText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(`第${i}章 风起`, `这是第${i}章的正文。`, '')
  }
  return lines.join('\n')
}

describe('ImportQueue', () => {
  it('reports suspects with the newly imported source id', async () => {
    const first = join(root, '测试书_1-3章.txt')
    const second = join(root, '测试书_4-6章.txt')
    await writeFile(first, iconv.encode(makeBookText(1, 3), 'utf8'))
    await writeFile(second, iconv.encode(makeBookText(4, 6), 'utf8'))

    const queue = new ImportQueue(new ImportService(library, books))
    const summary = await queue.importFiles([first, second])

    const entries = await library.list()
    const source = entries.find((entry) => entry.sourceFileName === '测试书_4-6章.txt')
    const target = entries.find((entry) => entry.sourceFileName === '测试书_1-3章.txt')

    expect(summary.imported).toBe(2)
    expect(summary.suspects).toContainEqual(
      expect.objectContaining({
        sourceId: source?.id,
        sourceTitle: '测试书_4-6章',
        id: target?.id,
        title: '测试书_1-3章'
      })
    )
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/import-queue.test.ts`

Expected: FAIL with "Cannot find module '../src/main/services/importQueue'"。

- [ ] **Step 3: 实现基础导入队列**

`src/main/services/importQueue.ts`：

```ts
import { basename } from 'node:path'
import type { ImportSummary } from '../../shared/api'
import type { ImportService } from './import'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ImportQueue {
  constructor(private readonly importer: ImportService) {}

  async importFiles(files: string[]): Promise<ImportSummary> {
    const summary: ImportSummary = {
      imported: 0,
      duplicates: [],
      suspects: [],
      errors: [],
      warnings: []
    }

    for (const file of files) {
      const fileName = basename(file)
      try {
        const outcome = await this.importer.importFile(file)
        if ('duplicate' in outcome) {
          summary.duplicates.push(outcome.title)
          continue
        }
        summary.imported += 1
        summary.suspects.push(
          ...outcome.suspects.map((suspect) => ({
            ...suspect,
            sourceId: outcome.entry.id,
            sourceTitle: outcome.entry.title
          }))
        )
        for (const warning of outcome.warnings) {
          summary.warnings.push(`${fileName}：${warning}`)
        }
      } catch (error) {
        summary.errors.push(`${fileName}: ${errorMessage(error)}`)
      }
    }

    return summary
  }
}
```

- [ ] **Step 4: 运行导入队列测试**

Run: `npx vitest run tests/import-queue.test.ts`

Expected: PASS。

- [ ] **Step 5: 更新共享类型**

`src/shared/api.ts` 在 `ImportSummary` 前加：

```ts
export interface ImportSuspect {
  sourceId: string
  sourceTitle: string
  id: string
  title: string
  overlap: number
}
```

把 `ImportSummary` 改成：

```ts
export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: ImportSuspect[]
  errors: string[]
  warnings: string[]
}
```

- [ ] **Step 6: 主进程改用导入队列**

`src/main/index.ts`：

- 删除 `importFiles` 函数。
- 在服务实例化处加：

```ts
const importQueue = new ImportQueue(importer)
```

- 在 `library:choose-import` handler 里，把 `return importFiles(selection.filePaths, win)` 改成：

```ts
    return importQueue.importFiles(selection.filePaths)
```

- 在 `debug:import` handler 里，把 `return importFiles(safePaths, BrowserWindow.getFocusedWindow())` 改成：

```ts
      return importQueue.importFiles(safePaths)
```

- 导入 `ImportQueue`，并移除不再使用的 `basename` 与 `ImportSummary` 导入（若存在）。

- [ ] **Step 7: 书架页接入合并提示**

修改 `src/renderer/src/pages/Library.tsx`：

把 React 的导入改成 `import { useEffect, useRef, useState } from 'react'`，并加：

```tsx
import type { ImportSummary, ImportSuspect } from '../../../shared/api'
```

状态加：

```tsx
  const [mergeQueue, setMergeQueue] = useState<ImportSuspect[]>([])
  const busyRef = useRef(false)
```

把 `handleImport` 替换为：

```tsx
  const applySummary = async (summary: ImportSummary): Promise<void> => {
    const parts: string[] = []
    if (summary.imported > 0) parts.push(`成功导入 ${summary.imported} 本`)
    if (summary.duplicates.length > 0) parts.push(`已在书库：${summary.duplicates.join('、')}`)
    if (summary.errors.length > 0) parts.push(`失败：${summary.errors.join('；')}`)
    if (summary.warnings.length > 0) parts.push(`提示：${summary.warnings.join('；')}`)
    notify(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
    if (summary.suspects.length > 0) setMergeQueue(summary.suspects)
    await refresh()
  }

  const runImport = async (task: () => Promise<ImportSummary>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress('')
    try {
      await applySummary(await task())
    } catch (reason) {
      notify(`导入失败：${errorText(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress('')
    }
  }

  const handleImport = (): Promise<void> => runImport(() => window.api.chooseAndImport())
```

在 `handleImport` 后加：

```tsx
  const pendingMerge = mergeQueue[0] ?? null

  const confirmMerge = async (): Promise<void> => {
    if (!pendingMerge) return
    setActionBusy(true)
    try {
      const result = await window.api.mergeBooks(pendingMerge.id, pendingMerge.sourceId)
      setMergeQueue((queue) => queue.filter((item) => item.sourceId !== pendingMerge.sourceId))
      notify(
        `已合并为《${result.title}》，共 ${result.chapterCount} 章${
          result.warning ? `；${result.warning}` : ''
        }`
      )
      await refresh()
    } catch (reason) {
      notify(`合并失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const skipMerge = (): void => setMergeQueue((queue) => queue.slice(1))
```

在 `{dialog?.kind === 'source' && ...}` 之前加：

```tsx
      {pendingMerge && (
        <Modal
          title="可能是同一本书"
          onClose={skipMerge}
          footer={
            <>
              <button className="modal-button ghost" onClick={skipMerge}>
                先不合并
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmMerge()}
              >
                {actionBusy ? '合并中…' : `合并到《${pendingMerge.title}》`}
              </button>
            </>
          }
        >
          <p>
            《{pendingMerge.sourceTitle}》与《{pendingMerge.title}》有{' '}
            {(pendingMerge.overlap * 100).toFixed(0)}% 的章节内容重叠，可能是一本书的不同分卷。
          </p>
          <p className="modal-note">合并后会保留阅读进度和书签，并自动备份原书数据。</p>
        </Modal>
      )}
```

- [ ] **Step 8: 类型检查与测试**

Run: `npm run typecheck`

Expected: PASS。

Run: `npx vitest run tests/import-queue.test.ts tests/merge-service.test.ts`

Expected: PASS。

本任务不启动可见窗口；合并对话框由 Task 9 的用户手工清单检查。

- [ ] **Step 9: 提交**

```bash
git add src/main/services/importQueue.ts src/shared/api.ts src/main/index.ts src/renderer/src/pages/Library.tsx tests/import-queue.test.ts
git commit -m "feat(library): Offer merging suspected duplicates" -m "Suspects were reported as text and never actionable. The import
summary also lost which newly imported book each suspect belonged
to.

- Move batch import into ImportQueue
- Carry source id and title with every suspect
- Show a merge dialog with backup and progress guarantees
- Route debug imports through the same queue"
```

---

### Task 5: 重新清洗与重新切章服务

**Files:**
- Create: `src/core/reprocess.ts`
- Create: `src/main/services/reprocess.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`
- Test: `tests/reprocess.test.ts`
- Test: `tests/reprocess-service.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `buildBookDocuments`、`BookRepository.readBook`、`BookRepository.writeBook`；Task 1 的互斥与 `assertBookId`。
- Produces:
  - `chaptersFromLines(sourceText: string, meta: BookMeta): CleanedChapter[]`
  - `class ReprocessService { constructor(library, books, userRules?); reclean(id): Promise<ReprocessResult>; resplit(id): Promise<ReprocessResult> }`
  - `ReprocessResult { id; chapterCount; stats; warning? }`
  - `ReaderApi.recleanBook(id)`、`ReaderApi.resplitBook(id)`
  - IPC `book:reclean`、`book:resplit`

- [ ] **Step 1: 写行号还原的失败测试**

新建 `tests/reprocess.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { BookMeta } from '../src/core/model'
import { chaptersFromLines } from '../src/core/reprocess'

function meta(): BookMeta {
  return {
    version: 1,
    id: 'a',
    title: '测试书',
    encoding: 'utf8',
    chapters: [
      {
        index: 0,
        title: '第一章',
        level: 'chapter',
        titleHash: 'a',
        startLine: 0,
        charCount: 0,
        simhash: '0',
        flags: {}
      },
      {
        index: 1,
        title: '第二章',
        level: 'chapter',
        titleHash: 'b',
        startLine: 3,
        charCount: 0,
        simhash: '0',
        flags: {}
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('chaptersFromLines', () => {
  it('rebuilds chapter paragraphs from saved line numbers', () => {
    const chapters = chaptersFromLines('第一章\n甲。\n\n第二章\n乙。\n丙。', meta())
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['甲。'], ['乙。', '丙。']])
    expect(chapters.map((chapter) => chapter.startLine)).toEqual([0, 3])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/reprocess.test.ts`

Expected: FAIL with "Cannot find module '../src/core/reprocess'"。

- [ ] **Step 3: 实现 `chaptersFromLines`**

`src/core/reprocess.ts`：

```ts
import type { BookMeta, CleanedChapter } from './model'

/** Rebuilds chapter paragraphs from a stored source using saved start lines. */
export function chaptersFromLines(sourceText: string, meta: BookMeta): CleanedChapter[] {
  const lines = sourceText.split(/\r\n|\r|\n/)
  return meta.chapters.map((chapter, index) => {
    const start = Math.min(Math.max(chapter.startLine, 0), lines.length)
    const nextStart =
      index + 1 < meta.chapters.length ? meta.chapters[index + 1].startLine : lines.length
    const end = Math.min(Math.max(nextStart, start), lines.length)
    const paragraphs = lines
      .slice(start + 1, end)
      .map((line) => line.trim())
      .filter(Boolean)
    return {
      title: chapter.title,
      level: chapter.level,
      startLine: start,
      paragraphs
    }
  })
}
```

- [ ] **Step 4: 运行行号测试**

Run: `npx vitest run tests/reprocess.test.ts`

Expected: PASS。

- [ ] **Step 5: 写重洗/重切服务的失败测试**

新建 `tests/reprocess-service.test.ts`：

```ts
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CleanedChapter, LibraryEntry } from '../src/core/model'
import { buildChapterMetas } from '../src/core/pipeline'
import { ReprocessService } from '../src/main/services/reprocess'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: ReprocessService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-reprocess-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new ReprocessService(library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function entry(chapterCount: number): LibraryEntry {
  return {
    id: 'book-1',
    title: '测试书',
    normalizedTitle: '测试书',
    sourceFileName: '测试书.txt',
    fileHash: 'hash',
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

async function seed(sourceText: string, chapters: CleanedChapter[]): Promise<void> {
  await books.writeBook({
    meta: {
      version: 1,
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      chapters: buildChapterMetas(chapters),
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    sourceText,
    chapters
  })
  await library.add(entry(chapters.length))
  await books.writeProgress('book-1', {
    progress: {
      chapterKey: 'old-key',
      chapterIndex: 0,
      paragraphIndex: 0,
      percent: 33,
      updatedAt: '2026-01-02T00:00:00.000Z'
    },
    bookmarks: [
      {
        id: 'mark-1',
        chapterKey: 'old-key',
        chapterIndex: 0,
        paragraphIndex: 0,
        excerpt: '正文。',
        createdAt: '2026-01-02T00:00:00.000Z'
      }
    ]
  })
}

const AD_SOURCE =
  '第一章\n正文。\n请记住本站\n第二章\n更多正文。\n请记住本站\n第三章\n结尾。\n请记住本站'
const AD_CHAPTERS: CleanedChapter[] = [
  { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['正文。', '请记住本站'] },
  { title: '第二章', level: 'chapter', startLine: 3, paragraphs: ['更多正文。', '请记住本站'] },
  { title: '第三章', level: 'chapter', startLine: 6, paragraphs: ['结尾。', '请记住本站'] }
]

describe('ReprocessService', () => {
  it('recleans chapters, keeps the source, backs up and preserves progress', async () => {
    await seed(AD_SOURCE, AD_CHAPTERS)

    const result = await service.reclean('book-1')

    expect(result.stats.adLinesRemoved).toBe(3)
    expect(await books.readChapter('book-1', 0)).toBe('正文。')
    expect(await books.readSource('book-1')).toBe(AD_SOURCE)
    expect((await books.readMeta('book-1')).chapters.map((chapter) => chapter.startLine)).toEqual([
      0, 3, 6
    ])

    const stored = await books.readProgress('book-1')
    expect(stored.progress?.percent).toBe(33)
    expect(stored.bookmarks.map((bookmark) => bookmark.id)).toEqual(['mark-1'])
    expect((await library.list())[0].stats.adLinesRemoved).toBe(3)

    const backups = await readdir(join(root, 'books', 'book-1', 'backup'))
    expect(backups).toHaveLength(1)
    const oldChapter = await readFile(
      join(root, 'books', 'book-1', 'backup', backups[0], 'chapters', '00000.txt'),
      'utf8'
    )
    expect(oldChapter).toContain('请记住本站')
  })

  it('aborts when a cleaning rule removes all paragraphs', async () => {
    await seed(AD_SOURCE, AD_CHAPTERS)
    const strict = new ReprocessService(library, books, () => [
      { id: 'all', name: '全部删除', type: 'line', pattern: '.*', enabled: true }
    ])

    await expect(strict.reclean('book-1')).rejects.toThrow('没有可阅读的正文')
    expect(await books.readChapter('book-1', 0)).toContain('请记住本站')
    expect((await books.readMeta('book-1')).chapters).toHaveLength(3)
  })

  it('resplits by chapter titles and keeps progress', async () => {
    const sourceText = '第一章\n甲。\n第二章\n乙。\n第三章\n丙。'
    await seed(sourceText, [
      {
        title: '正文',
        level: 'chapter',
        startLine: 0,
        paragraphs: ['第一章', '甲。', '第二章', '乙。', '第三章', '丙。']
      }
    ])

    const result = await service.resplit('book-1')

    expect(result.chapterCount).toBe(3)
    expect(await books.readChapter('book-1', 0)).toBe('甲。')
    expect(await books.readChapter('book-1', 1)).toBe('乙。')
    expect(await books.readChapter('book-1', 2)).toBe('丙。')
    expect(await books.readSource('book-1')).toBe(sourceText)
    expect((await books.readProgress('book-1')).progress?.percent).toBe(33)
    expect((await library.list())[0].chapterCount).toBe(3)
  })

  it('keeps the book unchanged when no chapter titles are detected', async () => {
    const sourceText = '第一章\n甲。\n第二章\n乙。'
    await seed(sourceText, [
      { title: '正文', level: 'chapter', startLine: 0, paragraphs: ['第一章', '甲。', '第二章', '乙。'] }
    ])

    const result = await service.resplit('book-1')

    expect(result.warning).toContain('没有识别到')
    expect(result.chapterCount).toBe(1)
    expect((await books.readMeta('book-1')).chapters).toHaveLength(1)
    await expect(readdir(join(root, 'books', 'book-1', 'backup'))).rejects.toThrow()
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/reprocess-service.test.ts`

Expected: FAIL with "Cannot find module '../src/main/services/reprocess'"。

- [ ] **Step 7: 实现重洗/重切服务**

`src/main/services/reprocess.ts`：

```ts
import type { AdRule, CleanedChapter, ImportStats } from '../../core/model'
import { splitChapters } from '../../core/chapters'
import { BUILTIN_AD_RULES, cleanChapters } from '../../core/cleaning'
import { buildBookDocuments } from '../../core/compose'
import { chaptersFromLines } from '../../core/reprocess'
import type { ReprocessResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookFiles, BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export class ReprocessService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly userRules: () => AdRule[] = () => []
  ) {}

  async reclean(id: string): Promise<ReprocessResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const chapters = chaptersFromLines(book.sourceText, book.meta)
      return this.commit(id, book, chapters)
    })
  }

  async resplit(id: string): Promise<ReprocessResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const book = await this.load(id)
      const split = splitChapters(book.sourceText)
      if (!split.detected) {
        return {
          id,
          chapterCount: book.meta.chapters.length,
          stats: (await this.library.list()).find((entry) => entry.id === id)?.stats ?? {
            adLinesRemoved: 0,
            duplicateParagraphsMerged: 0,
            suspectedDuplicateChapters: 0
          },
          warning: '没有识别到至少 3 个章节标题，已保持原章节'
        }
      }
      return this.commit(id, book, split.chapters)
    })
  }

  private async load(id: string): Promise<BookFiles> {
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书，可能已被删除')
    return this.books.readBook(id)
  }

  private async commit(
    id: string,
    book: BookFiles,
    chapters: CleanedChapter[]
  ): Promise<ReprocessResult> {
    const cleaned = cleanChapters(chapters, [...BUILTIN_AD_RULES, ...this.userRules()])
    if (cleaned.chapters.every((chapter) => chapter.paragraphs.length === 0)) {
      throw new Error('重新清洗后没有可阅读的正文，已取消')
    }

    const documents = buildBookDocuments({
      id,
      title: book.meta.title,
      encoding: book.meta.encoding,
      createdAt: book.meta.createdAt,
      sourceText: book.sourceText,
      chapters: cleaned.chapters
    })
    const stats: ImportStats = {
      adLinesRemoved: cleaned.adLinesRemoved,
      duplicateParagraphsMerged: cleaned.duplicateParagraphsMerged,
      suspectedDuplicateChapters: documents.meta.chapters.filter(
        (chapter) => chapter.flags.suspectedDuplicate
      ).length
    }

    const progress = await this.books.readProgress(id)
    await this.books.writeBook(documents)
    await this.books.writeProgress(id, progress)
    await this.library.save(
      (await this.library.list()).map((entry) =>
        entry.id === id
          ? { ...entry, chapterCount: documents.meta.chapters.length, stats }
          : entry
      )
    )

    return { id, chapterCount: documents.meta.chapters.length, stats }
  }
}
```

- [ ] **Step 8: 运行服务测试**

Run: `npx vitest run tests/reprocess.test.ts tests/reprocess-service.test.ts`

Expected: PASS。

- [ ] **Step 9: 暴露 API**

`src/shared/api.ts` 在 `MergeResult` 后加：

```ts
export interface ReprocessResult {
  id: string
  chapterCount: number
  stats: ImportStats
  warning?: string
}
```

文件顶部的类型导入补 `ImportStats`：

```ts
import type {
  AppSettings,
  BookMeta,
  Bookmark,
  BookProgress,
  ImportStats,
  LibraryEntry
} from '../core/model'
```

`ReaderApi` 里加：

```ts
  recleanBook(id: string): Promise<ReprocessResult>
  resplitBook(id: string): Promise<ReprocessResult>
```

`src/preload/index.ts` 里加：

```ts
  recleanBook: (id) => ipcRenderer.invoke('book:reclean', id),
  resplitBook: (id) => ipcRenderer.invoke('book:resplit', id),
```

`src/main/index.ts` 导入：

```ts
import { ReprocessService } from './services/reprocess'
```

实例化：

```ts
const reprocess = new ReprocessService(library, books)
```

在 `library:remove` handler 后加：

```ts
  ipcMain.handle('book:reclean', (_event, id: string) => reprocess.reclean(id))
  ipcMain.handle('book:resplit', (_event, id: string) => reprocess.resplit(id))
```

- [ ] **Step 10: 类型检查**

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 11: 提交**

```bash
git add src/core/reprocess.ts src/main/services/reprocess.ts src/shared/api.ts src/preload/index.ts src/main/index.ts tests/reprocess.test.ts tests/reprocess-service.test.ts
git commit -m "feat(reprocess): Re-clean and re-split books" -m "Imported books could not be reprocessed after a cleaning change
or a bad automatic split. Both operations must keep the original
source, a backup and the reading position.

- Rebuild chapters from saved source line numbers
- Re-clean with the current built-in rules
- Re-split only when at least three titles are detected
- Abort instead of overwriting a book that would become empty"
```

---

### Task 6: 书架上的重洗/重切入口

**Files:**
- Modify: `src/renderer/src/pages/Library.tsx`

**Interfaces:**
- Consumes: Task 5 的 `window.api.recleanBook/resplitBook`、Task 3 的 `Modal`。
- Produces: 卡片菜单新增「重新清洗」「重新切章」，各带确认对话框。

- [ ] **Step 1: 扩展对话框类型**

把 `Library.tsx` 的 `Dialog` 类型改成：

```tsx
type Dialog =
  | { kind: 'source'; entry: LibraryEntry }
  | { kind: 'delete'; entry: LibraryEntry }
  | { kind: 'reclean'; entry: LibraryEntry }
  | { kind: 'resplit'; entry: LibraryEntry }
```

- [ ] **Step 2: 加重洗/重切处理函数**

在 `confirmDelete` 后加：

```tsx
  const confirmReprocess = async (
    entry: LibraryEntry,
    kind: 'reclean' | 'resplit'
  ): Promise<void> => {
    setActionBusy(true)
    try {
      const result =
        kind === 'reclean'
          ? await window.api.recleanBook(entry.id)
          : await window.api.resplitBook(entry.id)
      setDialog(null)
      const label = kind === 'reclean' ? '重新清洗' : '重新切章'
      const detail =
        kind === 'reclean'
          ? `移除广告 ${result.stats.adLinesRemoved} 行，合并重复段 ${result.stats.duplicateParagraphsMerged} 处`
          : `共 ${result.chapterCount} 章`
      notify(
        `已${label}《${entry.title}》：${detail}${result.warning ? `；${result.warning}` : ''}`
      )
      await refresh()
    } catch (reason) {
      notify(`${kind === 'reclean' ? '重新清洗' : '重新切章'}失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }
```

- [ ] **Step 3: 菜单加两项**

在「查看来源」按钮后、「删除」按钮前加：

```tsx
            <button
              onClick={() => {
                setDialog({ kind: 'reclean', entry: menu.entry })
                setMenu(null)
              }}
            >
              重新清洗
            </button>
            <button
              onClick={() => {
                setDialog({ kind: 'resplit', entry: menu.entry })
                setMenu(null)
              }}
            >
              重新切章
            </button>
```

- [ ] **Step 4: 加两个确认对话框**

在删除对话框之后加：

```tsx
      {dialog?.kind === 'reclean' && (
        <Modal
          title="重新清洗"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmReprocess(dialog.entry, 'reclean')}
              >
                {actionBusy ? '处理中…' : '重新清洗'}
              </button>
            </>
          }
        >
          <p>将按当前内置清洗规则重新处理《{dialog.entry.title}》。</p>
          <p className="modal-note">原数据会自动备份，阅读进度和书签保留。</p>
        </Modal>
      )}

      {dialog?.kind === 'resplit' && (
        <Modal
          title="重新切章"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmReprocess(dialog.entry, 'resplit')}
              >
                {actionBusy ? '处理中…' : '重新切章'}
              </button>
            </>
          }
        >
          <p>将重新识别源文件中的章节标题并切分《{dialog.entry.title}》。</p>
          <p className="modal-note">
            识别不到至少 3 个章节标题时会保持原样。原数据会自动备份，阅读进度和书签保留。
          </p>
        </Modal>
      )}
```

- [ ] **Step 5: 类型检查与全量测试**

Run: `npm run typecheck`

Expected: PASS。

Run: `npm test`

Expected: PASS。

本任务不启动可见窗口；重洗/重切菜单项和提示在 Task 9 的用户手工清单中检查。

- [ ] **Step 6: 提交**

```bash
git add src/renderer/src/pages/Library.tsx
git commit -m "feat(library): Add reprocess actions to cards" -m "The reprocess services had no entry point. Expose both from the
card menu with confirmation copy that names the backup and the
preserved reading position."
```

---

### Task 7: 拖拽导入、大文件确认与导入阶段

**Files:**
- Modify: `src/main/services/importQueue.ts`
- Modify: `src/main/services/import.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/hooks/useFileDrop.ts`
- Modify: `src/renderer/src/pages/Library.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/import-queue.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `ImportQueue`/`ImportSummary`、Task 4 的 `runImport`。
- Produces:
  - `ImportQueueOptions { largeFileBytes?; confirmLargeFile? }`
  - `ImportQueue.importFiles(files, onStage?): Promise<ImportSummary>`
  - `ImportSummary.canceled?: boolean`
  - `ReaderApi.importPaths(paths)`、`ReaderApi.pathForFile(file)`
  - IPC `library:import-paths`
  - `useFileDrop(onPaths): boolean`

- [ ] **Step 1: 写导入队列新增行为的失败测试**

在 `tests/import-queue.test.ts` 末尾追加：

```ts
it('skips non-txt files and directories with readable warnings', async () => {
  const jpg = join(root, '封面.jpg')
  const folder = join(root, '文件夹.txt')
  await writeFile(jpg, 'not a book')
  await mkdir(folder)

  const queue = new ImportQueue(new ImportService(library, books))
  const summary = await queue.importFiles([jpg, folder])

  expect(summary.imported).toBe(0)
  expect(summary.warnings.join('')).toContain('只支持 TXT 文件')
  expect(summary.warnings.join('')).toContain('不是文件')
  expect(await library.list()).toEqual([])
})

it('asks before importing a large file and respects the answer', async () => {
  const file = join(root, '大书.txt')
  await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
  const calls: { fileName: string; size: number }[] = []

  const rejected = new ImportQueue(new ImportService(library, books), {
    largeFileBytes: 10,
    confirmLargeFile: async (info) => {
      calls.push(info)
      return false
    }
  })
  const skipped = await rejected.importFiles([file])
  expect(skipped.imported).toBe(0)
  expect(calls[0].fileName).toBe('大书.txt')
  expect(calls[0].size).toBeGreaterThan(10)
  expect(skipped.warnings.join('')).toContain('已跳过')

  const accepted = new ImportQueue(new ImportService(library, books), {
    largeFileBytes: 10,
    confirmLargeFile: async () => true
  })
  const imported = await accepted.importFiles([file])
  expect(imported.imported).toBe(1)
})

it('reports missing files without aborting the batch', async () => {
  const queue = new ImportQueue(new ImportService(library, books))
  const summary = await queue.importFiles([join(root, '不存在.txt')])

  expect(summary.errors).toEqual([])
  expect(summary.warnings[0]).toContain('无法读取文件信息')
})

it('emits import stages in order', async () => {
  const file = join(root, '阶段.txt')
  await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
  const stages: string[] = []

  const queue = new ImportQueue(new ImportService(library, books))
  await queue.importFiles([file], ({ stage }) => stages.push(stage))

  expect(stages).toEqual(['reading', 'parsing', 'writing', 'done'])
})
```

`tests/import-queue.test.ts` 顶部的 `node:fs/promises` 导入补 `mkdir`。

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/import-queue.test.ts`

Expected: FAIL —— 非 TXT 被当成书导入；大文件确认未被调用；阶段回调为 `undefined`。

- [ ] **Step 3: 给导入服务加阶段回调**

`src/main/services/import.ts` 顶部加：

```ts
export type ImportStage = 'reading' | 'parsing' | 'writing' | 'done'
```

把 `importFile` 签名改成：

```ts
  async importFile(
    filePath: string,
    onStage: (stage: ImportStage) => void = () => {}
  ): Promise<ImportOutcome | DuplicateOutcome> {
    onStage('reading')
    const contents = await readFile(filePath)
```

在 `parseBookFile` 前加 `onStage('parsing')`，在 `writeBook` 前加 `onStage('writing')`，在 `library.add(entry)` 后加 `onStage('done')`：

```ts
    onStage('parsing')
    const parsed = parseBookFile(contents, fileName, { userRules: this.userRules() })

    onStage('writing')
    await this.books.writeBook({
      meta: parsed.meta,
      sourceText: parsed.sourceText,
      chapters: parsed.chapters
    })
```

```ts
    await this.library.add(entry)
    onStage('done')
```

- [ ] **Step 4: 扩展导入队列**

`src/main/services/importQueue.ts` 改成：

```ts
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ImportSummary } from '../../shared/api'
import type { ImportService, ImportStage } from './import'

export interface ImportQueueOptions {
  largeFileBytes?: number
  confirmLargeFile?: (info: { fileName: string; size: number }) => Promise<boolean>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export class ImportQueue {
  constructor(
    private readonly importer: ImportService,
    private readonly options: ImportQueueOptions = {}
  ) {}

  async importFiles(
    files: string[],
    onStage?: (payload: { fileName: string; stage: ImportStage }) => void
  ): Promise<ImportSummary> {
    const summary: ImportSummary = {
      imported: 0,
      duplicates: [],
      suspects: [],
      errors: [],
      warnings: []
    }
    const threshold = this.options.largeFileBytes ?? 50 * 1024 * 1024
    const confirm = this.options.confirmLargeFile ?? (async () => false)

    for (const file of files) {
      const fileName = basename(file)
      if (extname(fileName).toLowerCase() !== '.txt') {
        summary.warnings.push(`${fileName}：只支持 TXT 文件`)
        continue
      }

      let size = 0
      try {
        const info = await stat(file)
        if (!info.isFile()) {
          summary.warnings.push(`${fileName}：不是文件`)
          continue
        }
        size = info.size
      } catch {
        summary.warnings.push(`${fileName}：无法读取文件信息`)
        continue
      }

      if (size > threshold) {
        const accepted = await confirm({ fileName, size })
        if (!accepted) {
          summary.warnings.push(`${fileName}：文件超过 ${formatFileSize(threshold)}，已跳过`)
          continue
        }
      }

      try {
        const outcome = await this.importer.importFile(file, (stage) =>
          onStage?.({ fileName, stage })
        )
        if ('duplicate' in outcome) {
          summary.duplicates.push(outcome.title)
          continue
        }
        summary.imported += 1
        summary.suspects.push(
          ...outcome.suspects.map((suspect) => ({
            ...suspect,
            sourceId: outcome.entry.id,
            sourceTitle: outcome.entry.title
          }))
        )
        for (const warning of outcome.warnings) {
          summary.warnings.push(`${fileName}：${warning}`)
        }
      } catch (error) {
        summary.errors.push(`${fileName}: ${errorMessage(error)}`)
      }
    }

    return summary
  }
}
```

- [ ] **Step 5: 定义取消与拖拽 API**

`src/shared/api.ts` 的 `ImportSummary` 加：

```ts
  canceled?: boolean
```

`ReaderApi` 加：

```ts
  importPaths(paths: string[]): Promise<ImportSummary>
  /** Resolves the on-disk path of a file dropped onto the window. */
  pathForFile(file: unknown): string
```

- [ ] **Step 6: 预加载脚本**

`src/preload/index.ts` 顶部：

```ts
import { contextBridge, ipcRenderer, webUtils } from 'electron'
```

`api` 对象里加：

```ts
  importPaths: (paths) => ipcRenderer.invoke('library:import-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file as File),
```

- [ ] **Step 7: 主进程接大文件确认与阶段事件**

`src/main/index.ts`：

- 顶部类型导入加 `MessageBoxOptions`、`WebContents`：

```ts
import type { MessageBoxOptions, WebContents } from 'electron'
```

- 导入 `formatFileSize`：

```ts
import { formatFileSize, ImportQueue } from './services/importQueue'
```

- 把 `const importQueue = new ImportQueue(importer)` 替换为：

```ts
const importQueue = new ImportQueue(importer, {
  confirmLargeFile: async ({ fileName, size }) => {
    if (ACCEPTANCE) return true
    const win = BrowserWindow.getFocusedWindow()
    const options: MessageBoxOptions = {
      type: 'question',
      buttons: ['继续导入', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '导入较大的文件',
      message: `${fileName} 有 ${formatFileSize(size)}`,
      detail: '较大的文件解析需要一些时间，继续导入吗？'
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  }
})

function sendImportProgress(
  sender: WebContents,
  payload: { fileName: string; stage: string }
): void {
  if (!sender.isDestroyed()) sender.send('import:progress', payload)
}
```

- `library:choose-import` handler 改成接收 `event`，取消时返回 `canceled`，导入时传阶段回调：

```ts
  ipcMain.handle('library:choose-import', async (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    }
    const selection = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

    if (selection.canceled || selection.filePaths.length === 0) {
      return {
        imported: 0,
        duplicates: [],
        suspects: [],
        errors: [],
        warnings: [],
        canceled: true
      }
    }

    return importQueue.importFiles(selection.filePaths, (payload) =>
      sendImportProgress(event.sender, payload)
    )
  })
```

- 在 `library:choose-import` 后加：

```ts
  ipcMain.handle('library:import-paths', (event, paths: unknown) => {
    const safePaths = Array.isArray(paths)
      ? paths.filter((path): path is string => typeof path === 'string')
      : []
    return importQueue.importFiles(safePaths, (payload) =>
      sendImportProgress(event.sender, payload)
    )
  })
```

- `debug:import` 改成：

```ts
    ipcMain.handle('debug:import', (event, paths: string[]) => {
      const safePaths = Array.isArray(paths)
        ? paths.filter((path) => typeof path === 'string')
        : []
      return importQueue.importFiles(safePaths, (payload) =>
        sendImportProgress(event.sender, payload)
      )
    })
```

- [ ] **Step 8: 拖拽 Hook**

`src/renderer/src/hooks/useFileDrop.ts`：

```ts
import { useEffect, useRef, useState } from 'react'

export function useFileDrop(onPaths: (paths: string[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const callbackRef = useRef(onPaths)
  callbackRef.current = onPaths

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const handleEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const handleOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault()
    }
    const handleLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const handleDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => window.api.pathForFile(file))
        .filter((path) => Boolean(path))
      if (paths.length > 0) callbackRef.current(paths)
    }

    window.addEventListener('dragenter', handleEnter)
    window.addEventListener('dragover', handleOver)
    window.addEventListener('dragleave', handleLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleEnter)
      window.removeEventListener('dragover', handleOver)
      window.removeEventListener('dragleave', handleLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  return dragging
}
```

- [ ] **Step 9: 书架页接拖拽与阶段文案**

`src/renderer/src/pages/Library.tsx`：

- 导入 Hook：

```tsx
import { useFileDrop } from '../hooks/useFileDrop'
```

- 加阶段标签常量（放在 `SORTERS` 后）：

```tsx
const STAGE_LABELS: Record<string, string> = {
  reading: '读取中',
  parsing: '解析中',
  writing: '写入中',
  done: '完成'
}
```

- 进度事件文案改成：

```tsx
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName} · ${STAGE_LABELS[payload.stage] ?? payload.stage}`)
    })
```

- `applySummary` 开头加：

```tsx
    if (summary.canceled) return
```

- 在 `skipMerge` 后加：

```tsx
  const importPaths = async (paths: string[]): Promise<void> => {
    if (busyRef.current) {
      notify('正在导入，请稍候')
      return
    }
    await runImport(() => window.api.importPaths(paths))
  }

  const dragging = useFileDrop((paths) => {
    if (dialog || pendingMerge) return
    void importPaths(paths)
  })
```

- 在 toast 后加拖拽遮罩：

```tsx
      {dragging && !dialog && !pendingMerge && (
        <div className="drop-overlay">松开鼠标，导入 TXT</div>
      )}
```

- [ ] **Step 10: 拖拽遮罩样式**

`src/renderer/src/styles.css` 末尾追加：

```css
.drop-overlay {
  position: fixed;
  inset: 12px;
  z-index: 70;
  border: 2px dashed #4a6741;
  border-radius: 12px;
  background: rgba(245, 243, 238, 0.9);
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 18px;
  color: #4a6741;
  pointer-events: none;
}
```

- [ ] **Step 11: 运行测试与类型检查**

Run: `npx vitest run tests/import-queue.test.ts tests/import-service.test.ts`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

本任务不启动可见窗口；拖拽遮罩、大文件确认框等 UI 在 Task 9 的用户手工清单中检查。离屏验收会通过 `library:import-paths` 驱动同一队列。

- [ ] **Step 12: 提交**

```bash
git add src/main/services/importQueue.ts src/main/services/import.ts src/main/index.ts src/shared/api.ts src/preload/index.ts src/renderer/src/hooks/useFileDrop.ts src/renderer/src/pages/Library.tsx src/renderer/src/styles.css tests/import-queue.test.ts
git commit -m "feat(import): Confirm large files and accept drops" -m "Dragging a book did nothing, large files were imported without a
warning, and cancelling the picker showed a false empty result.

- Add a window-wide drop target using webUtils paths
- Ask before importing files over 50MB
- Stream read/parse/write/done stages to the library
- Return a canceled summary instead of an empty one"
```

---

### Task 8: 书签去重与广告残句

**Files:**
- Modify: `src/main/services/reader.ts:53-69`
- Modify: `src/core/cleaning.ts:16-22`
- Test: `tests/reader-service.test.ts`
- Test: `tests/cleaning.test.ts`

**Interfaces:**
- Consumes: 现有 `ReaderService`/`BUILTIN_AD_RULES`。
- Produces: 同一 `chapterKey + paragraphIndex` 只保留一条书签；`记住我们网` 短句被清洗。

- [ ] **Step 1: 改书签测试**

把 `tests/reader-service.test.ts` 的用例替换为：

```ts
  it('deduplicates bookmarks at the same position when two writes race', async () => {
    const input = {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      excerpt: '另一段。'
    }

    await Promise.all([service.addBookmark(bookId, input), service.addBookmark(bookId, input)])

    const stored = await service.open(bookId)
    expect(stored.bookmarks).toHaveLength(1)
    expect(stored.bookmarks[0].chapterKey).toBe('hash-1')
    expect(stored.bookmarks[0].paragraphIndex).toBe(1)
  })
```

- [ ] **Step 2: 加广告残句测试**

在 `tests/cleaning.test.ts` 的 `describe('cleanChapters')` 里加：

```ts
  it('removes the site reminder fragment found in real books', () => {
    const result = cleanChapters(
      [chapter(['正文结束。记住我们网'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['正文结束。'])
    expect(result.adLinesRemoved).toBe(1)
  })
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/reader-service.test.ts tests/cleaning.test.ts`

Expected: FAIL —— 并发书签仍为 2 条；广告残句仍在。

- [ ] **Step 4: 服务端书签去重**

`src/main/services/reader.ts` 的 `addBookmark` 里，在构造 `bookmark` 之前加：

```ts
      const existing = stored.bookmarks.find(
        (item) =>
          item.chapterKey === input.chapterKey && item.paragraphIndex === input.paragraphIndex
      )
      if (existing) return stored.bookmarks
```

- [ ] **Step 5: 补广告短句规则**

`src/core/cleaning.ts` 的 `sentence` 规则改成：

```ts
  {
    id: 'sentence',
    name: '短句广告',
    type: 'sentence',
    pattern: '请记住本站|记住本站|记住我们网|最新章节|一秒记住|加入书签|投推荐票',
    enabled: true
  }
```

- [ ] **Step 6: 运行测试**

Run: `npx vitest run tests/reader-service.test.ts tests/cleaning.test.ts`

Expected: PASS。

- [ ] **Step 7: 全量测试与类型检查**

Run: `npm test`

Expected: PASS。

Run: `npm run typecheck`

Expected: PASS。

- [ ] **Step 8: 提交**

```bash
git add src/main/services/reader.ts src/core/cleaning.ts tests/reader-service.test.ts tests/cleaning.test.ts
git commit -m "fix: Deduplicate bookmarks and ad fragments" -m "A fast double Ctrl+B could store two bookmarks at the same
paragraph. A real book also kept the short site reminder
\"记住我们网\" after cleaning.

- Reject a bookmark at an existing chapter/paragraph anchor
- Add the reminder fragment to the short-sentence ad rule"
```

---

### Task 9: 全量验收与交付记录

**Files:**
- Create: `docs/superpowers/acceptance/2026-10-30-reader-library.md`
- Verify: 全仓库

**Interfaces:**
- Consumes: Task 1-8 的全部能力。
- Produces: 一份验收记录；无生产代码改动。

- [ ] **Step 1: 全量测试、类型检查、构建**

Run: `npm test`

Expected: 全部 PASS（当前基线 95 条，加上本计划新增用例）。

Run: `npm run typecheck`

Expected: PASS。

Run: `npm run build`

Expected: PASS（生成 `out/`，已被 `.gitignore` 忽略）。

- [ ] **Step 2: 准备隔离的验收数据**

验收数据放在固定的临时目录。**每个代码块都自带 `ACCEPT_ROOT` 赋值**，不依赖上一步的 shell 变量（新终端里直接粘贴即可）。在 Git Bash 中执行：

```bash
ACCEPT_ROOT="C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance"
rm -rf "$ACCEPT_ROOT"
mkdir -p "$ACCEPT_ROOT"
node - "$ACCEPT_ROOT" <<'NODE'
const fs = require('node:fs')
const path = require('node:path')
const root = process.argv[2]
function volume(fileName, from, to) {
  const lines = []
  for (let i = from; i <= to; i++) {
    lines.push(
      `第${i}章 验收`,
      `这是第${i}章的正文第一段。`,
      'www.example-ad.com',
      `这是第${i}章的正文第二段。`,
      ''
    )
  }
  fs.writeFileSync(path.join(root, fileName), lines.join('\n'), 'utf8')
}
volume('验收书_1-3章.txt', 1, 3)
volume('验收书_4-6章.txt', 4, 6)
console.log(root)
NODE
```

Expected: 输出 `C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance`，目录内有 `验收书_1-3章.txt`、`验收书_4-6章.txt`。

- [ ] **Step 3: 以离屏模式启动开发构建**

```bash
ACCEPT_ROOT="C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance"
PORTABLE_EXECUTABLE_DIR="$ACCEPT_ROOT" READER_ACCEPTANCE=1 env -u ELECTRON_RUN_AS_NODE npm run dev
```

`npm run dev` 会一直运行：执行代理必须放到后台（`run_in_background`），不要在前台等它退出。在另一个终端等 9222 就绪：

```bash
node scripts/debug-eval.cjs "window.api.ping()"
```

Expected: `"pong"`。

- [ ] **Step 4: 自动化验收（导入 → 合并 → 重洗/重切 → 来源 → 删除）**

1. 导入两卷：

```bash
ACCEPT_ROOT="C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance"
node scripts/debug-eval.cjs "window.api.debugImport(['$ACCEPT_ROOT/验收书_1-3章.txt', '$ACCEPT_ROOT/验收书_4-6章.txt'])"
```

Expected: `imported: 2`，`warnings`/`errors` 为空。

> `debugImport` 是主进程调试入口，书架页不会自动刷新；第 4 小步会 reload 一次再检查 UI。

2. 合并并验证进度/书签：

```bash
node scripts/debug-eval.cjs "(async () => {
  const list = await window.api.libraryList()
  const target = list.find((entry) => entry.sourceFileName === '验收书_1-3章.txt')
  const source = list.find((entry) => entry.sourceFileName === '验收书_4-6章.txt')
  const book = await window.api.openBook(target.id)
  const key = book.meta.chapters[0].titleHash
  await window.api.saveProgress(target.id, {
    chapterKey: key,
    chapterIndex: 0,
    paragraphIndex: 1,
    percent: 17,
    updatedAt: '2026-10-30T00:00:00.000Z'
  })
  await window.api.addBookmark(target.id, {
    chapterKey: key,
    chapterIndex: 0,
    paragraphIndex: 1,
    excerpt: '验收书签'
  })
  const merged = await window.api.mergeBooks(target.id, source.id)
  const after = await window.api.openBook(target.id)
  return {
    merged,
    title: after.meta.title,
    chapters: after.meta.chapters.length,
    percent: after.progress?.percent,
    bookmarks: after.bookmarks.length,
    library: (await window.api.libraryList()).length
  }
})()"
```

Expected:

```json
{
  "merged": { "targetId": "...", "title": "验收书", "chapterCount": 6, "removedId": "..." },
  "title": "验收书",
  "chapters": 6,
  "percent": 17,
  "bookmarks": 1,
  "library": 1
}
```

3. 重洗与重切：

```bash
node scripts/debug-eval.cjs "(async () => {
  const [entry] = await window.api.libraryList()
  const recleaned = await window.api.recleanBook(entry.id)
  const resplit = await window.api.resplitBook(entry.id)
  const book = await window.api.openBook(entry.id)
  return {
    recleaned,
    resplit,
    chapters: book.meta.chapters.length,
    percent: book.progress?.percent,
    bookmarks: book.bookmarks.length
  }
})()"
```

Expected: `recleaned.chapterCount` 与 `resplit.chapterCount` 均为 6；`chapters` 6；`percent` 17；`bookmarks` 1。

4. 刷新书架 UI 后检查右键菜单与来源信息。合并/重洗都只走了 IPC，先 reload 让书架重新拉取：

```bash
node scripts/debug-eval.cjs "(() => { setTimeout(() => location.reload(), 50); return 'reloading' })()"
```

等页面重载完成：

```bash
node -e "setTimeout(() => process.exit(0), 1500)"
```

等待卡片重新渲染（最多 10 秒）：

```bash
node scripts/debug-eval.cjs "new Promise((resolve) => {
  const started = Date.now()
  const tick = () => {
    if (document.querySelector('.card')) return resolve(document.querySelectorAll('.card').length)
    if (Date.now() - started > 10000) return resolve('timeout')
    setTimeout(tick, 100)
  }
  tick()
})"
```

Expected: `1`。如果这一步报 `no page target` 或执行上下文错误，说明页面还在重载，等 1 秒重跑一次。

右键菜单（React 状态更新是异步的，派发事件后等两帧再读 DOM）：

```bash
node scripts/debug-eval.cjs "(async () => {
  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const card = [...document.querySelectorAll('.card')].find((item) =>
    item.textContent.includes('验收书')
  )
  if (!card) return 'card not found'
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 240, clientY: 200 }))
  await waitFrame()
  return [...document.querySelectorAll('.card-menu button')].map((button) => button.textContent)
})()"
```

Expected: `["查看来源","重新清洗","重新切章","删除"]`。

来源信息（同样等两帧再读、再关）：

```bash
node scripts/debug-eval.cjs "(async () => {
  const waitFrame = () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  const button = [...document.querySelectorAll('.card-menu button')].find(
    (item) => item.textContent === '查看来源'
  )
  if (!button) return 'menu item not found'
  button.click()
  await waitFrame()
  const text = document.querySelector('.modal')?.textContent
  document.querySelector('.modal .drawer-close')?.click()
  await waitFrame()
  return text
})()"
```

Expected: 文本包含 `验收书_1-3章.txt` 与 `验收书_4-6章.txt`。

5. 删除：

```bash
ACCEPT_ROOT="C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance"
node scripts/debug-eval.cjs "(async () => {
  const [entry] = await window.api.libraryList()
  await window.api.removeBook(entry.id)
  return { library: (await window.api.libraryList()).length }
})()"
ls -A "$ACCEPT_ROOT/data/books" 2>/dev/null || echo "no books directory"
```

Expected: `{"library":0}`；`ls` 不再列出该书目录（可能输出 `no books directory` 或空）。

- [ ] **Step 5: 真实文件手工抽查（仅用户执行，执行代理跳过）**

自动化验收已覆盖服务与 IPC；以下 UI 路径需要真实文件与可见窗口，**由用户在真实书库上抽查（不需要覆盖全部）**。执行代理不执行本步骤、不因它未执行而阻塞提交；只在验收记录中标注「待用户手工确认」。清单：

1. 导入同一本书的两个分卷文件 → 出现「可能是同一本书」→ 合并 → 书架一本、章节数相加、书名去掉分卷后缀。
2. 合并前给目标书加书签并读到中间 → 合并后打开，进度和书签仍在。
3. 从资源管理器拖一个 TXT 进窗口 → 虚线遮罩 → 松手导入；拖文件夹/JPG → 有中文提示且不崩溃。
4. 右键卡片 → 查看来源 / 重新清洗 / 重新切章 / 删除各走一遍。
5. 如果有 >50MB 的 TXT → 导入时出现「继续导入/取消」，取消后书架不变。
6. 点「导入 TXT」后在文件选择框点取消 → 不出现「没有导入任何文件」的提示。

- [ ] **Step 6: 停止开发进程并确认数据隔离**

停止后台的 `npm run dev` 进程。确认仓库 `data/` 未被本次验收修改：

```bash
git status --short
```

Expected: 输出为空（此时验收文档还没写；`data/`、`out/` 都已被 `.gitignore` 忽略）。

- [ ] **Step 7: 写验收记录并提交**

新建 `docs/superpowers/acceptance/2026-10-30-reader-library.md`，记录：

```md
# Plan 3 验收记录（2026-10-30）

- 测试：`npm test` 全绿，记录实际用例数
- 类型检查：`npm run typecheck` 通过
- 构建：`npm run build` 通过
- 离屏验收：临时数据目录 `C:/Users/Administrator/AppData/Local/Temp/reader-plan3-acceptance`，未触碰仓库 `data/`
- 合并：两卷 6 章，书名《验收书》，进度 17%，书签 1 条，源书已删除
- 重洗/重切：章节数 6，进度/书签保持
- 右键菜单/来源信息：四个菜单项齐全，来源列出两个文件名
- 删除：书架归零，目录已移除
- 未自动化的 UI：合并对话框、拖拽、50MB 原生确认框、取消文件选择框 —— 待用户按手工清单确认
```

```bash
git add docs/superpowers/acceptance/2026-10-30-reader-library.md
git commit -m "docs: Record Plan 3 acceptance" -m "Capture the automated offscreen run and the manual UI checkpoints
for library governance and import handling."
```

---

## 完成标准

- `npm test`、`npm run typecheck`、`npm run build` 全部通过。
- 书架可右键查看来源、重新清洗、重新切章、删除；删除有二次确认。
- 导入后疑似同书会弹出合并对话框；合并保留进度/书签、删除源书、目标书有备份；重叠章节去重，>50 字的跨章重复段落只保留一份。
- 合并书/重洗/重切后 `source.txt` 与章节行号一致，重洗/重切不会打乱章节；重洗清空正文时中止且不写盘。
- 拖拽 TXT、非 TXT、文件夹、失效路径、取消文件选择框都有正确且不崩溃的行为。
- `library.json` 新增字段对旧数据兼容；并发写不丢条目。
- 未 push；合并回 `main` 由用户决定。
