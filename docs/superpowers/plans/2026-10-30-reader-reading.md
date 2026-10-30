# Reader 阅读体验 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前只能导入的书架变成可以长时间舒适阅读的阅读器：打开书、连续滚动、精确记忆进度、目录跳转、全书搜索、书签、排版与主题。

**Architecture:** 主进程新增 `ReaderService`（打开书、读写进度与书签）和 `SearchService`（逐章搜索）；渲染层从单文件 `App` 拆成 `pages/Library` + `pages/Reader`，阅读页一次性载入全书章节、按章渲染并用 `content-visibility` 控制离屏开销，滚动位置通过 DOM 命中测试换算成「章 + 段 + 百分比」后防抖落盘。设置存 `data/settings.json`，经 IPC 下发并实时驱动 CSS 变量。

**Tech Stack:** Electron 45、TypeScript strict、React 19、electron-vite、Vitest、纯文件存储；无新增运行时依赖。

**Spec:** `docs/superpowers/specs/2026-10-29-pc-reader-design.md`（§5 数据模型、§8 阅读体验、§9 IPC、§10 错误处理）

## Global Constraints

- 运行时依赖只允许 `iconv-lite`；不新增依赖、不引入路由库、不引入状态管理库。
- 无账号、无云同步、无任何联网功能。
- TypeScript strict；`npm run typecheck` 与 `npm test` 每个任务结束都必须通过。
- 测试只测关键行为：core / main 的纯逻辑与仓储；UI 不写自动化测试，靠任务末尾的手动验收清单。
- 提交信息遵循仓库规范（英文祈使句标题 ≤50 字符、正文 ≤72 列、`Related: 无`）。
- 分支名不含 `/`；本计划使用 `dev-reader-reading`。
- 所有用户可见文案用中文；错误提示必须「人能看懂 + 下一步做什么」。
- 数据目录开发环境为 `./data`；书籍目录结构保持 Plan 1 的 `books/<id>/{source.txt,meta.json,chapters/,progress.json}`。
- 开发版已有调试通道：`npm run dev` 打开 CDP 9222，`node scripts/debug-eval.cjs "<expr>"` 可在渲染进程求值。实现者仅可用来做手动验收，不得把它接进产品逻辑。
- 本计划不实现：同书合并执行、重新清洗/切章、删除书籍、打包、拖拽导入（属于 Plan 3）。

## Review Focus

- **章节文件缺失或为空**：打开书时单章读取失败，阅读页必须显示可理解的错误并允许返回书架，不能白屏或抛裸异常。（Task 2 测试 + Task 3 错误 UI）
- **进度锚点在章节标题变化后失效**：`chapterKey` 找不到时必须退回 `chapterIndex`，不能回到开头。（Task 4 的 `resolveChapterIndex` 测试）
- **空书/全零字数**：百分比计算不能出现 `NaN` 或负值。（Task 4 的 `percentAt` 测试）
- **搜索词含正则元字符**：查询 `.*`、`[`、`\` 必须按字面量匹配且不崩溃。（Task 7 测试）
- **超长章节**：单章 20 万字符时滚动与进度保存仍可用；离屏章节不得让滚动定位大幅漂移。（Task 9 手动验收）

### 实现裁决（执行时照此，不再回头改设计）

- **整本载入而非三章窗口**：打开书时一次性读取全部章节文本，渲染时每章用 `content-visibility: auto` 降低离屏布局成本。这样滚动天然连续、进度换算简单。代价：20MB 级超大书内存占用较高；若验收发现明显卡顿，后续可只改阅读页为窗口化加载，IPC 与进度格式不变。
- **搜索每个段落只报第一个命中**：避免同一段重复刷屏；全书上限 300 条与 spec 一致。
- **同一本书的进度与书签写入串行化**：`ReaderService` 按书 id 排队，避免 500ms 防抖保存与书签操作互相覆盖。
- **手动标记、同书合并执行、重新清洗/切章、删除、打包不在本计划**：归入 Plan 3，避免单个计划跨太多子系统。

---

### Task 1: 设置存储、窗口状态与设置 IPC

**Files:**
- Modify: `src/core/model.ts`
- Create: `src/shared/settings.ts`
- Create: `src/main/storage/settings.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Test: `tests/settings.test.ts`

**Interfaces:**
- Consumes: `readJson` / `atomicWriteJson` from `src/main/storage/fsUtil.ts`。
- Produces:
  - `AppSettings`、`ThemeName`、`TypographySettings`（`src/core/model.ts`）
  - `DEFAULT_SETTINGS`、`normalizeSettings(input: unknown): AppSettings`、`mergeSettings(base, patch): AppSettings`、`SettingsPatch`（`src/shared/settings.ts`）
  - `SettingsRepository`（`read(): Promise<AppSettings>`、`update(patch: SettingsPatch): Promise<AppSettings>`）
  - `ReaderApi.getSettings()`、`ReaderApi.updateSettings(patch)`、`ReaderApi.toggleFullscreen()`

- [ ] **Step 1: 在共享模型中加入设置类型**

在 `src/core/model.ts` 末尾追加：

```ts
export type ThemeName = 'light' | 'dark' | 'green' | 'sepia'

export interface TypographySettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  paragraphSpacing: number
  pagePadding: number
  maxContentWidth: number | null
}

export interface AppSettings {
  version: 1
  theme: ThemeName
  typography: TypographySettings
  cleaning: { enabled: boolean; enableUserRules: boolean }
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean }
}
```

- [ ] **Step 2: 写设置默认值与归一化的失败测试**

创建 `tests/settings.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SettingsRepository } from '../src/main/storage/settings'
import { DEFAULT_SETTINGS, mergeSettings, normalizeSettings } from '../src/shared/settings'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-settings-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('normalizeSettings', () => {
  it('returns defaults for missing or invalid input', () => {
    expect(normalizeSettings(null)).toEqual(DEFAULT_SETTINGS)
    expect(normalizeSettings({ theme: 'neon', typography: { fontSize: 999 } })).toMatchObject({
      theme: 'light',
      typography: { fontSize: 36 }
    })
  })

  it('keeps a null max width and merges nested patches', () => {
    expect(normalizeSettings({ typography: { maxContentWidth: null } }).typography.maxContentWidth).toBeNull()
    const merged = mergeSettings(DEFAULT_SETTINGS, { typography: { fontSize: 22 } })
    expect(merged.typography.fontSize).toBe(22)
    expect(merged.typography.lineHeight).toBe(DEFAULT_SETTINGS.typography.lineHeight)
  })
})

describe('SettingsRepository', () => {
  it('persists updates and merges nested patches', async () => {
    const repo = new SettingsRepository(root)
    expect(await repo.read()).toEqual(DEFAULT_SETTINGS)
    await repo.update({ theme: 'dark', typography: { lineHeight: 2 } })
    const stored = await repo.read()
    expect(stored.theme).toBe('dark')
    expect(stored.typography.lineHeight).toBe(2)
    expect(stored.typography.fontSize).toBe(DEFAULT_SETTINGS.typography.fontSize)
  })
})
```

- [ ] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/settings.test.ts`
Expected: FAIL — `Cannot find module '../src/shared/settings'` 或 `SettingsRepository` 未定义。

- [ ] **Step 4: 实现共享设置模块**

创建 `src/shared/settings.ts`：

```ts
import type { AppSettings, ThemeName } from '../core/model'

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: 'light',
  typography: {
    fontFamily: "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
    fontSize: 18,
    lineHeight: 1.8,
    paragraphSpacing: 0.8,
    pagePadding: 32,
    maxContentWidth: 860
  },
  cleaning: { enabled: true, enableUserRules: true },
  window: { width: 1200, height: 800, maximized: false }
}

const THEMES: ThemeName[] = ['light', 'dark', 'green', 'sepia']

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export interface SettingsPatch {
  theme?: ThemeName
  typography?: Partial<AppSettings['typography']>
  cleaning?: Partial<AppSettings['cleaning']>
  window?: Partial<AppSettings['window']>
}

export function normalizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>
  const typography = (raw.typography ?? {}) as Partial<AppSettings['typography']>
  const cleaning = (raw.cleaning ?? {}) as Partial<AppSettings['cleaning']>
  const windowState = (raw.window ?? {}) as Partial<AppSettings['window']>
  const maxWidth = typography.maxContentWidth

  return {
    version: 1,
    theme: THEMES.includes(raw.theme as ThemeName) ? (raw.theme as ThemeName) : DEFAULT_SETTINGS.theme,
    typography: {
      fontFamily:
        typeof typography.fontFamily === 'string' && typography.fontFamily.trim()
          ? typography.fontFamily
          : DEFAULT_SETTINGS.typography.fontFamily,
      fontSize: clamp(typography.fontSize, 12, 36, DEFAULT_SETTINGS.typography.fontSize),
      lineHeight: clamp(typography.lineHeight, 1.2, 2.5, DEFAULT_SETTINGS.typography.lineHeight),
      paragraphSpacing: clamp(
        typography.paragraphSpacing,
        0,
        2,
        DEFAULT_SETTINGS.typography.paragraphSpacing
      ),
      pagePadding: clamp(typography.pagePadding, 0, 120, DEFAULT_SETTINGS.typography.pagePadding),
      maxContentWidth:
        maxWidth === null
          ? null
          : clamp(maxWidth, 400, 2400, DEFAULT_SETTINGS.typography.maxContentWidth ?? 860)
    },
    cleaning: {
      enabled: typeof cleaning.enabled === 'boolean' ? cleaning.enabled : DEFAULT_SETTINGS.cleaning.enabled,
      enableUserRules:
        typeof cleaning.enableUserRules === 'boolean'
          ? cleaning.enableUserRules
          : DEFAULT_SETTINGS.cleaning.enableUserRules
    },
    window: {
      width: clamp(windowState.width, 800, 3840, DEFAULT_SETTINGS.window.width),
      height: clamp(windowState.height, 600, 2160, DEFAULT_SETTINGS.window.height),
      x:
        typeof windowState.x === 'number' && Number.isFinite(windowState.x)
          ? windowState.x
          : undefined,
      y:
        typeof windowState.y === 'number' && Number.isFinite(windowState.y)
          ? windowState.y
          : undefined,
      maximized: typeof windowState.maximized === 'boolean' ? windowState.maximized : false
    }
  }
}

export function mergeSettings(base: AppSettings, patch: SettingsPatch): AppSettings {
  return normalizeSettings({
    ...base,
    ...patch,
    typography: { ...base.typography, ...patch.typography },
    cleaning: { ...base.cleaning, ...patch.cleaning },
    window: { ...base.window, ...patch.window }
  })
}
```

- [ ] **Step 5: 实现设置仓储**

创建 `src/main/storage/settings.ts`：

```ts
import { join } from 'node:path'
import type { AppSettings } from '../../core/model'
import { mergeSettings, normalizeSettings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import { atomicWriteJson, readJson } from './fsUtil'

export class SettingsRepository {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'settings.json')
  }

  async read(): Promise<AppSettings> {
    return normalizeSettings(await readJson<unknown>(this.file))
  }

  async update(patch: SettingsPatch): Promise<AppSettings> {
    const next = mergeSettings(await this.read(), patch)
    await atomicWriteJson(this.file, next)
    return next
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/settings.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 7: 扩展 IPC 契约与 preload**

把 `src/shared/api.ts` 顶部现有的 `import type { LibraryEntry } from '../core/model'` 替换为：

```ts
import type { AppSettings, BookMeta, Bookmark, BookProgress, LibraryEntry } from '../core/model'
import type { SettingsPatch } from './settings'
```

并在文件内加入接口：

```ts
export interface OpenBookPayload {
  meta: BookMeta
  chapters: string[]
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export interface NewBookmark {
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
}
```

在 `ReaderApi` 中加入：

```ts
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  toggleFullscreen(): Promise<boolean>
```

（`openBook` / 进度 / 书签 / 搜索方法在 Task 2、Task 7 再加。）

在 `src/preload/index.ts` 的 `api` 对象中加入：

```ts
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
```

- [ ] **Step 8: 主进程接入设置与窗口状态**

在 `src/main/index.ts` 中：

1. 导入：

```ts
import type { AppSettings } from '../core/model'
import { SettingsRepository } from './storage/settings'
```

2. 在 `const importer = ...` 后加入：

```ts
const settingsRepo = new SettingsRepository(dataDir)
```

3. 把 `createWindow` 改为接收窗口状态：

```ts
function createWindow(windowState: AppSettings['window']): void {
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: windowState.x,
    y: windowState.y,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (windowState.maximized) win.maximize()
  win.on('close', () => {
    const bounds = win.getNormalBounds()
    void settingsRepo.update({ window: { ...bounds, maximized: win.isMaximized() } })
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}
```

4. `app.whenReady()` 改为异步并读取设置：

```ts
app.whenReady().then(async () => {
  const settings = await settingsRepo.read()

  ipcMain.handle('app:ping', () => 'pong')
  ipcMain.handle('settings:get', () => settingsRepo.read())
  ipcMain.handle('settings:update', (_event, patch: SettingsPatch) => settingsRepo.update(patch))
  ipcMain.handle('window:toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const next = !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })
  // ... 保留现有 library:list / library:choose-import / debug:import 处理 ...

  createWindow(settings.window)
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void settingsRepo.read().then((s) => createWindow(s.window))
})
```

导入 `SettingsPatch` 类型：

```ts
import type { SettingsPatch } from '../shared/settings'
```

5. 原有 `app.on('activate')` 中的 `createWindow()` 调用必须同步改掉，不能保留无参版本。

- [ ] **Step 9: 运行全量检查**

Run: `npm run typecheck && npm test`
Expected: 全部通过（原 71 条 + 新增 3 条）。

- [ ] **Step 10: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
Expected: 窗口按上次大小打开；关闭再开位置/大小保持；`data/settings.json` 出现且含默认值。用 `node scripts/debug-eval.cjs "window.api.getSettings()"` 能看到对象。

- [ ] **Step 11: 提交**

```bash
git add src/core/model.ts src/shared/settings.ts src/main/storage/settings.ts src/main/index.ts src/shared/api.ts src/preload/index.ts tests/settings.test.ts
git commit -m "feat(settings): Persist settings and bounds" -m "Reader preferences and the window bounds need to survive restarts before
the reading page can depend on them.

- Add normalized AppSettings with defaults and nested patch merging
- Store settings.json through SettingsRepository
- Restore window bounds on launch and save them on close
- Expose settings and fullscreen toggling over IPC

Related: 无"
```

---

### Task 2: 打开书籍、进度与书签服务

**Files:**
- Create: `src/main/services/reader.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Test: `tests/reader-service.test.ts`

**Interfaces:**
- Consumes: `LibraryRepository`、`BookRepository`、`SettingsRepository`（Task 1 已存在）。
- Produces:
  - `ReaderService.open(id): Promise<OpenBookPayload>`
  - `ReaderService.saveProgress(id, progress): Promise<void>`
  - `ReaderService.addBookmark(id, input: NewBookmark): Promise<Bookmark[]>`
  - `ReaderService.removeBookmark(id, bookmarkId): Promise<Bookmark[]>`
  - `ReaderApi.openBook(id)`、`saveProgress(id, progress)`、`addBookmark(id, input)`、`removeBookmark(id, bookmarkId)`
  - IPC：`book:open`、`progress:save`、`bookmark:add`、`bookmark:remove`

- [ ] **Step 1: 写 ReaderService 的失败测试**

创建 `tests/reader-service.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ReaderService } from '../src/main/services/reader'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import type { BookMeta, LibraryEntry } from '../src/core/model'

let root = ''
let library: LibraryRepository
let books: BookRepository
let service: ReaderService

const bookId = 'book-1'

function meta(): BookMeta {
  return {
    version: 1,
    id: bookId,
    title: '测试书',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'hash-1', startLine: 0, charCount: 6, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'hash-2', startLine: 2, charCount: 6, simhash: '2', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function entry(): LibraryEntry {
  return {
    id: bookId,
    title: '测试书',
    normalizedTitle: '测试书',
    sourceFileName: '测试书.txt',
    fileHash: 'hash',
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount: 2,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-reader-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  service = new ReaderService(library, books)
  await books.writeBook({
    meta: meta(),
    sourceText: '第一章\n第一段。\n第二章\n第二段。',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。', '另一段。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
    ]
  })
  await library.add(entry())
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('ReaderService', () => {
  it('opens a book with aligned chapter text and empty progress', async () => {
    const payload = await service.open(bookId)
    expect(payload.meta.title).toBe('测试书')
    expect(payload.chapters).toEqual(['第一段。\n\n另一段。', '第二段。'])
    expect(payload.progress).toBeNull()
    expect(payload.bookmarks).toEqual([])
  })

  it('saves progress and updates the library entry', async () => {
    await service.saveProgress(bookId, {
      chapterKey: 'hash-2',
      chapterIndex: 1,
      paragraphIndex: 0,
      percent: 66.67,
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    expect((await books.readProgress(bookId)).progress?.percent).toBe(66.67)
    const stored = (await library.list())[0]
    expect(stored.progressPercent).toBe(66.67)
    expect(stored.lastReadAt).toBe('2026-01-02T00:00:00.000Z')
  })

  it('adds and removes bookmarks without losing progress', async () => {
    await service.saveProgress(bookId, {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      percent: 10,
      updatedAt: '2026-01-02T00:00:00.000Z'
    })

    const bookmarks = await service.addBookmark(bookId, {
      chapterKey: 'hash-1',
      chapterIndex: 0,
      paragraphIndex: 1,
      excerpt: '另一段。'
    })
    expect(bookmarks).toHaveLength(1)
    expect((await service.open(bookId)).progress?.percent).toBe(10)

    const remaining = await service.removeBookmark(bookId, bookmarks[0].id)
    expect(remaining).toEqual([])
    expect((await service.open(bookId)).bookmarks).toEqual([])
  })

  it('rejects a missing chapter file with a readable error', async () => {
    const payload = await service.open(bookId)
    await rm(join(root, 'books', bookId, 'chapters', '00001.txt'))
    expect(payload.chapters).toHaveLength(2)
    await expect(service.open(bookId)).rejects.toThrow('章节文件缺失')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/reader-service.test.ts`
Expected: FAIL — `Cannot find module '../src/main/services/reader'`。

- [ ] **Step 3: 实现 ReaderService**

创建 `src/main/services/reader.ts`：

```ts
import { randomUUID } from 'node:crypto'
import type { Bookmark, BookProgress } from '../../core/model'
import type { NewBookmark, OpenBookPayload } from '../../shared/api'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

function assertBookId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('无效的书籍编号')
}

export class ReaderService {
  private readonly locks = new Map<string, Promise<unknown>>()

  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  private async locked<T>(id: string, task: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(id) ?? Promise.resolve()
    const run = previous.then(task, task)
    this.locks.set(
      id,
      run.catch(() => undefined)
    )
    return run
  }

  async open(id: string): Promise<OpenBookPayload> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const chapters: string[] = []
    for (const chapter of meta.chapters) {
      try {
        chapters.push(await this.books.readChapter(id, chapter.index))
      } catch {
        throw new Error(`章节文件缺失：${chapter.title}`)
      }
    }
    const stored = await this.books.readProgress(id)
    return { meta, chapters, progress: stored.progress, bookmarks: stored.bookmarks }
  }

  async saveProgress(id: string, progress: BookProgress): Promise<void> {
    assertBookId(id)
    await this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      await this.books.writeProgress(id, { progress, bookmarks: stored.bookmarks })
      await this.library.update(id, {
        progressPercent: progress.percent,
        lastReadAt: progress.updatedAt
      })
    })
  }

  async addBookmark(id: string, input: NewBookmark): Promise<Bookmark[]> {
    assertBookId(id)
    return this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      const bookmark: Bookmark = {
        id: randomUUID(),
        chapterKey: input.chapterKey,
        chapterIndex: input.chapterIndex,
        paragraphIndex: input.paragraphIndex,
        excerpt: input.excerpt,
        createdAt: new Date().toISOString()
      }
      const bookmarks = [...stored.bookmarks, bookmark]
      await this.books.writeProgress(id, { progress: stored.progress, bookmarks })
      return bookmarks
    })
  }

  async removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]> {
    assertBookId(id)
    return this.locked(id, async () => {
      const stored = await this.books.readProgress(id)
      const bookmarks = stored.bookmarks.filter((bookmark) => bookmark.id !== bookmarkId)
      await this.books.writeProgress(id, { progress: stored.progress, bookmarks })
      return bookmarks
    })
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/reader-service.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 5: 扩展 API 类型与 preload**

在 `src/shared/api.ts` 的 `ReaderApi` 中加入（`OpenBookPayload` / `NewBookmark` 在 Task 1 已定义）：

```ts
  openBook(id: string): Promise<OpenBookPayload>
  saveProgress(id: string, progress: BookProgress): Promise<void>
  addBookmark(id: string, bookmark: NewBookmark): Promise<Bookmark[]>
  removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]>
```

在 `src/preload/index.ts` 加入：

```ts
  openBook: (id) => ipcRenderer.invoke('book:open', id),
  saveProgress: (id, progress) => ipcRenderer.invoke('progress:save', id, progress),
  addBookmark: (id, bookmark) => ipcRenderer.invoke('bookmark:add', id, bookmark),
  removeBookmark: (id, bookmarkId) => ipcRenderer.invoke('bookmark:remove', id, bookmarkId),
```

- [ ] **Step 6: 主进程注册 IPC**

在 `src/main/index.ts` 导入并实例化：

```ts
import { ReaderService } from './services/reader'

const reader = new ReaderService(library, books)
```

在 `app.whenReady()` 内加入：

```ts
  ipcMain.handle('book:open', (_event, id: string) => reader.open(id))
  ipcMain.handle('progress:save', (_event, id: string, progress: BookProgress) =>
    reader.saveProgress(id, progress)
  )
  ipcMain.handle('bookmark:add', (_event, id: string, bookmark: NewBookmark) =>
    reader.addBookmark(id, bookmark)
  )
  ipcMain.handle('bookmark:remove', (_event, id: string, bookmarkId: string) =>
    reader.removeBookmark(id, bookmarkId)
  )
```

类型导入：

```ts
import type { BookProgress } from '../core/model'
import type { NewBookmark } from '../shared/api'
```

- [ ] **Step 7: 全量检查**

Run: `npm run typecheck && npm test`
Expected: 通过（原 74 条 + 新增 4 条 = 78 条）。

- [ ] **Step 8: 用真实书手动验证**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`，然后：

```bash
node scripts/debug-eval.cjs "window.api.libraryList().then(list => window.api.openBook(list[0].id)).then(b => ({ title: b.meta.title, chapters: b.chapters.length, first: b.chapters[0].slice(0, 20) }))"
```

Expected: 返回书名、章节数、首章开头，无异常。

- [ ] **Step 9: 提交**

```bash
git add src/main/services/reader.ts src/main/index.ts src/shared/api.ts src/preload/index.ts tests/reader-service.test.ts
git commit -m "feat(reader): Add reader data services" -m "The reading page needs chapter text plus a durable place to keep its
position and bookmarks.

- Add ReaderService with per-book write serialization
- Align chapter text with meta.chapters and report missing files
- Persist progress into progress.json and mirror it to the library index
- Expose open, progress and bookmark operations over IPC

Related: 无"
```

---

### Task 3: 应用外壳、书架页与阅读页渲染

**Files:**
- Create: `src/renderer/src/pages/Library.tsx`
- Create: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `AppSettings` / `SettingsPatch` / `mergeSettings`；Task 2 的 `openBook`。
- Produces:
  - `App` 负责 `view: 'library' | 'reader'` 与 settings 状态
  - `Library({ onOpen: (bookId: string) => void })`
  - `Reader({ bookId, settings, onSettingsChange, onBack })`（本任务只渲染；进度、目录、搜索、书签在后续任务接入）

- [ ] **Step 1: 新建书架页**

创建 `src/renderer/src/pages/Library.tsx`，把现有 `App.tsx` 的书架逻辑整体搬入，并加排序与点击打开：

```tsx
import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'

type SortMode = 'recent' | 'imported' | 'title'

const SORTERS: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
  recent: (a, b) => (b.lastReadAt ?? b.importedAt).localeCompare(a.lastReadAt ?? a.importedAt),
  imported: (a, b) => b.importedAt.localeCompare(a.importedAt),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function Library({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')

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
      setToast({
        id: Date.now(),
        text: parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件'
      })
      await refresh()
    } finally {
      setBusy(false)
      setProgress('')
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
            <button className="card" key={entry.id} onClick={() => onOpen(entry.id)}>
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
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 新建阅读页的渲染骨架**

创建 `src/renderer/src/pages/Reader.tsx`：

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../../core/model'
import type { OpenBookPayload } from '../../../shared/api'
import type { SettingsPatch } from '../../../shared/settings'

interface ReaderProps {
  bookId: string
  settings: AppSettings
  onSettingsChange: (patch: SettingsPatch) => void
  onBack: () => void
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

export default function Reader({ bookId, onBack }: ReaderProps) {
  const [book, setBook] = useState<OpenBookPayload | null>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let alive = true
    setBook(null)
    setError('')
    window.api
      .openBook(bookId)
      .then((payload) => {
        if (alive) setBook(payload)
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [bookId])

  const chapters = useMemo(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => ({
      meta,
      paragraphs: splitParagraphs(book.chapters[index] ?? '')
    }))
  }, [book])

  if (error) {
    return (
      <div className="reader-error">
        <p>这本书打不开了：{error}</p>
        <button onClick={onBack}>返回书架</button>
      </div>
    )
  }

  if (!book) {
    return <p className="loading">正在打开…</p>
  }

  return (
    <div className="reader">
      <header className="reader-toolbar">
        <button className="ghost" onClick={onBack}>
          ← 书架
        </button>
        <span className="reader-title" title={book.meta.title}>
          {book.meta.title}
        </span>
      </header>

      <main className="reader-scroll" ref={scrollRef}>
        <article className="reader-page">
          {chapters.map((chapter, chapterIndex) => (
            <section
              key={chapter.meta.index}
              className={`reader-chapter ${chapter.meta.level}`}
              data-chapter-section={chapterIndex}
            >
              <h2 className="chapter-title">{chapter.meta.title}</h2>
              {chapter.paragraphs.map((text, paragraphIndex) => (
                <p
                  key={paragraphIndex}
                  className="reader-paragraph"
                  data-chapter-index={chapterIndex}
                  data-paragraph-index={paragraphIndex}
                >
                  {text}
                </p>
              ))}
            </section>
          ))}
        </article>
      </main>
    </div>
  )
}
```

注：`ReaderProps` 里的 `settings` / `onSettingsChange` 已声明但本任务未使用，Task 5 接入；`tsc` 对未使用参数不报错（`noUnusedParameters` 未开启）。

- [ ] **Step 3: 重写 App 为视图切换**

替换 `src/renderer/src/App.tsx` 为：

```tsx
import { useEffect, useState } from 'react'
import type { AppSettings } from '../../core/model'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import Library from './pages/Library'
import Reader from './pages/Reader'

type View = { name: 'library' } | { name: 'reader'; bookId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
  }, [])

  const updateSettings = (patch: SettingsPatch): void => {
    setSettings((current) => mergeSettings(current, patch))
    void window.api.updateSettings(patch).catch(() => undefined)
  }

  if (view.name === 'reader') {
    return (
      <Reader
        bookId={view.bookId}
        settings={settings}
        onSettingsChange={updateSettings}
        onBack={() => setView({ name: 'library' })}
      />
    )
  }

  return <Library onOpen={(bookId) => setView({ name: 'reader', bookId })} />
}
```

- [ ] **Step 4: 补充阅读页样式**

在 `src/renderer/src/styles.css` 末尾追加：

```css
.toolbar-actions { display: flex; align-items: center; gap: 10px; }
.sort-select {
  border: 1px solid #d8d3c8;
  background: #fff;
  color: #2b2b2b;
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
}
.card {
  border: none;
  text-align: left;
  cursor: pointer;
  font: inherit;
  color: inherit;
  width: 100%;
}
.card:hover { box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12); }
.sub.warn { color: #a45b2a; }

.reader {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: #f5f3ee;
}
.reader-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  background: rgba(245, 243, 238, 0.94);
  border-bottom: 1px solid #e2ddd2;
  z-index: 20;
}
.reader-toolbar .ghost {
  border: none;
  background: transparent;
  color: #4a6741;
  font-size: 14px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
}
.reader-toolbar .ghost:hover { background: rgba(74, 103, 65, 0.1); }
.reader-title {
  font-size: 14px;
  color: #6b6b6b;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.reader-scroll {
  flex: 1 1 auto;
  overflow-y: auto;
  scroll-behavior: auto;
}
.reader-page {
  max-width: 860px;
  margin: 0 auto;
  padding: 24px 32px 120px;
  font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;
  font-size: 18px;
  line-height: 1.8;
  color: #2b2b2b;
}
.reader-chapter {
  content-visibility: auto;
  contain-intrinsic-size: auto 600px;
}
.chapter-title {
  font-size: 1.25em;
  margin: 1.6em 0 0.8em;
  font-weight: 600;
}
.reader-chapter.volume .chapter-title {
  margin-top: 2.4em;
  padding-bottom: 0.3em;
  border-bottom: 1px solid rgba(0, 0, 0, 0.12);
}
.reader-paragraph {
  margin: 0 0 0.8em;
  text-indent: 2em;
  overflow-wrap: break-word;
}
.chapter-title { scroll-margin-top: 64px; }
.reader-paragraph { scroll-margin-top: 64px; }
.loading { color: #8a8a8a; padding: 48px; text-align: center; }
.reader-error { padding: 64px 32px; text-align: center; color: #8a3b2e; }
.reader-error button {
  margin-top: 16px;
  border: none;
  background: #4a6741;
  color: #fff;
  padding: 8px 18px;
  border-radius: 6px;
  cursor: pointer;
}
```

- [ ] **Step 5: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 书架按「最近阅读」排序，可切排序方式；
2. 点击任一真实书籍进入阅读页，章节标题与正文正常，滚动流畅；
3. 滚动到很远再返回书架，再进入，能从头正常显示（进度恢复在 Task 4）；
4. 点击「← 书架」返回。

- [ ] **Step 6: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（78 条）。

```bash
git add src/renderer/src/pages/Library.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/App.tsx src/renderer/src/styles.css
git commit -m "feat(ui): Add library sorting and reader shell" -m "The app was still a single bookshelf screen, so there was nowhere to
actually read a book.

- Extract the bookshelf into pages/Library with sorting and open action
- Render every chapter and paragraph in a scrollable reader page
- Route between library and reader through local view state
- Show a readable error when a book cannot be opened

Related: 无"
```

---

### Task 4: 进度定位、恢复与底部进度条

**Files:**
- Create: `src/renderer/src/reader/position.ts`
- Create: `src/renderer/src/components/ProgressBar.tsx`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/position.test.ts`

**Interfaces:**
- Consumes: `BookMeta`、`BookProgress`；Task 2 的 `saveProgress`；Task 3 的 `Reader`。
- Produces:
  - `chapterCharStarts(meta)`、`totalChars(meta)`、`charsBefore(meta, chapterIndex, paragraphIndex, paragraphs)`、`percentAt(...)`、`chapterIndexForPercent(meta, percent)`、`resolveChapterIndex(meta, chapterKey, fallback)`
  - `ProgressBar({ percent, chapterIndex, chapterCount, remainingMinutes, onSeek })`

- [ ] **Step 1: 写位置换算的失败测试**

创建 `tests/position.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import type { BookMeta } from '../src/core/model'
import {
  chapterCharStarts,
  chapterIndexForPercent,
  charsBefore,
  percentAt,
  resolveChapterIndex,
  totalChars
} from '../src/renderer/src/reader/position'

function meta(): BookMeta {
  return {
    version: 1,
    id: 'b',
    title: '书',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'h1', startLine: 0, charCount: 10, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'h2', startLine: 2, charCount: 10, simhash: '2', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

const paragraphs = [['12345', '12345'], ['12345']]

describe('reader position', () => {
  it('maps chapters to cumulative character offsets', () => {
    expect(chapterCharStarts(meta())).toEqual([0, 10])
    expect(totalChars(meta())).toBe(20)
    expect(charsBefore(meta(), 0, 1, paragraphs)).toBe(5)
    expect(charsBefore(meta(), 1, 0, paragraphs)).toBe(10)
    expect(percentAt(meta(), 0, 1, paragraphs)).toBe(25)
    expect(percentAt(meta(), 1, 0, paragraphs)).toBe(50)
  })

  it('returns zero percent for a book without characters', () => {
    const empty: BookMeta = { ...meta(), chapters: [] }
    expect(totalChars(empty)).toBe(0)
    expect(percentAt(empty, 0, 0, [])).toBe(0)
    expect(chapterIndexForPercent(empty, 50)).toBe(0)
  })

  it('locates a chapter by percentage', () => {
    expect(chapterIndexForPercent(meta(), 0)).toBe(0)
    expect(chapterIndexForPercent(meta(), 60)).toBe(1)
    expect(chapterIndexForPercent(meta(), 100)).toBe(1)
  })

  it('prefers the title hash and falls back to the chapter index', () => {
    expect(resolveChapterIndex(meta(), 'h2', 0)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', 1)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', 99)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', -5)).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/position.test.ts`
Expected: FAIL — `Cannot find module '../src/renderer/src/reader/position'`。

- [ ] **Step 3: 实现位置换算**

创建 `src/renderer/src/reader/position.ts`：

```ts
import type { BookMeta } from '../../../core/model'

export function chapterCharStarts(meta: BookMeta): number[] {
  const starts: number[] = []
  let total = 0
  for (const chapter of meta.chapters) {
    starts.push(total)
    total += chapter.charCount
  }
  return starts
}

export function totalChars(meta: BookMeta): number {
  return meta.chapters.reduce((sum, chapter) => sum + chapter.charCount, 0)
}

export function charsBefore(
  meta: BookMeta,
  chapterIndex: number,
  paragraphIndex: number,
  paragraphs: string[][]
): number {
  const start = chapterCharStarts(meta)[chapterIndex] ?? 0
  const within = (paragraphs[chapterIndex] ?? [])
    .slice(0, paragraphIndex)
    .reduce((sum, text) => sum + text.length, 0)
  return start + within
}

export function percentAt(
  meta: BookMeta,
  chapterIndex: number,
  paragraphIndex: number,
  paragraphs: string[][]
): number {
  const total = totalChars(meta)
  if (total <= 0) return 0
  const percent = (charsBefore(meta, chapterIndex, paragraphIndex, paragraphs) / total) * 100
  return Math.min(100, Math.max(0, Math.round(percent * 100) / 100))
}

export function chapterIndexForPercent(meta: BookMeta, percent: number): number {
  const total = totalChars(meta)
  if (total <= 0) return 0
  const target = (Math.min(100, Math.max(0, percent)) / 100) * total
  const starts = chapterCharStarts(meta)
  let index = 0
  while (index + 1 < starts.length && starts[index + 1] <= target) index++
  return index
}

export function resolveChapterIndex(meta: BookMeta, chapterKey: string, fallback: number): number {
  const found = meta.chapters.findIndex((chapter) => chapter.titleHash === chapterKey)
  const index = found >= 0 ? found : fallback
  if (meta.chapters.length === 0) return 0
  return Math.min(Math.max(index, 0), meta.chapters.length - 1)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/position.test.ts`
Expected: PASS（4 条）。

- [ ] **Step 5: 实现底部进度条组件**

创建 `src/renderer/src/components/ProgressBar.tsx`：

```tsx
interface ProgressBarProps {
  percent: number
  chapterIndex: number
  chapterCount: number
  remainingMinutes: number
  onSeek: (percent: number) => void
}

export default function ProgressBar({
  percent,
  chapterIndex,
  chapterCount,
  remainingMinutes,
  onSeek
}: ProgressBarProps) {
  return (
    <footer className="progress-bar">
      <span className="progress-chapter">
        第 {Math.min(chapterIndex + 1, chapterCount)} / {chapterCount} 章
      </span>
      <input
        className="progress-range"
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={percent}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="阅读进度"
      />
      <span className="progress-percent">{percent.toFixed(1)}%</span>
      <span className="progress-remaining">约剩 {remainingMinutes} 分钟</span>
    </footer>
  )
}
```

- [ ] **Step 6: 把进度接入阅读页**

修改 `src/renderer/src/pages/Reader.tsx`。完整替换为：

```tsx
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings, BookMeta, BookProgress } from '../../../core/model'
import type { OpenBookPayload } from '../../../shared/api'
import type { SettingsPatch } from '../../../shared/settings'
import ProgressBar from '../components/ProgressBar'
import {
  chapterIndexForPercent,
  charsBefore,
  percentAt,
  resolveChapterIndex,
  totalChars
} from '../reader/position'

interface ReaderProps {
  bookId: string
  settings: AppSettings
  onSettingsChange: (patch: SettingsPatch) => void
  onBack: () => void
}

interface ChapterView {
  meta: BookMeta['chapters'][number]
  paragraphs: string[]
}

interface CurrentPosition {
  chapterIndex: number
  paragraphIndex: number
  percent: number
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

const ReaderBody = memo(function ReaderBody({ chapters }: { chapters: ChapterView[] }) {
  return (
    <article className="reader-page">
      {chapters.map((chapter, chapterIndex) => (
        <section
          key={chapter.meta.index}
          className={`reader-chapter ${chapter.meta.level}`}
          data-chapter-section={chapterIndex}
        >
          <h2 className="chapter-title">{chapter.meta.title}</h2>
          {chapter.paragraphs.map((text, paragraphIndex) => (
            <p
              key={paragraphIndex}
              className="reader-paragraph"
              data-chapter-index={chapterIndex}
              data-paragraph-index={paragraphIndex}
            >
              {text}
            </p>
          ))}
        </section>
      ))}
    </article>
  )
})

export default function Reader({ bookId, settings, onBack }: ReaderProps) {
  const [book, setBook] = useState<OpenBookPayload | null>(null)
  const [error, setError] = useState('')
  const [current, setCurrent] = useState<CurrentPosition>({ chapterIndex: 0, paragraphIndex: 0, percent: 0 })
  const scrollRef = useRef<HTMLElement | null>(null)
  const restoredRef = useRef(false)
  const rafRef = useRef(0)
  const pendingRef = useRef<BookProgress | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    setBook(null)
    setError('')
    restoredRef.current = false
    window.api
      .openBook(bookId)
      .then((payload) => {
        if (alive) setBook(payload)
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [bookId])

  const chapters = useMemo<ChapterView[]>(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => ({
      meta,
      paragraphs: splitParagraphs(book.chapters[index] ?? '')
    }))
  }, [book])

  const paragraphs = useMemo(() => chapters.map((chapter) => chapter.paragraphs), [chapters])

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) void window.api.saveProgress(bookId, pending).catch(() => undefined)
  }, [bookId])

  const scheduleSave = useCallback(
    (position: CurrentPosition): void => {
      if (!book) return
      pendingRef.current = {
        chapterKey: book.meta.chapters[position.chapterIndex]?.titleHash ?? '',
        chapterIndex: position.chapterIndex,
        paragraphIndex: position.paragraphIndex,
        percent: position.percent,
        updatedAt: new Date().toISOString()
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, 500)
    },
    [book, flush]
  )

  const scrollToPosition = useCallback((chapterIndex: number, paragraphIndex: number): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const paragraph = scroller.querySelector<HTMLElement>(
      `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
    )
    if (paragraph) {
      paragraph.scrollIntoView({ block: 'start' })
      return
    }
    const section = scroller.querySelector<HTMLElement>(`[data-chapter-section="${chapterIndex}"]`)
    section?.scrollIntoView({ block: 'start' })
  }, [])

  const currentPosition = useCallback((): { chapterIndex: number; paragraphIndex: number } | null => {
    const scroller = scrollRef.current
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + 88

    for (const element of document.elementsFromPoint(x, y)) {
      const paragraph = element.closest<HTMLElement>('[data-paragraph-index]')
      if (paragraph) {
        return {
          chapterIndex: Number(paragraph.dataset.chapterIndex),
          paragraphIndex: Number(paragraph.dataset.paragraphIndex)
        }
      }
      const section = element.closest<HTMLElement>('[data-chapter-section]')
      if (section) {
        return { chapterIndex: Number(section.dataset.chapterSection), paragraphIndex: 0 }
      }
    }

    const sections = scroller.querySelectorAll<HTMLElement>('[data-chapter-section]')
    let nearest = 0
    sections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= y) nearest = index
    })
    return { chapterIndex: nearest, paragraphIndex: 0 }
  }, [])

  const handleScroll = useCallback((): void => {
    if (rafRef.current !== 0) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      if (!book) return
      const position = currentPosition()
      if (!position) return
      const percent = percentAt(book.meta, position.chapterIndex, position.paragraphIndex, paragraphs)
      const next = { ...position, percent }
      setCurrent(next)
      scheduleSave(next)
    })
  }, [book, currentPosition, paragraphs, scheduleSave])

  useEffect(() => {
    if (!book || chapters.length === 0 || restoredRef.current) return
    restoredRef.current = true
    const saved = book.progress
    const chapterIndex = saved
      ? resolveChapterIndex(book.meta, saved.chapterKey, saved.chapterIndex)
      : 0
    const paragraphIndex = saved?.paragraphIndex ?? 0
    const percent = percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
    const next = { chapterIndex, paragraphIndex, percent }
    setCurrent(next)
    scheduleSave(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollToPosition(chapterIndex, paragraphIndex))
    })
  }, [book, chapters.length, paragraphs, scheduleSave, scrollToPosition])

  useEffect(() => {
    return () => flush()
  }, [flush])

  const seek = (percent: number): void => {
    if (!book) return
    const chapterIndex = chapterIndexForPercent(book.meta, percent)
    const next = { chapterIndex, paragraphIndex: 0, percent }
    setCurrent(next)
    scheduleSave(next)
    scrollToPosition(chapterIndex, 0)
  }

  if (error) {
    return (
      <div className="reader-error">
        <p>这本书打不开了：{error}</p>
        <button onClick={onBack}>返回书架</button>
      </div>
    )
  }

  if (!book) {
    return <p className="loading">正在打开…</p>
  }

  const total = totalChars(book.meta)
  const read = charsBefore(book.meta, current.chapterIndex, current.paragraphIndex, paragraphs)
  const remainingMinutes = Math.max(0, Math.ceil((total - read) / 400))

  return (
    <div className="reader">
      <header className="reader-toolbar">
        <button className="ghost" onClick={onBack}>
          ← 书架
        </button>
        <span className="reader-title" title={book.meta.title}>
          {book.meta.title}
        </span>
      </header>

      <main className="reader-scroll" ref={scrollRef} onScroll={handleScroll}>
        <ReaderBody chapters={chapters} />
      </main>

      <ProgressBar
        percent={current.percent}
        chapterIndex={current.chapterIndex}
        chapterCount={book.meta.chapters.length}
        remainingMinutes={remainingMinutes}
        onSeek={seek}
      />
    </div>
  )
}
```

说明：`settings` / `onSettingsChange` 在本任务仍未使用，Task 5 接入，`tsc` 不会因未使用参数报错。

- [ ] **Step 7: 补进度条样式，给阅读区留出底部空间**

在 `src/renderer/src/styles.css` 的 `.reader-page` 规则中，把 `padding: 24px 32px 120px;` 改为 `padding: 24px 32px 140px;`，并追加：

```css
.progress-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  background: rgba(245, 243, 238, 0.96);
  border-top: 1px solid #e2ddd2;
  font-size: 12px;
  color: #6b6b6b;
}
.progress-chapter { flex: 0 0 auto; white-space: nowrap; }
.progress-range { flex: 1 1 auto; accent-color: #4a6741; cursor: pointer; }
.progress-percent { flex: 0 0 52px; text-align: right; font-variant-numeric: tabular-nums; }
.progress-remaining { flex: 0 0 auto; white-space: nowrap; color: #8a8a8a; }
```

- [ ] **Step 8: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 打开一本真实书，滚动若干屏后底部百分比与「第 x / y 章」变化；
2. 关闭应用重开，进入同一本书，回到上次段落附近；
3. 拖动底部滑块到 60%，正文跳到对应位置，百分比同步；
4. 底部「约剩 N 分钟」随位置减少；
5. 快速滚动时界面不卡（滚动处理只在 rAF 内计算）。

- [ ] **Step 9: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（82 条）。

```bash
git add src/renderer/src/reader/position.ts src/renderer/src/components/ProgressBar.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css tests/position.test.ts
git commit -m "feat(reader): Track and restore progress" -m "Readers need to come back exactly where they stopped, and the footer
needs to show and seek the whole-book position.

- Convert scroll position into chapter, paragraph and percent
- Restore by chapter hash with index and percent fallbacks
- Debounce saves for 500ms and flush when the reader unmounts
- Add a bottom bar with percentage, chapter count and remaining time

Related: 无"
```

---

### Task 5: 排版与主题设置面板

**Files:**
- Create: `src/renderer/src/components/SettingsPanel.tsx`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `AppSettings` / `SettingsPatch` / `mergeSettings`；Task 4 的 `Reader`。
- Produces: `SettingsPanel({ settings, onChange, onClose })`；阅读页工具栏「排版」按钮与 `data-theme` / CSS 变量。

- [ ] **Step 1: 实现设置面板**

创建 `src/renderer/src/components/SettingsPanel.tsx`：

```tsx
import type { AppSettings, ThemeName } from '../../../core/model'
import type { SettingsPatch } from '../../../shared/settings'

interface SettingsPanelProps {
  settings: AppSettings
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
}

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'green', label: '护眼绿' },
  { id: 'sepia', label: '羊皮纸' }
]

const FONTS = [
  { label: '系统默认', value: "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif" },
  { label: '宋体', value: "'SimSun', 'Songti SC', serif" },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif" },
  { label: '仿宋', value: "'FangSong', 'STFangsong', serif" }
]

export default function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const typography = settings.typography
  const fonts = FONTS.some((font) => font.value === typography.fontFamily)
    ? FONTS
    : [{ label: '当前字体', value: typography.fontFamily }, ...FONTS]

  return (
    <aside className="reader-drawer right settings-panel">
      <header className="drawer-header">
        <h2>排版</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭排版设置">
          ×
        </button>
      </header>

      <section className="setting-group">
        <h3>主题</h3>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`theme-swatch ${theme.id} ${settings.theme === theme.id ? 'active' : ''}`}
              onClick={() => onChange({ theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </section>

      <section className="setting-group">
        <label className="setting-row">
          <span>字体</span>
          <select
            value={typography.fontFamily}
            onChange={(event) => onChange({ typography: { fontFamily: event.target.value } })}
          >
            {fonts.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </label>

        <label className="setting-row">
          <span>字号</span>
          <input
            type="range"
            min={14}
            max={30}
            step={1}
            value={typography.fontSize}
            onChange={(event) => onChange({ typography: { fontSize: Number(event.target.value) } })}
          />
          <output>{typography.fontSize}px</output>
        </label>

        <label className="setting-row">
          <span>行距</span>
          <input
            type="range"
            min={1.4}
            max={2.4}
            step={0.1}
            value={typography.lineHeight}
            onChange={(event) => onChange({ typography: { lineHeight: Number(event.target.value) } })}
          />
          <output>{typography.lineHeight.toFixed(1)}</output>
        </label>

        <label className="setting-row">
          <span>段距</span>
          <input
            type="range"
            min={0}
            max={1.6}
            step={0.1}
            value={typography.paragraphSpacing}
            onChange={(event) =>
              onChange({ typography: { paragraphSpacing: Number(event.target.value) } })
            }
          />
          <output>{typography.paragraphSpacing.toFixed(1)}em</output>
        </label>

        <label className="setting-row">
          <span>页边距</span>
          <input
            type="range"
            min={16}
            max={64}
            step={2}
            value={typography.pagePadding}
            onChange={(event) => onChange({ typography: { pagePadding: Number(event.target.value) } })}
          />
          <output>{typography.pagePadding}px</output>
        </label>

        <label className="setting-row">
          <span>最大宽度</span>
          <input
            type="number"
            min={400}
            max={2000}
            step={20}
            disabled={typography.maxContentWidth === null}
            value={typography.maxContentWidth ?? 860}
            onChange={(event) =>
              onChange({ typography: { maxContentWidth: Number(event.target.value) } })
            }
          />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={typography.maxContentWidth === null}
              onChange={(event) =>
                onChange({ typography: { maxContentWidth: event.target.checked ? null : 860 } })
              }
            />
            不限制
          </label>
        </label>
      </section>
    </aside>
  )
}
```

- [ ] **Step 2: 阅读页接入设置与主题变量**

在 `src/renderer/src/pages/Reader.tsx`：

1. 导入：

```ts
import type { CSSProperties } from 'react'
import SettingsPanel from '../components/SettingsPanel'
```

2. 在组件内加入抽屉状态：

```ts
const [drawer, setDrawer] = useState<'settings' | null>(null)
```

3. 在 `if (!book)` 分支之前定义样式对象：

```ts
const readerStyle = {
  '--reader-font-family': settings.typography.fontFamily,
  '--reader-font-size': `${settings.typography.fontSize}px`,
  '--reader-line-height': String(settings.typography.lineHeight),
  '--reader-paragraph-spacing': `${settings.typography.paragraphSpacing}em`,
  '--reader-page-padding': `${settings.typography.pagePadding}px`,
  '--reader-max-width':
    settings.typography.maxContentWidth === null ? 'none' : `${settings.typography.maxContentWidth}px`
} as CSSProperties
```

4. 把根节点改为：

```tsx
<div className="reader" data-theme={settings.theme} style={readerStyle}>
```

5. 工具栏右侧加入按钮：

```tsx
        <span className="toolbar-spacer" />
        <button className="ghost" onClick={() => setDrawer('settings')}>
          排版
        </button>
```

6. 在 `ProgressBar` 之后渲染面板：

```tsx
      {drawer === 'settings' && (
        <SettingsPanel
          settings={settings}
          onChange={onSettingsChange}
          onClose={() => setDrawer(null)}
        />
      )}
```

7. 确认组件签名改为使用 `settings` 与 `onSettingsChange`：

```tsx
export default function Reader({ bookId, settings, onSettingsChange, onBack }: ReaderProps) {
```

- [ ] **Step 3: 用 CSS 变量替换写死的排版值**

在 `src/renderer/src/styles.css` 中修改阅读页规则：

```css
.reader {
  height: 100vh;
  display: flex;
  flex-direction: column;
  background: var(--reader-bg);
  color: var(--reader-text);
}
.reader-toolbar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  background: var(--reader-bg);
  border-bottom: 1px solid var(--reader-border);
  z-index: 20;
}
.reader-toolbar .ghost {
  border: none;
  background: transparent;
  color: var(--reader-accent);
  font-size: 14px;
  cursor: pointer;
  padding: 6px 8px;
  border-radius: 6px;
}
.reader-toolbar .ghost:hover { background: var(--reader-hover); }
.reader-title { font-size: 14px; color: var(--reader-muted); overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.toolbar-spacer { flex: 1 1 auto; }
.reader-scroll { flex: 1 1 auto; overflow-y: auto; }
.reader-page {
  max-width: var(--reader-max-width, 860px);
  margin: 0 auto;
  padding: var(--reader-page-padding, 32px);
  padding-bottom: 140px;
  font-family: var(--reader-font-family);
  font-size: var(--reader-font-size);
  line-height: var(--reader-line-height);
  color: var(--reader-text);
}
.reader-paragraph {
  margin: 0 0 var(--reader-paragraph-spacing, 0.8em);
  text-indent: 2em;
  overflow-wrap: break-word;
}
.chapter-title { scroll-margin-top: 64px; }
.reader-paragraph { scroll-margin-top: 64px; }
.progress-bar {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 8px 20px;
  background: var(--reader-bg);
  border-top: 1px solid var(--reader-border);
  font-size: 12px;
  color: var(--reader-muted);
}
.progress-range { accent-color: var(--reader-accent); }
```

删除旧的 `.reader-page` / `.reader-paragraph` / `.progress-bar` 重复定义，避免后者覆盖。在文件末尾追加主题变量：

```css
.reader[data-theme='light'] {
  --reader-bg: #f5f3ee;
  --reader-text: #2b2b2b;
  --reader-muted: #6b6b6b;
  --reader-border: #e2ddd2;
  --reader-accent: #4a6741;
  --reader-hover: rgba(74, 103, 65, 0.1);
  --reader-panel: #fffdf8;
  --reader-panel-strong: #ffffff;
}
.reader[data-theme='dark'] {
  --reader-bg: #1e1f22;
  --reader-text: #cfd2d6;
  --reader-muted: #8f949b;
  --reader-border: #33363b;
  --reader-accent: #8fb37f;
  --reader-hover: rgba(143, 179, 127, 0.14);
  --reader-panel: #26282c;
  --reader-panel-strong: #2d3035;
}
.reader[data-theme='green'] {
  --reader-bg: #e8f0e3;
  --reader-text: #26332a;
  --reader-muted: #5d6f60;
  --reader-border: #cddcc7;
  --reader-accent: #3f6b45;
  --reader-hover: rgba(63, 107, 69, 0.12);
  --reader-panel: #f3f8ef;
  --reader-panel-strong: #ffffff;
}
.reader[data-theme='sepia'] {
  --reader-bg: #f4ecd8;
  --reader-text: #4a3b2a;
  --reader-muted: #7d6a52;
  --reader-border: #ded0b4;
  --reader-accent: #7a5b34;
  --reader-hover: rgba(122, 91, 52, 0.12);
  --reader-panel: #fbf5e7;
  --reader-panel-strong: #fffaf0;
}
```

- [ ] **Step 4: 补抽屉与设置面板样式**

追加：

```css
.reader-drawer {
  position: fixed;
  top: 0;
  bottom: 0;
  width: 320px;
  z-index: 40;
  display: flex;
  flex-direction: column;
  background: var(--reader-panel);
  color: var(--reader-text);
  box-shadow: 0 0 24px rgba(0, 0, 0, 0.18);
  overflow-y: auto;
}
.reader-drawer.right { right: 0; }
.reader-drawer.left { left: 0; }
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  border-bottom: 1px solid var(--reader-border);
  position: sticky;
  top: 0;
  background: var(--reader-panel);
}
.drawer-header h2 { margin: 0; font-size: 15px; }
.drawer-close {
  border: none;
  background: transparent;
  color: var(--reader-muted);
  font-size: 22px;
  line-height: 1;
  cursor: pointer;
}
.setting-group { padding: 14px 16px; border-bottom: 1px solid var(--reader-border); }
.setting-group h3 { margin: 0 0 10px; font-size: 13px; color: var(--reader-muted); font-weight: 500; }
.setting-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  font-size: 13px;
}
.setting-row > span { flex: 0 0 62px; color: var(--reader-muted); }
.setting-row select,
.setting-row input[type='number'] {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--reader-panel-strong);
  color: var(--reader-text);
  border: 1px solid var(--reader-border);
  border-radius: 5px;
  padding: 5px 8px;
  font-size: 13px;
}
.setting-row input[type='range'] { flex: 1 1 auto; accent-color: var(--reader-accent); }
.setting-row output { flex: 0 0 48px; text-align: right; font-variant-numeric: tabular-nums; color: var(--reader-muted); }
.inline-check { display: flex; align-items: center; gap: 4px; flex: 0 0 auto; font-size: 12px; color: var(--reader-muted); }
.theme-grid { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; }
.theme-swatch {
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  padding: 10px 8px;
  font-size: 13px;
  cursor: pointer;
  color: #2b2b2b;
}
.theme-swatch.light { background: #f5f3ee; }
.theme-swatch.dark { background: #1e1f22; color: #cfd2d6; }
.theme-swatch.green { background: #e8f0e3; color: #26332a; }
.theme-swatch.sepia { background: #f4ecd8; color: #4a3b2a; }
.theme-swatch.active { outline: 2px solid var(--reader-accent); outline-offset: 1px; }
```

- [ ] **Step 5: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 打开书 → 「排版」→ 切换四个主题，正文、工具栏、底部栏颜色同步；
2. 字号、行距、段距、页边距拖动时正文实时重排；
3. 最大宽度设为 600 或勾选「不限制」，内容宽度立即变化；
4. 关闭应用重开，设置保留；
5. 深色主题下抽屉与输入控件仍可读。

- [ ] **Step 6: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（82 条）。

```bash
git add src/renderer/src/components/SettingsPanel.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css
git commit -m "feat(reader): Add typography and themes" -m "Long-form reading needs adjustable type and a choice of low-contrast
themes, live and without a restart.

- Add a settings drawer for theme, font, size, spacing and width
- Drive the reader through CSS variables and data-theme palettes
- Persist every change through the settings IPC

Related: 无"
```

---

### Task 6: 目录抽屉

**Files:**
- Create: `src/renderer/src/components/TocDrawer.tsx`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `BookMeta['chapters']`、Task 4 的 `current.chapterIndex` 与 `scrollToPosition`。
- Produces: `TocDrawer({ chapters, currentIndex, onSelect, onClose })`；阅读页工具栏「目录」按钮；`jumpToChapter(index)`。

- [ ] **Step 1: 实现目录抽屉**

创建 `src/renderer/src/components/TocDrawer.tsx`：

```tsx
import { useState } from 'react'
import type { ChapterMeta } from '../../../core/model'

interface TocDrawerProps {
  chapters: ChapterMeta[]
  currentIndex: number
  onSelect: (chapterIndex: number) => void
  onClose: () => void
}

export default function TocDrawer({ chapters, currentIndex, onSelect, onClose }: TocDrawerProps) {
  const [filter, setFilter] = useState('')
  const keyword = filter.trim().toLowerCase()
  const visible = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !keyword || chapter.title.toLowerCase().includes(keyword))

  return (
    <aside className="reader-drawer left toc-drawer">
      <header className="drawer-header">
        <h2>目录</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭目录">
          ×
        </button>
      </header>

      <div className="toc-filter">
        <input
          type="search"
          value={filter}
          placeholder="搜索章节标题"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <ol className="toc-list">
        {visible.map(({ chapter, index }) => (
          <li key={chapter.index}>
            <button
              className={`toc-item ${chapter.level} ${index === currentIndex ? 'current' : ''}`}
              onClick={() => onSelect(index)}
            >
              <span className="toc-title">{chapter.title}</span>
              {chapter.flags.suspectedDuplicate && <span className="toc-badge">重复?</span>}
            </button>
          </li>
        ))}
      </ol>

      {visible.length === 0 && <p className="toc-empty">没有匹配的章节</p>}
    </aside>
  )
}
```

- [ ] **Step 2: 阅读页接入目录**

修改 `src/renderer/src/pages/Reader.tsx`：

1. 导入：

```ts
import TocDrawer from '../components/TocDrawer'
```

2. 抽屉状态类型扩展：

```ts
const [drawer, setDrawer] = useState<'toc' | 'settings' | null>(null)
```

3. 在 `seek` 后加入跳章函数：

```ts
const jumpToChapter = useCallback(
  (chapterIndex: number): void => {
    if (!book) return
    const index = Math.min(Math.max(chapterIndex, 0), book.meta.chapters.length - 1)
    const position = { chapterIndex: index, paragraphIndex: 0, percent: 0 }
    const percent = percentAt(book.meta, index, 0, paragraphs)
    const next = { ...position, percent }
    setCurrent(next)
    scheduleSave(next)
    scrollToPosition(index, 0)
    setDrawer(null)
  },
  [book, paragraphs, scheduleSave, scrollToPosition]
)
```

4. 工具栏按钮（放在「排版」之前）：

```tsx
        <button className="ghost" onClick={() => setDrawer('toc')}>
          目录
        </button>
```

5. 渲染抽屉：

```tsx
      {drawer === 'toc' && (
        <TocDrawer
          chapters={book.meta.chapters}
          currentIndex={current.chapterIndex}
          onSelect={jumpToChapter}
          onClose={() => setDrawer(null)}
        />
      )}
```

- [ ] **Step 3: 补目录样式**

追加：

```css
.toc-filter { padding: 10px 16px; border-bottom: 1px solid var(--reader-border); }
.toc-filter input {
  width: 100%;
  background: var(--reader-panel-strong);
  color: var(--reader-text);
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
}
.toc-list { list-style: none; margin: 0; padding: 6px 0 24px; }
.toc-item {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--reader-text);
  text-align: left;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 16px;
  font-size: 13px;
  cursor: pointer;
  font: inherit;
}
.toc-item:hover { background: var(--reader-hover); }
.toc-item.volume { font-weight: 600; padding-top: 12px; color: var(--reader-muted); }
.toc-item.current { color: var(--reader-accent); font-weight: 600; background: var(--reader-hover); }
.toc-title { flex: 1 1 auto; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.toc-badge {
  flex: 0 0 auto;
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 8px;
  background: rgba(164, 91, 42, 0.16);
  color: #a45b2a;
}
.toc-empty { color: var(--reader-muted); text-align: center; padding: 24px; font-size: 13px; }
```

- [ ] **Step 4: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 打开书 → 「目录」抽屉列出全部章节，卷标题加粗；
2. 滚动正文时，当前章在目录中高亮；
3. 输入「第 10」等关键词过滤，点结果跳转并关闭抽屉；
4. 疑似重复章节显示「重复?」角标；
5. 目录列表 300+ 章滚动顺畅。

- [ ] **Step 5: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（82 条）。

```bash
git add src/renderer/src/components/TocDrawer.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css
git commit -m "feat(reader): Add searchable contents" -m "Long books need direct chapter access instead of scrolling from the
current position.

- List volumes and chapters in a left drawer with title filtering
- Highlight the chapter under the reading position
- Jump to a chapter on click and mark suspected duplicates

Related: 无"
```

---

### Task 7: 全书搜索

**Files:**
- Create: `src/main/services/search.ts`
- Modify: `src/main/index.ts`
- Modify: `src/shared/api.ts`
- Modify: `src/preload/index.ts`
- Create: `src/renderer/src/components/SearchPanel.tsx`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`
- Test: `tests/search-service.test.ts`

**Interfaces:**
- Consumes: `BookRepository.readMeta` / `readChapter`；Task 4 的 `percentAt`、`scrollToPosition`。
- Produces:
  - `SearchService.search(id, query, token, onProgress): Promise<SearchResults>`、`SearchService.cancel(token)`
  - IPC：`book:search`、`search:cancel`、事件 `search:progress`
  - `ReaderApi.searchBook(id, query, token)`、`cancelSearch(token)`、`onSearchProgress(cb)`
  - `SearchPanel({ bookId, chapters, onJump, onClose })`

- [ ] **Step 1: 写搜索服务的失败测试**

创建 `tests/search-service.test.ts`：

```ts
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchService } from '../src/main/services/search'
import { BookRepository } from '../src/main/storage/book'
import type { BookMeta } from '../src/core/model'

let root = ''
let books: BookRepository
let service: SearchService

function meta(): BookMeta {
  return {
    version: 1,
    id: 'b',
    title: '搜索测试',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'h1', startLine: 0, charCount: 20, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'h2', startLine: 2, charCount: 20, simhash: '2', flags: {} },
      { index: 2, title: '第三章', level: 'chapter', titleHash: 'h3', startLine: 4, charCount: 20, simhash: '3', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-search-'))
  books = new BookRepository(root)
  service = new SearchService(books)
  await books.writeBook({
    meta: meta(),
    sourceText: '原文',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['开场白。', '这里有正文内容。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二章正文。'] },
      { title: '第三章', level: 'chapter', startLine: 4, paragraphs: ['包含 .* 和 [ 符号的段落。'] }
    ]
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SearchService', () => {
  it('returns hits in chapter and paragraph order', async () => {
    const result = await service.search('b', '正文', 't1', () => undefined)
    expect(result.hits.map((hit) => [hit.chapterIndex, hit.paragraphIndex])).toEqual([
      [0, 1],
      [1, 0]
    ])
    expect(result.hits[0].chapterKey).toBe('h1')
    expect(result.hits[0].excerpt).toContain('正文')
    expect(result.cancelled).toBe(false)
  })

  it('treats regular expression characters as literal text', async () => {
    const result = await service.search('b', '.*', 't2', () => undefined)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].chapterIndex).toBe(2)
  })

  it('returns early when the token was cancelled', async () => {
    service.cancel('t3')
    const result = await service.search('b', '正文', 't3', () => undefined)
    expect(result.cancelled).toBe(true)
    expect(result.hits).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/search-service.test.ts`
Expected: FAIL — `Cannot find module '../src/main/services/search'`。

- [ ] **Step 3: 实现 SearchService**

创建 `src/main/services/search.ts`：

```ts
import type { SearchHit, SearchProgress, SearchResults } from '../../shared/api'
import type { BookRepository } from '../storage/book'

const MAX_HITS = 300

function assertBookId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('无效的书籍编号')
}

export class SearchService {
  private readonly cancelled = new Set<string>()

  constructor(private readonly books: BookRepository) {}

  cancel(token: string): void {
    this.cancelled.add(token)
  }

  async search(
    id: string,
    query: string,
    token: string,
    onProgress: (payload: SearchProgress) => void
  ): Promise<SearchResults> {
    assertBookId(id)
    const meta = await this.books.readMeta(id)
    const needle = query.trim().toLowerCase()
    const hits: SearchHit[] = []
    if (!needle) return { token, hits, truncated: false, cancelled: false }

    for (let index = 0; index < meta.chapters.length; index++) {
      if (this.cancelled.delete(token)) {
        return { token, hits, truncated: false, cancelled: true }
      }

      const text = await this.books.readChapter(id, index)
      const paragraphs = text
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean)

      for (let paragraphIndex = 0; paragraphIndex < paragraphs.length; paragraphIndex++) {
        const paragraph = paragraphs[paragraphIndex]
        const at = paragraph.toLowerCase().indexOf(needle)
        if (at < 0) continue

        const start = Math.max(0, at - 20)
        const end = Math.min(paragraph.length, at + needle.length + 40)
        hits.push({
          chapterIndex: index,
          chapterKey: meta.chapters[index].titleHash,
          paragraphIndex,
          excerpt: `${start > 0 ? '…' : ''}${paragraph.slice(start, end)}${end < paragraph.length ? '…' : ''}`
        })

        if (hits.length >= MAX_HITS) {
          return { token, hits, truncated: true, cancelled: false }
        }
      }

      if ((index + 1) % 10 === 0 || index === meta.chapters.length - 1) {
        onProgress({ token, scanned: index + 1, total: meta.chapters.length })
      }
    }

    return { token, hits, truncated: false, cancelled: false }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/search-service.test.ts`
Expected: PASS（3 条）。

- [ ] **Step 5: 扩展 API 类型、preload 与主进程**

在 `src/shared/api.ts` 中加入：

```ts
export interface SearchHit {
  chapterIndex: number
  chapterKey: string
  paragraphIndex: number
  excerpt: string
}

export interface SearchProgress {
  token: string
  scanned: number
  total: number
}

export interface SearchResults {
  token: string
  hits: SearchHit[]
  truncated: boolean
  cancelled: boolean
}
```

在 `ReaderApi` 中加入：

```ts
  searchBook(id: string, query: string, token: string): Promise<SearchResults>
  cancelSearch(token: string): Promise<void>
  onSearchProgress(cb: (payload: SearchProgress) => void): () => void
```

在 `src/preload/index.ts` 中加入：

```ts
  searchBook: (id, query, token) => ipcRenderer.invoke('book:search', id, query, token),
  cancelSearch: (token) => ipcRenderer.invoke('search:cancel', token),
  onSearchProgress: (callback) => {
    const listener = (_event: unknown, payload: SearchProgress): void => {
      callback(payload)
    }
    ipcRenderer.on('search:progress', listener)
    return () => {
      ipcRenderer.removeListener('search:progress', listener)
    }
  },
```

`src/preload/index.ts` 顶部补类型导入：

```ts
import type { ReaderApi, SearchProgress } from '../shared/api'
```

主进程 `src/main/index.ts`：

```ts
import { SearchService } from './services/search'

const search = new SearchService(books)
```

在 `app.whenReady()` 内加入：

```ts
  ipcMain.handle('book:search', (event, id: string, query: string, token: string) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    return search.search(id, query, token, (payload) => {
      win?.webContents.send('search:progress', payload)
    })
  })
  ipcMain.handle('search:cancel', (_event, token: string) => {
    search.cancel(token)
  })
```

- [ ] **Step 6: 实现搜索面板**

创建 `src/renderer/src/components/SearchPanel.tsx`：

```tsx
import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ChapterMeta } from '../../../core/model'
import type { SearchHit, SearchProgress } from '../../../shared/api'

interface SearchPanelProps {
  bookId: string
  chapters: ChapterMeta[]
  onJump: (chapterIndex: number, paragraphIndex: number) => void
  onClose: () => void
}

export default function SearchPanel({ bookId, chapters, onJump, onClose }: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [progress, setProgress] = useState<SearchProgress | null>(null)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const tokenRef = useRef('')

  useEffect(() => {
    return window.api.onSearchProgress((payload) => {
      if (payload.token === tokenRef.current) setProgress(payload)
    })
  }, [])

  const run = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = query.trim()
    if (!text || searching) return
    const token = crypto.randomUUID()
    tokenRef.current = token
    setSearching(true)
    setHits([])
    setMessage('')
    setProgress({ token, scanned: 0, total: chapters.length })
    try {
      const result = await window.api.searchBook(bookId, text, token)
      if (tokenRef.current !== token) return
      setHits(result.hits)
      if (result.cancelled) setMessage('已取消搜索')
      else if (result.hits.length === 0) setMessage('没有找到匹配内容')
      else if (result.truncated) setMessage('结果超过 300 条，已截断')
    } catch (reason) {
      if (tokenRef.current === token) {
        setMessage(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (tokenRef.current === token) setSearching(false)
    }
  }

  const cancel = async (): Promise<void> => {
    if (!searching || !tokenRef.current) return
    await window.api.cancelSearch(tokenRef.current)
  }

  const scannedPercent =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0

  return (
    <aside className="reader-drawer right search-panel">
      <header className="drawer-header">
        <h2>全书搜索</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭搜索">
          ×
        </button>
      </header>

      <form className="search-form" onSubmit={(event) => void run(event)}>
        <input
          type="search"
          value={query}
          placeholder="输入要查找的文字"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={searching || !query.trim()}>
          {searching ? '搜索中' : '搜索'}
        </button>
        {searching && (
          <button type="button" className="ghost" onClick={() => void cancel()}>
            取消
          </button>
        )}
      </form>

      {searching && (
        <div className="search-progress">
          <div className="search-progress-track">
            <div className="search-progress-fill" style={{ width: `${scannedPercent}%` }} />
          </div>
          <span>
            {progress?.scanned ?? 0} / {progress?.total ?? chapters.length} 章
          </span>
        </div>
      )}

      {message && <p className="search-message">{message}</p>}

      <ul className="search-results">
        {hits.map((hit, index) => (
          <li key={`${hit.chapterIndex}-${hit.paragraphIndex}-${index}`}>
            <button
              className="search-hit"
              onClick={() => {
                onJump(hit.chapterIndex, hit.paragraphIndex)
                onClose()
              }}
            >
              <span className="search-chapter">{chapters[hit.chapterIndex]?.title ?? ''}</span>
              <span className="search-excerpt">{hit.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
```

- [ ] **Step 7: 阅读页接入搜索与跳转高亮**

修改 `src/renderer/src/pages/Reader.tsx`：

1. 导入：

```ts
import SearchPanel from '../components/SearchPanel'
```

2. 抽屉类型扩展：

```ts
const [drawer, setDrawer] = useState<'toc' | 'search' | 'bookmarks' | 'settings' | null>(null)
```

（`bookmarks` 在 Task 8 使用，本次先加入联合类型。）

3. 在 `jumpToChapter` 后加入按段跳转：

```ts
const jumpToPosition = useCallback(
  (chapterIndex: number, paragraphIndex: number): void => {
    if (!book) return
    const index = Math.min(Math.max(chapterIndex, 0), book.meta.chapters.length - 1)
    const percent = percentAt(book.meta, index, paragraphIndex, paragraphs)
    const next = { chapterIndex: index, paragraphIndex, percent }
    setCurrent(next)
    scheduleSave(next)
    scrollToPosition(index, paragraphIndex)
    const target = scrollRef.current?.querySelector<HTMLElement>(
      `[data-chapter-index="${index}"][data-paragraph-index="${paragraphIndex}"]`
    )
    if (target) {
      target.classList.add('search-flash')
      window.setTimeout(() => target.classList.remove('search-flash'), 2000)
    }
  },
  [book, paragraphs, scheduleSave, scrollToPosition]
)
```

4. 工具栏加搜索按钮（目录之后）：

```tsx
        <button className="ghost" onClick={() => setDrawer('search')}>
          搜索
        </button>
```

5. 渲染搜索抽屉：

```tsx
      {drawer === 'search' && (
        <SearchPanel
          bookId={bookId}
          chapters={book.meta.chapters}
          onJump={jumpToPosition}
          onClose={() => setDrawer(null)}
        />
      )}
```

- [ ] **Step 8: 补搜索样式**

追加：

```css
.search-form { display: flex; gap: 8px; padding: 12px 16px; border-bottom: 1px solid var(--reader-border); }
.search-form input {
  flex: 1 1 auto;
  min-width: 0;
  background: var(--reader-panel-strong);
  color: var(--reader-text);
  border: 1px solid var(--reader-border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 13px;
}
.search-form button {
  flex: 0 0 auto;
  border: none;
  border-radius: 6px;
  background: var(--reader-accent);
  color: #fff;
  padding: 7px 12px;
  font-size: 13px;
  cursor: pointer;
}
.search-form button:disabled { opacity: 0.55; cursor: default; }
.search-form button.ghost { background: transparent; color: var(--reader-accent); }
.search-progress { padding: 10px 16px; font-size: 12px; color: var(--reader-muted); }
.search-progress-track { height: 4px; border-radius: 2px; background: var(--reader-border); overflow: hidden; margin-bottom: 6px; }
.search-progress-fill { height: 100%; background: var(--reader-accent); transition: width 120ms linear; }
.search-message { margin: 10px 16px; font-size: 13px; color: var(--reader-muted); }
.search-results { list-style: none; margin: 0; padding: 4px 0 24px; }
.search-hit {
  width: 100%;
  border: none;
  background: transparent;
  color: var(--reader-text);
  text-align: left;
  padding: 9px 16px;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.search-hit:hover { background: var(--reader-hover); }
.search-chapter { font-size: 12px; color: var(--reader-accent); }
.search-excerpt { font-size: 13px; line-height: 1.5; overflow-wrap: break-word; }
.reader-paragraph.search-flash { background: rgba(255, 214, 102, 0.45); transition: background 300ms ease-out; }
```

- [ ] **Step 9: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 打开书 → 「搜索」→ 输入「正文」回车，进度条推进，结果按章节排列；
2. 点击结果跳到对应段落并短暂高亮，抽屉关闭；
3. 搜索「.*」「[」「\」不会崩溃，结果只匹配字面量；
4. 大书搜索期间点「取消」，显示「已取消搜索」；
5. 无结果时显示「没有找到匹配内容」。

- [ ] **Step 10: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（85 条）。

```bash
git add src/main/services/search.ts src/main/index.ts src/shared/api.ts src/preload/index.ts src/renderer/src/components/SearchPanel.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css tests/search-service.test.ts
git commit -m "feat(reader): Add full-book search" -m "Readers need to find a line anywhere in the book without leaving the
current page.

- Search chapter files in the main process with literal substring matching
- Report progress every ten chapters and support cancellation by token
- Return at most 300 hits with chapter and paragraph anchors
- Add a search drawer that jumps to and briefly highlights a hit

Related: 无"
```

---

### Task 8: 书签面板与 Ctrl+B

**Files:**
- Create: `src/renderer/src/components/BookmarksPanel.tsx`
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 2 的 `addBookmark` / `removeBookmark`；Task 4 的 `current`、`jumpToPosition`。
- Produces: `BookmarksPanel({ bookmarks, chapters, onJump, onDelete, onClose })`；阅读页工具栏「书签」按钮；`toggleBookmark()`；操作提示 `notice`。

- [ ] **Step 1: 实现书签面板**

创建 `src/renderer/src/components/BookmarksPanel.tsx`：

```tsx
import type { Bookmark, ChapterMeta } from '../../../core/model'

interface BookmarksPanelProps {
  bookmarks: Bookmark[]
  chapters: ChapterMeta[]
  onJump: (chapterIndex: number, paragraphIndex: number) => void
  onDelete: (bookmarkId: string) => void
  onClose: () => void
}

export default function BookmarksPanel({
  bookmarks,
  chapters,
  onJump,
  onDelete,
  onClose
}: BookmarksPanelProps) {
  return (
    <aside className="reader-drawer right bookmarks-panel">
      <header className="drawer-header">
        <h2>书签</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭书签">
          ×
        </button>
      </header>

      {bookmarks.length === 0 ? (
        <p className="bookmarks-empty">还没有书签。阅读时按 Ctrl+B 记住当前段落。</p>
      ) : (
        <ul className="bookmark-list">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id} className="bookmark-item">
              <button
                className="bookmark-main"
                onClick={() => {
                  onJump(bookmark.chapterIndex, bookmark.paragraphIndex)
                  onClose()
                }}
              >
                <span className="bookmark-chapter">
                  {chapters[bookmark.chapterIndex]?.title ?? '未知章节'}
                </span>
                <span className="bookmark-excerpt">{bookmark.excerpt || '（空段落）'}</span>
              </button>
              <button
                className="bookmark-delete"
                aria-label="删除书签"
                onClick={() => onDelete(bookmark.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
```

- [ ] **Step 2: 阅读页接入书签状态**

修改 `src/renderer/src/pages/Reader.tsx`：

1. 导入：

```ts
import type { Bookmark } from '../../../core/model'
import BookmarksPanel from '../components/BookmarksPanel'
```

2. 状态：

```ts
const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
const [notice, setNotice] = useState('')
```

3. 打开书成功时同步书签：

```ts
      .then((payload) => {
        if (alive) {
          setBook(payload)
          setBookmarks(payload.bookmarks)
        }
      })
```

4. 提示自动消失：

```ts
useEffect(() => {
  if (!notice) return
  const timer = window.setTimeout(() => setNotice(''), 1600)
  return () => window.clearTimeout(timer)
}, [notice])
```

5. 在 `jumpToPosition` 后加入书签切换：

```ts
const toggleBookmark = useCallback((): void => {
  if (!book) return
  const chapterIndex = current.chapterIndex
  const paragraphIndex = current.paragraphIndex
  const chapter = book.meta.chapters[chapterIndex]
  if (!chapter) return
  const existing = bookmarks.find(
    (bookmark) =>
      bookmark.chapterKey === chapter.titleHash && bookmark.paragraphIndex === paragraphIndex
  )

  if (existing) {
    void window.api
      .removeBookmark(bookId, existing.id)
      .then((next) => {
        setBookmarks(next)
        setNotice('已取消书签')
      })
      .catch((reason: unknown) => setNotice(`操作失败：${String(reason)}`))
    return
  }

  const element = scrollRef.current?.querySelector<HTMLElement>(
    `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
  )
  const excerpt = (element?.textContent ?? '').trim().slice(0, 60)
  void window.api
    .addBookmark(bookId, {
      chapterKey: chapter.titleHash,
      chapterIndex,
      paragraphIndex,
      excerpt
    })
    .then((next) => {
      setBookmarks(next)
      setNotice('已添加书签')
    })
    .catch((reason: unknown) => setNotice(`操作失败：${String(reason)}`))
}, [book, bookId, bookmarks, current])

const deleteBookmark = useCallback(
  (bookmarkId: string): void => {
    void window.api
      .removeBookmark(bookId, bookmarkId)
      .then(setBookmarks)
      .catch((reason: unknown) => setNotice(`删除失败：${String(reason)}`))
  },
  [bookId]
)
```

6. 工具栏加按钮（搜索之后）：

```tsx
        <button className="ghost" onClick={() => setDrawer('bookmarks')}>
          书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}
        </button>
```

7. 渲染面板与提示（放在其他抽屉之后）：

```tsx
      {drawer === 'bookmarks' && (
        <BookmarksPanel
          bookmarks={bookmarks}
          chapters={book.meta.chapters}
          onJump={jumpToPosition}
          onDelete={deleteBookmark}
          onClose={() => setDrawer(null)}
        />
      )}

      {notice && <div className="reader-notice">{notice}</div>}
```

- [ ] **Step 3: 补书签与提示样式**

追加：

```css
.bookmarks-empty { color: var(--reader-muted); font-size: 13px; padding: 24px 16px; line-height: 1.6; }
.bookmark-list { list-style: none; margin: 0; padding: 4px 0 24px; }
.bookmark-item { display: flex; align-items: stretch; border-bottom: 1px solid var(--reader-border); }
.bookmark-main {
  flex: 1 1 auto;
  min-width: 0;
  border: none;
  background: transparent;
  color: var(--reader-text);
  text-align: left;
  padding: 10px 8px 10px 16px;
  cursor: pointer;
  font: inherit;
  display: flex;
  flex-direction: column;
  gap: 3px;
}
.bookmark-main:hover { background: var(--reader-hover); }
.bookmark-chapter { font-size: 12px; color: var(--reader-accent); }
.bookmark-excerpt { font-size: 13px; line-height: 1.5; overflow-wrap: break-word; }
.bookmark-delete {
  flex: 0 0 40px;
  border: none;
  background: transparent;
  color: var(--reader-muted);
  font-size: 18px;
  cursor: pointer;
}
.bookmark-delete:hover { color: #a45b2a; }
.reader-notice {
  position: fixed;
  top: 64px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 60;
  background: rgba(43, 43, 43, 0.9);
  color: #fff;
  font-size: 13px;
  padding: 8px 16px;
  border-radius: 6px;
  animation: toast-in 180ms ease-out;
}
```

- [ ] **Step 4: 手动验收**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`
检查：
1. 阅读时在工具栏点「书签」→「Ctrl+B 提示」暂未接入，先在阅读页按 Ctrl+B（Task 9 才生效）——本任务用浏览器 DevTools 或调试通道调用 `window.api.addBookmark` 验证面板展示；
2. 打开书签面板，点击书签跳到对应段落；
3. 点书签右侧 × 删除，列表即时更新；
4. 关闭应用重开，书签仍在。

（Ctrl+B 的键盘绑定在 Task 9 完成；本任务只需 `toggleBookmark` 函数存在并被工具栏/后续快捷键调用。）

- [ ] **Step 5: 全量检查并提交**

Run: `npm run typecheck && npm test`
Expected: 通过（85 条）。

```bash
git add src/renderer/src/components/BookmarksPanel.tsx src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css
git commit -m "feat(reader): Add bookmark panel and toggle" -m "Readers need to mark a paragraph and come back to it later.

- Load bookmarks with the book and keep the list in reader state
- Toggle a bookmark at the current paragraph with a short notice
- List, jump to and delete bookmarks from a right drawer

Related: 无"
```

---

### Task 9: 键盘操作、全屏与最终验收

**Files:**
- Modify: `src/renderer/src/pages/Reader.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: Task 1 的 `toggleFullscreen`；Task 4 的 `jumpToChapter`；Task 7 的搜索抽屉；Task 8 的 `toggleBookmark`。
- Produces: 阅读页全局快捷键；最终手动验收清单。

- [ ] **Step 1: 加入键盘处理**

在 `src/renderer/src/pages/Reader.tsx` 的组件内、所有回调定义之后加入：

```ts
const scrollByScreen = useCallback((direction: number): void => {
  const scroller = scrollRef.current
  if (!scroller) return
  scroller.scrollBy({ top: direction * scroller.clientHeight * 0.9, behavior: 'smooth' })
}, [])

const changeFontSize = useCallback(
  (delta: number): void => {
    const fontSize = Math.min(36, Math.max(12, settings.typography.fontSize + delta))
    onSettingsChange({ typography: { fontSize } })
  },
  [onSettingsChange, settings.typography.fontSize]
)

useEffect(() => {
  const handleKeyDown = (event: KeyboardEvent): void => {
    const target = event.target as HTMLElement | null
    const editing =
      !!target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)

    if (editing) {
      if (event.key === 'Escape') {
        setDrawer(null)
        target.blur()
      }
      return
    }

    if (event.ctrlKey || event.metaKey) {
      switch (event.key) {
        case 'f':
          event.preventDefault()
          setDrawer('search')
          return
        case 'b':
          event.preventDefault()
          toggleBookmark()
          return
        case '=':
        case '+':
          event.preventDefault()
          changeFontSize(1)
          return
        case '-':
          event.preventDefault()
          changeFontSize(-1)
          return
        default:
          return
      }
    }

    if (event.key === 'F11') {
      event.preventDefault()
      void window.api.toggleFullscreen()
      return
    }

    if (event.key === 'Escape') {
      event.preventDefault()
      if (drawer) setDrawer(null)
      else onBack()
      return
    }

    if (drawer !== null) return

    switch (event.key) {
      case 'ArrowLeft':
        event.preventDefault()
        jumpToChapter(current.chapterIndex - 1)
        break
      case 'ArrowRight':
        event.preventDefault()
        jumpToChapter(current.chapterIndex + 1)
        break
      case ' ':
      case 'PageDown':
        event.preventDefault()
        scrollByScreen(event.shiftKey ? -1 : 1)
        break
      case 'PageUp':
        event.preventDefault()
        scrollByScreen(-1)
        break
      default:
        break
    }
  }

  window.addEventListener('keydown', handleKeyDown)
  return () => window.removeEventListener('keydown', handleKeyDown)
}, [
  changeFontSize,
  current.chapterIndex,
  drawer,
  jumpToChapter,
  onBack,
  scrollByScreen,
  toggleBookmark
])
```

- [ ] **Step 2: 确保退出前落盘**

在现有的卸载 flush 之外，加入 `beforeunload` 兜底：

```ts
useEffect(() => {
  const handleBeforeUnload = (): void => flush()
  window.addEventListener('beforeunload', handleBeforeUnload)
  return () => window.removeEventListener('beforeunload', handleBeforeUnload)
}, [flush])
```

- [ ] **Step 3: 手动验收（真实书）**

Run: `env -u ELECTRON_RUN_AS_NODE npm run dev`

逐项检查并记录结果：

1. `Space` / `PageDown` 下一屏，`Shift+Space` / `PageUp` 上一屏；
2. `←` / `→` 上一章 / 下一章，首尾自动夹住；
3. `Ctrl+F` 打开搜索，输入后回车；`Esc` 关闭搜索；
4. `Ctrl+B` 当前段落加书签，再按一次取消，顶部提示出现后 1.6 秒消失；书签面板可跳转/删除；
5. `Ctrl+=` / `Ctrl+-` 字号增减，重开应用后保持；
6. `F11` 进入/退出全屏；
7. 无抽屉时 `Esc` 返回书架；有抽屉时只关闭抽屉；
8. 打开一本真实大书连续阅读 5 分钟：滚动跟手，进度条持续更新，切章无白屏；
9. 阅读中直接关窗再开，回到关闭前段落（允许 1 段误差）；
10. 书架进度百分比与阅读页一致。

- [ ] **Step 4: 全量检查**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部通过（85 条），`out/` 构建成功。

- [ ] **Step 5: 提交**

```bash
git add src/renderer/src/pages/Reader.tsx src/renderer/src/styles.css
git commit -m "feat(reader): Add reader keyboard shortcuts" -m "Reading without touching the mouse is the point of a desktop reader,
and exit must flush the latest position.

- Map Space, PageUp, PageDown, arrows, Ctrl+F, Ctrl+B and Ctrl+=/- 
- Toggle fullscreen with F11 through the window IPC
- Close drawers with Escape before leaving the reader
- Flush pending progress on beforeunload as well as unmount

Related: 无"
```

---

## 计划完成后的验证

- 运行 `npm run typecheck`、`npm test`、`npm run build`，全部通过。
- 用两本真实 TXT（分卷、不同编码）走一遍：导入 → 阅读 5 分钟 → 搜索 → 书签 → 重开恢复进度。
- 更新 `docs/superpowers/specs/2026-10-29-pc-reader-design.md` 的完成状态由执行者决定，不在本计划自动修改。

## 后续计划（Plan 3，不在本计划范围）

- 同书合并执行（保留 progress/bookmarks、备份、planMerge 接线）。
- 重新清洗 / 重新切章（自动 + 手动标记）。
- 删除书籍、查看来源、拖拽导入、>50MB 确认、导入取消文案、进度阶段。
- `library.json` 形状自检与回滚、`backup/` 嵌套治理、单实例锁、CSP/导航守卫、日志与未捕获异常。
- electron-builder 绿色版打包与 `PORTABLE_EXECUTABLE_DIR` 数据目录验收。

