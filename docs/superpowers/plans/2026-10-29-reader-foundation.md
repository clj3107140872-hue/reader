# PC Reader Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 搭起 Electron + TypeScript + React 项目骨架，完成可独立测试的 TXT 解析核心（编码识别、乱码修复、章节切分、广告清洗、重复识别、同书判定与合并计划）、本地文件存储层与导入服务，最后打通 IPC，得到一个能导入 TXT 并显示书架的可用桌面应用。

**Architecture:** 四层——`core` 纯 TS 解析核心（不碰 Electron/fs/DOM）、`main/storage` 文件仓储层、`main` 主进程服务与 IPC、`react` 渲染层。本计划只实现"导入 → 解析 → 落盘 → 书架列表"，阅读器 UI、搜索、书签、合并弹窗、打包属于第二份计划。

**Tech Stack:** Electron、TypeScript（strict）、React 19、Vite（electron-vite）、Vitest、iconv-lite。运行时依赖只有 iconv-lite。

**Spec:** `docs/superpowers/specs/2026-10-29-pc-reader-design.md`

## Global Constraints

- 平台：Windows 10/11；界面文案使用中文。
- `src/core/` 下的代码禁止 import `electron`、`node:fs`、`node:path`、DOM API；允许 `Buffer` 与 `node:crypto`。
- TypeScript `strict: true`；每次提交前 `npm run typecheck` 必须通过。
- 自动化测试只覆盖 `src/core/`、`src/main/storage/`、`src/main/services/import.ts`；UI 不写自动化测试，用手动验收。测试用合成样本，不引入真实小说版权内容。
- 运行时依赖仅 `iconv-lite`；其余全部 devDependencies。
- 数据目录绿色便携：开发环境为项目根 `data/`（已 gitignore）。
- 提交信息遵循项目规范（Conventional Commits、英文祈使句、主题 ≤ 50 字符、正文说明 why、`Related: 无`）。本计划列出的每次提交已随计划获得授权；若需改动提交信息先询问。
- 不执行 `git push`。

## Review Focus

以下五类输入是规格没有逐条展开、但最容易让真实用户踩坑的情况。每一条都已落到对应任务的测试里：

1. **空文件 / 纯空白文件**——应给出明确错误，不能生成一本空书（Task 3、Task 9）。
2. **二进制文件被改成 .txt**——例如 PNG 重命名，应拒绝导入并提示"不是文本文件"，不能解码成乱码书（Task 3）。
3. **章节标记少于 3 个的短文本**——全书作为单独一章正常导入，而不是报错（Task 5）。
4. **正文中形似章节标题的句子**（"他翻到第三章。"）——不得被切成章节（Task 5）。
5. **同名不同内容的两本书**——内容指纹不重叠时必须保留双方全部章节，合并计划不能因标题相同就判重删除（Task 8、Task 11）。

---

## File Structure

```
reader/
  package.json
  electron.vite.config.ts
  tsconfig.json
  vitest.config.ts
  .gitignore
  src/
    core/
      model.ts          # 所有共享数据类型
      text.ts           # 规范化、FNV 哈希、SimHash、汉明距离
      encoding.ts       # BOM/严格 UTF-8/候选编码打分
      mojibake.ts       # 双重编码乱码检测与修复
      chapters.ts       # 中文数字、标题识别、章节切分、手动标记切分
      cleaning.ts       # 广告规则、清洗
      dedupe.ts         # 重复章节标记
      sameBook.ts       # 书名归一化、同书判定、合并计划（纯函数）
      pipeline.ts       # bytes → ParsedBook + BookMeta 的导入管线
    main/
      index.ts          # Electron 主进程、窗口、IPC
      services/
        paths.ts        # 数据目录解析（便携/打包/开发）
        import.ts       # 导入服务：查重、解析、落盘、同书嫌疑
      storage/
        fsUtil.ts       # 原子 JSON 写入、目录工具
        library.ts      # library.json 仓储
        book.ts         # 单本书目录仓储（meta/source/chapters/progress）
    preload/
      index.ts          # contextBridge 暴露 ReaderApi
    renderer/
      index.html
      src/
        main.tsx
        App.tsx
        styles.css
        env.d.ts
    shared/
      api.ts            # 跨进程 API 类型（type-only）
  tests/
    text.test.ts
    text-simhash.test.ts
    encoding.test.ts
    mojibake.test.ts
    chapters.test.ts
    cleaning.test.ts
    dedupe.test.ts
    sameBook.test.ts
    pipeline.test.ts
    storage.test.ts
    import-service.test.ts
```

---

### Task 1: 项目脚手架与文本工具

**Files:**
- Create: `package.json`（由 npm 命令生成后修改字段）
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `vitest.config.ts`
- Create: `.gitignore`
- Create: `src/core/model.ts`
- Create: `src/core/text.ts`
- Create: `src/main/index.ts`
- Create: `src/preload/index.ts`
- Create: `src/renderer/index.html`
- Create: `src/renderer/src/main.tsx`
- Create: `src/renderer/src/App.tsx`
- Create: `src/renderer/src/styles.css`
- Create: `src/renderer/src/env.d.ts`
- Create: `src/shared/api.ts`
- Test: `tests/text.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `stripZeroWidth(s: string): string`
  - `toHalfWidth(s: string): string`
  - `normalizeForHash(s: string): string`
  - `fnv1a(input: string): string`（8 位十六进制）
  - `ReaderApi`（`src/shared/api.ts`）
  - 类型 `ChapterLevel`、`ChapterMeta`、`BookMeta`、`CleanedChapter`、`ImportStats`、`BookProgress`、`Bookmark`、`LibraryEntry`、`AdRule`

- [ ] **Step 1: 初始化 npm 项目并安装依赖**

```bash
cd "D:/Project Files/MyProject/reader"
npm init -y
npm install iconv-lite
npm install -D electron electron-vite vite @vitejs/plugin-react react react-dom @types/react @types/react-dom typescript vitest @types/node
npm pkg set main="./out/main/index.js" private=true version="0.1.0" name="reader"
npm pkg set "scripts.dev=electron-vite dev" "scripts.build=electron-vite build" "scripts.test=vitest run" "scripts.typecheck=tsc --noEmit"
```

- [ ] **Step 2: 写配置文件**

`.gitignore`：

```gitignore
node_modules/
out/
dist/
data/
logs/
*.log
```

`tsconfig.json`：

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["src", "tests", "electron.vite.config.ts", "vitest.config.ts"]
}
```

`vitest.config.ts`：

```ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node'
  }
})
```

`electron.vite.config.ts`：

```ts
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  main: { plugins: [externalizeDepsPlugin()] },
  preload: { plugins: [externalizeDepsPlugin()] },
  renderer: { plugins: [react()] }
})
```

- [ ] **Step 3: 写共享类型 `src/core/model.ts`**

```ts
export type ChapterLevel = 'volume' | 'chapter'

export interface ChapterMeta {
  index: number
  title: string
  level: ChapterLevel
  titleHash: string
  startLine: number
  charCount: number
  simhash: string
  flags: { suspectedDuplicate?: boolean }
}

export interface BookMeta {
  version: 1
  id: string
  title: string
  encoding: string
  chapters: ChapterMeta[]
  createdAt: string
}

export interface CleanedChapter {
  title: string
  level: ChapterLevel
  startLine: number
  paragraphs: string[]
}

export interface ImportStats {
  adLinesRemoved: number
  duplicateParagraphsMerged: number
  suspectedDuplicateChapters: number
}

export interface LibraryEntry {
  id: string
  title: string
  normalizedTitle: string
  sourceFileName: string
  fileHash: string
  encoding: string
  importedAt: string
  lastReadAt: string | null
  chapterCount: number
  progressPercent: number
  stats: ImportStats
}

export interface BookProgress {
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  percent: number
  updatedAt: string
}

export interface Bookmark {
  id: string
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
  createdAt: string
}

export interface AdRule {
  id: string
  name: string
  type: 'line' | 'sentence'
  pattern: string
  enabled: boolean
}
```

- [ ] **Step 4: 写文本工具 `src/core/text.ts`（先写测试前的最小占位会失败，所以先写测试，见 Step 5；此步先创建空文件占位）**

```ts
export {}
```

- [ ] **Step 5: 写失败测试 `tests/text.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { fnv1a, normalizeForHash, stripZeroWidth, toHalfWidth } from '../src/core/text'

describe('text utils', () => {
  it('converts full-width characters to half-width', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123')
  })

  it('strips zero-width characters', () => {
    expect(stripZeroWidth('小\u200b说\ufeff')).toBe('小说')
  })

  it('produces stable 8-char hashes', () => {
    expect(fnv1a('第一章')).toHaveLength(8)
    expect(fnv1a('第一章')).toBe(fnv1a('第一章'))
    expect(fnv1a('第一章')).not.toBe(fnv1a('第二章'))
  })

  it('normalizes punctuation and whitespace for hashing', () => {
    expect(normalizeForHash('第 一 章。')).toBe('第一章')
  })
})
```

- [ ] **Step 6: 运行测试确认失败**

Run: `npx vitest run tests/text.test.ts`
Expected: FAIL，报错类似 `"fnv1a" is not a function` 或 `No "fnv1a" export is defined`。

- [ ] **Step 7: 实现 `src/core/text.ts`**

```ts
const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '')
}

export function toHalfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

export function normalizeForHash(s: string): string {
  return toHalfWidth(stripZeroWidth(s)).replace(/[\s\p{P}]/gu, '').toLowerCase()
}

export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
```

- [ ] **Step 8: 运行测试确认通过**

Run: `npx vitest run tests/text.test.ts`
Expected: 4 passed。

- [ ] **Step 9: 写 Electron 骨架（窗口 + preload + 最小 React 页面）**

`src/shared/api.ts`：

```ts
import type { LibraryEntry } from '../core/model'

export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: { id: string; title: string; overlap: number }[]
  errors: string[]
}

export interface ReaderApi {
  ping(): Promise<string>
  libraryList(): Promise<LibraryEntry[]>
  chooseAndImport(): Promise<ImportSummary>
  onImportProgress(cb: (payload: { fileName: string; stage: string }) => void): () => void
}
```

`src/main/index.ts`：

```ts
import { app, BrowserWindow } from 'electron'
import { join } from 'node:path'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
```

`src/preload/index.ts`：

```ts
import { contextBridge } from 'electron'
import type { ReaderApi } from '../shared/api'

const api: Partial<ReaderApi> = {}

contextBridge.exposeInMainWorld('api', api)
```

`src/renderer/index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Reader</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

`src/renderer/src/main.tsx`：

```tsx
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import './styles.css'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

`src/renderer/src/App.tsx`：

```tsx
export default function App() {
  return (
    <div className="app">
      <h1>Reader</h1>
      <p>书架将在导入功能完成后出现。</p>
    </div>
  )
}
```

`src/renderer/src/styles.css`：

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;
  background: #f5f3ee;
  color: #2b2b2b;
}
.app { padding: 32px; }
```

`src/renderer/src/env.d.ts`：

```ts
import type { ReaderApi } from '../../shared/api'

declare global {
  interface Window {
    api: ReaderApi
  }
}

export {}
```

- [ ] **Step 10: 类型检查与构建**

Run: `npm run typecheck`
Expected: 无输出（通过）。

Run: `npm run build`
Expected: 成功生成 `out/main`、`out/preload`、`out/renderer`。

- [ ] **Step 11: 提交**

```bash
git add package.json package-lock.json electron.vite.config.ts tsconfig.json vitest.config.ts .gitignore src tests
git commit -F - <<'EOF'
chore: Scaffold Electron app with core text utils

Stand up the Electron + TypeScript + React shell and the first pure
helpers so later parsing tasks can be developed test-first.

- Configure electron-vite, strict TypeScript and Vitest
- Add normalization and FNV hashing used by title dedupe
- Add minimal window, preload bridge and shared API types

Related: 无
EOF
```

---

### Task 2: SimHash 指纹工具

**Files:**
- Modify: `src/core/text.ts`
- Test: `tests/text-simhash.test.ts`

**Interfaces:**
- Consumes: `stripZeroWidth`（Task 1）
- Produces:
  - `simhash64(text: string): string`（16 位十六进制）
  - `hamming64(a: string, b: string): number`
  - `toBig(hex: string): bigint`
  - `hammingBig(a: bigint, b: bigint): number`
  - `countCjkRatio(text: string): number`

- [ ] **Step 1: 写失败测试 `tests/text-simhash.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { countCjkRatio, hamming64, simhash64 } from '../src/core/text'

const base = '萧炎缓缓睁开双眼，体内的斗气如同火焰一般在经脉中奔涌，他知道，自己终于突破了斗者九星。'
const similar = '萧炎缓缓睁开双眼，体内的斗气像火焰一般在经脉中奔涌，他知道，自己终于突破了斗者九星。'
const different = '林动站在山巅，望着远处翻滚的云海，心中一片平静，手中长枪微微震颤。'

describe('simhash64', () => {
  it('returns a stable 16-char fingerprint', () => {
    expect(simhash64(base)).toMatch(/^[0-9a-f]{16}$/)
    expect(simhash64(base)).toBe(simhash64(base))
  })

  it('keeps similar text close and different text far apart', () => {
    const near = hamming64(simhash64(base), simhash64(similar))
    const far = hamming64(simhash64(base), simhash64(different))
    expect(near).toBeLessThanOrEqual(8)
    expect(far).toBeGreaterThan(12)
  })

  it('returns all zeros for empty text', () => {
    expect(simhash64('')).toBe('0000000000000000')
  })
})

describe('countCjkRatio', () => {
  it('counts Chinese characters as CJK', () => {
    expect(countCjkRatio('这是中文abc')).toBeCloseTo(4 / 7, 5)
  })

  it('returns 0 for empty text', () => {
    expect(countCjkRatio('')).toBe(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/text-simhash.test.ts`
Expected: FAIL，`simhash64 is not a function`。

- [ ] **Step 3: 追加实现到 `src/core/text.ts`**

```ts
const MASK64 = (1n << 64n) - 1n

function hash64(token: string): bigint {
  let h = 0xcbf29ce484222325n
  for (const ch of token) {
    h ^= BigInt(ch.codePointAt(0)!)
    h = (h * 0x100000001b3n) & MASK64
  }
  return h
}

function shingles(text: string): string[] {
  const t = text.replace(/\s+/g, '')
  if (t.length <= 4) return t ? [t] : []
  const out: string[] = []
  const stride = Math.max(1, Math.floor(t.length / 20000))
  for (let i = 0; i + 4 <= t.length; i += stride) out.push(t.slice(i, i + 4))
  return out
}

export function simhash64(text: string): string {
  const tokens = shingles(text)
  if (tokens.length === 0) return '0000000000000000'
  const v = new Array<number>(64).fill(0)
  for (const token of tokens) {
    const h = hash64(token)
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1
  }
  let out = 0n
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i)
  return out.toString(16).padStart(16, '0')
}

export function toBig(hex: string): bigint {
  return BigInt('0x' + hex)
}

export function hammingBig(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

export function hamming64(a: string, b: string): number {
  return hammingBig(toBig(a), toBig(b))
}

export function countCjkRatio(text: string): number {
  if (!text) return 0
  let cjk = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13 || c === 32) continue
    total++
    if (c >= 0x4e00 && c <= 0x9fff) cjk++
  }
  return total === 0 ? 0 : cjk / total
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/text-simhash.test.ts`
Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/text.ts tests/text-simhash.test.ts
git commit -F - <<'EOF'
feat(core): Add SimHash fingerprint utilities

Chapter duplication and same-book detection both need a robust
content fingerprint that tolerates small edits.

- Implement 4-gram SimHash with bounded sampling
- Add BigInt hamming distance and CJK ratio helpers

Related: 无
EOF
```

---

### Task 3: 编码识别

**Files:**
- Create: `src/core/encoding.ts`
- Test: `tests/encoding.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `decodeBook(buf: Buffer): { encoding: string; text: string }`
  - `isProbablyText(buf: Buffer): boolean`

- [ ] **Step 1: 写失败测试 `tests/encoding.test.ts`**

```ts
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { decodeBook } from '../src/core/encoding'

describe('decodeBook', () => {
  const simplified = '这是一本测试小说，第一章开始。'
  const traditional = '這是一本測試小說，第一章開始。'

  it.each([
    ['utf8', simplified],
    ['gbk', simplified],
    ['gb18030', simplified],
    ['big5', traditional],
    ['utf16le', simplified]
  ] as const)('detects %s input', (encoding, text) => {
    const buf = iconv.encode(text, encoding)
    const result = decodeBook(buf)
    expect(result.encoding).toBe(encoding === 'gbk' ? 'gb18030' : encoding)
    expect(result.text).toBe(text)
  })

  it('honors UTF-8 and UTF-16 BOMs', () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(simplified, 'utf8')])
    expect(decodeBook(utf8)).toEqual({ encoding: 'utf8', text: simplified })

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(simplified, 'utf16le')])
    expect(decodeBook(utf16)).toEqual({ encoding: 'utf16le', text: simplified })
  })

  it('rejects an empty file', () => {
    expect(() => decodeBook(Buffer.alloc(0))).toThrow('空文件')
  })

  it('rejects a binary file renamed to .txt', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
    expect(() => decodeBook(png)).toThrow('不是文本文件')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/encoding.test.ts`
Expected: FAIL，`Cannot find module '../src/core/encoding'`。

- [ ] **Step 3: 实现 `src/core/encoding.ts`**

```ts
import iconv from 'iconv-lite'

const COMMON_HANZI =
  '的一是不了在人有我他这个们中来上大为和国地到以说时要就出会可也你对生能而子那得于着下自之年过发后作里用道行所然家种事成方多经么去法学如都同现当没动面起看定天分还进好小部其些主样理心她本前开但因只从想实日军者意无力它与长把机十民第公此已工使情明性知全三又关点正业外将两高间由问很最重并物手应战向头文体政美相见被利什二等产或新己制身果加西斯月话合回特代内信表化老给世位次度门任常先海通教儿原东声提立及比员解水名真论处走义各入几口认条平系气题活尔更别打女变四神总何电数安少报才结反受目太量再感建务做接必场件计管期市直德资命山金指克许统区保至队形社便空决治展马科司五基眼书非则听白却界达光放强即像难且权思王象完设式色路记南品住告类求据程北边死张该交规万取拉格望觉术领共确传师观清今切院让识候带导争运笑飞风步改收根干造言联持组每济车亲极林服快办议往元英士证近失转夫令准布始怎呢存未远叫台单影具罗字爱击流备兵连调深商算质团集百需价花党华城石级整府离况亚请技际约示复病息究线似官火断精满支视消越器容照须九增研写称企八功吗包片史委乎查轻易早曾除农找装广显阿李标谈吃图念六引历首医局突专费号尽另周较注语仅考落青随选列武红响虽推势参希古众构房半节土投某案黑维革划敌致陈律足态护七兴派孩验责营星够章音跟志底站严巴例防族供效续施留讲型料终答紧黄绝奇察母京段依批群项故按河米围江织害斗双境客纪采举杀攻父苏密低朝友诉止细愿千值仍男钱破网热助倒育属坐帝限船脸职速刻乐否刚威毛状率甚独球般普怕弹校苦创假久错承印晚兰试股拿脑预谁益阳若哪微尼继送急血惊伤素药适波夜省初喜卫源食险待述陆习置居劳财环排福纳欢雷警获模充负云停木游龙树疑层冷洲冲射略范竟句室异激汉村哈策演简卡罪判担州静退既衣您宗积余痛检差富灵协角占配征修皮挥胜降阶审沉坚善妈刘读超免压银买皇养伊怀执副乱抗犯追帮宣佛岁航优怪香著田铁控税左右份穿艺背阵草脚概恶块顿敢守酒岛托央户烈洋哥索胡款靠评版宝座释景顾弟登货互付伯慢欧换闻危忙核暗姐介坏讨丽良序升监临亮露永呼味野架域沙掉括舰鱼杂误湾吉减编楚肯测败屋跑梦散温困剑渐封救贵枪缺楼县尚毫移娘朋画班智亦耳恩短掌恐遗固席松秘谢鲁遇康虑幸均销钟诗藏赶剧票损忽巨炮旧端探湖录叶春乡附吸予礼港雨板庭妇归睛饭额含顺输摇招婚脱补谓督毒油疗旅泽材灭逐莫笔亡鲜词圣择寻厂睡博勒烟授诺伦岸奥唐卖俄炸载洛健堂旁宫喝借君禁阴园谋宋避抓荣姑孙逃牙束跳顶玉镇雪午练迫爷篇肉嘴馆遍凡础洞卷坦牛宁纸诸训私庄祖丝翻暴森塔默握戏隐熟骨访弱蒙歌店鬼软典欲萨伙遭盘爸扩盖弄雄稳忘亿刺拥徒姆杨齐赛趣曲刀床迎冰虚玩析窗醒妻透购替塞努休虎扬途侵刑绿兄迅套贸毕唯谷轮库迹尤竞街促延震弃甲伟麻川申缓潜闪售灯针哲络抵朱埃抱鼓植纯夏忍页杰筑折郑贝尊吴秀混臣雅振染盛怒舞圆搞狂措姓残秋培迷诚宽宇猛摆梅毁伸摩盟末乃悲拍丁赵硬麦蒋操耶阻订彩抽赞魔纷沿喊违妹浪汇币丰蓝殊献桌瓦莱援译夺汽烧距裁偏符勇触课敬哭懂墙袭召罚侠厅拜巧侧韩冒债曼融惯享戴童犹乘挂奖绍厚纵障讯涉彻刊丈爆乌役描洗玛患妙镜唱烦签仙彼弗症仿倾牌陷鸟轰咱菜闭奋庆撤泪茶疾缘播朗杜奶季丹狗尾仪偷奔珠虫驻孔宜艾桥淡翼恨繁寒伴叹旦愈潮粮缩罢聚径恰挑袋灰捕徐珍幕映裂泰隔启尖忠累炎暂估泛荒偿横拒瑞忆孤鼻闹羊呆厉衡胞零穷舍码赫婆魂灾洪腿胆津俗辩胸晓劲贫仁偶辑邦恢赖圈摸仰润堆碰艇稍迟辆废净凶署壁御奉旋冬矿抬蛋晨伏吹鸡倍糊秦盾杯租骑乏隆诊奴摄丧污渡旗甘耐凭扎抢绪粗肩梁幻菲皆碎宙叔岩荡综爬荷悉蒂返井壮薄悄扫敏碍殖详迪矛霍允幅撒剩凯颗骂赏液番箱贴漫酸郎腰舒眉忧浮辛恋餐吓挺励辞艘键伍峰尺昨黎辈贯侦滑券崇扰宪绕趋慈乔阅汗枝拖墨胁插箭腊粉泥氏彭拔骗凤慧媒佩愤扑龄驱惜豪掩兼跃尸肃帕驶堡届欣惠册储飘桑闲惨洁踪勃宾频仇磨递邪撞拟滚奏巡颜剂绩贡疯坡瞧截燃焦殿伪柳锁逼颇昏劝呈搜勤戒驾漂饮曹朵仔柔俩孟腐幼践籍牧凉牲佳娜浓芳稿竹腹跌逻垂遵脉貌柏狱猜怜惑陶兽帐饰贷昌叙躺钢沟寄扶铺邓寿惧询汤盗肥尝匆辉奈扣廷澳嘛董迁凝慰厌脏腾幽怨鞋丢埋泉涌辖躲晋紫艰魏吾慌祝邮吐狠鉴械咬邻赤挤弯椅陪割揭韦悟聪雾锋梯猫祥阔誉筹丛牵鸣沈阁穆屈旨袖猎臂蛇贺柱抛鼠瑟戈牢逊迈欺吨琴衰瓶恼燕仲诱狼池疼卢仗冠粒遥吕玄尘冯抚浅敦纠钻晶岂峡苍喷耗凌敲菌赔涂粹扁亏寂煤熊恭湿循暖糖赋抑秩帽哀宿踏烂袁侯抖夹昆肝擦猪炼恒慎搬纽纹玻渔磁铜齿跨押怖漠疲叛遣兹祭醉拳弥斜档稀捷肤疫肿豆削岗晃吞宏癌肚隶履涨耀扭坛拨沃绘伐堪仆郭牺歼墓雇廉契拼惩捉覆刷劫嫌瓜歇雕闷乳串娃缴唤赢莲霸桃妥瘦搭赴岳嘉舱俊址庞耕锐缝悔邀玲惟斥宅添挖呵讼氧浩羽斤酷掠妖祸侍乙妨贪挣汪尿莉悬唇翰仓轨枚盐览傅帅庙芬屏寺胖璃愚滴疏萧姿颤丑劣柯寸扔盯辱匹俱辨饿蜂哦腔郁溃谨糟葛苗肠忌溜鸿爵鹏鹰笼丘桂滋聊挡纲肌茨壳痕碗穴膀卓贤卧膜毅锦欠哩函茫昂薛皱夸豫胃舌剥傲拾窝睁携陵哼棉晴铃填饲渴吻扮逆脆喘罩卜炉柴愉绳胎蓄眠竭喂傻慕浑奸扇柜悦拦诞饱乾泡贼亭夕爹酬儒姻卵氛泄杆挨僧蜜吟猩遂狭肖甜霞驳裕顽於摘矮秒卿畜咽披辅勾盆疆赌塑畏吵囊嗯泊肺骤缠冈羞瞪吊贾漏斑涛悠鹿俘锡卑葬铭滩嫁催璇翅盒蛮矣潘歧赐鲍锅廊拆灌勉盲宰佐啥胀扯蔓'

function scoreText(text: string): number {
  if (!text) return 0
  let common = 0
  let total = 0
  let bad = 0
  let control = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13) continue
    total++
    if (COMMON_HANZI.includes(ch)) common++
    if (c === 0xfffd) bad++
    if (c < 0x20 && c !== 9) control++
  }
  if (total === 0) return 0
  return common / total - (bad / total) * 2 - (control / total) * 2
}

function tryStrictUtf8(buf: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return null
  }
}

function looksReasonable(text: string): boolean {
  if (!text) return false
  let control = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 9 || c === 10 || c === 13) continue
    total++
    if (c < 0x20 || c === 0x7f) control++
  }
  return total === 0 || control / total < 0.01
}

function decodeUtf16be(buf: Buffer): string {
  const even = buf.length % 2 === 0 ? buf : buf.subarray(0, buf.length - 1)
  return Buffer.from(even).swap16().toString('utf16le')
}

function nulRatio(buf: Buffer): number {
  const sample = buf.subarray(0, Math.min(buf.length, 8192))
  let nul = 0
  for (const b of sample) if (b === 0) nul++
  return sample.length === 0 ? 0 : nul / sample.length
}

export function isProbablyText(buf: Buffer): boolean {
  return buf.length > 0 && nulRatio(buf) < 0.01
}

export interface DecodeResult {
  encoding: string
  text: string
}

export function decodeBook(buf: Buffer): DecodeResult {
  if (buf.length === 0) throw new Error('空文件')

  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return { encoding: 'utf8', text: iconv.decode(buf.subarray(3), 'utf8') }
  }
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
    return { encoding: 'utf16le', text: iconv.decode(buf.subarray(2), 'utf16le') }
  }
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    return { encoding: 'utf16be', text: decodeUtf16be(buf.subarray(2)) }
  }

  const strictUtf8 = tryStrictUtf8(buf)
  if (strictUtf8 !== null && looksReasonable(strictUtf8)) return { encoding: 'utf8', text: strictUtf8 }

  const binaryLikely = !isProbablyText(buf)
  const candidates = [
    { encoding: 'gb18030', text: iconv.decode(buf, 'gb18030') },
    { encoding: 'big5', text: iconv.decode(buf, 'big5') },
    { encoding: 'utf16le', text: iconv.decode(buf, 'utf16le') }
  ]

  let best = candidates[0]
  let bestScore = -Infinity
  for (const candidate of candidates) {
    const score = scoreText(candidate.text.slice(0, 65536))
    if (score > bestScore) {
      bestScore = score
      best = candidate
    }
  }

  if (binaryLikely && bestScore < 0.15) throw new Error('不是文本文件')
  if (bestScore < 0.02) throw new Error('无法识别的文本编码')
  return { encoding: best.encoding, text: best.text }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/encoding.test.ts`
Expected: 8 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/encoding.ts tests/encoding.test.ts
git commit -F - <<'EOF'
feat(core): Detect text encoding on import

Web novel downloads arrive as UTF-8, GBK or Big5 with no reliable
metadata, so detection must be deterministic and explainable.

- Honor BOMs and strict UTF-8 before scoring candidates
- Score GB18030, Big5 and UTF-16LE by common-hanzi ratio
- Reject empty and binary files with clear errors

Related: 无
EOF
```

---

### Task 4: 乱码修复

**Files:**
- Create: `src/core/mojibake.ts`
- Test: `tests/mojibake.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `repairMojibake(text: string, encoding: string): { text: string; repaired: boolean; warnings: string[] }`

- [ ] **Step 1: 写失败测试 `tests/mojibake.test.ts`**

```ts
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { repairMojibake } from '../src/core/mojibake'

const original = '这是一本测试小说，第一章开始。'

describe('repairMojibake', () => {
  it('repairs UTF-8 bytes that were read as Latin-1', () => {
    const broken = iconv.decode(iconv.encode(original, 'utf8'), 'latin1')
    const result = repairMojibake(broken, 'utf8')
    expect(result.repaired).toBe(true)
    expect(result.text).toBe(original)
  })

  it('repairs GBK bytes that were read as Latin-1', () => {
    const broken = iconv.decode(iconv.encode(original, 'gbk'), 'latin1')
    const result = repairMojibake(broken, 'gb18030')
    expect(result.repaired).toBe(true)
    expect(result.text).toBe(original)
  })

  it('strips burned replacement sequences and warns', () => {
    const result = repairMojibake('正文开始锟斤拷锟斤拷正文继续', 'gb18030')
    expect(result.text.includes('锟')).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('leaves clean text untouched', () => {
    const result = repairMojibake(original, 'utf8')
    expect(result.repaired).toBe(false)
    expect(result.text).toBe(original)
    expect(result.warnings).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/mojibake.test.ts`
Expected: FAIL，`Cannot find module '../src/core/mojibake'`。

- [ ] **Step 3: 实现 `src/core/mojibake.ts`**

```ts
import iconv from 'iconv-lite'

export interface RepairResult {
  text: string
  repaired: boolean
  warnings: string[]
}

function mojibakeScore(text: string): number {
  if (!text) return 0
  let latin = 0
  let burned = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13 || c === 32) continue
    total++
    if (c >= 0x00a0 && c <= 0x00ff) latin++
    if (ch === '锟' || c === 0xfffd) burned++
  }
  if (total === 0) return 0
  return (latin + burned * 3) / total
}

export function repairMojibake(text: string, encoding: string): RepairResult {
  const warnings: string[] = []
  if (!text) return { text, repaired: false, warnings }

  const hadBurned = /[�锟]/.test(text)
  let working = text
  if (hadBurned) {
    working = working.replace(/锟斤拷/g, '').replace(/[锟�]+/g, '')
    warnings.push('部分乱码内容无法恢复，已清除')
  }

  const before = mojibakeScore(working)
  if (before < 0.05) {
    return { text: working, repaired: hadBurned, warnings }
  }

  const candidates: string[] = []
  if (/[\u00a0-\u00ff]/.test(text) && encoding !== 'utf16le' && encoding !== 'utf16be') {
    const latin = Buffer.from(working, 'latin1')
    candidates.push(iconv.decode(latin, 'utf8'))
    candidates.push(iconv.decode(latin, 'gb18030'))
  }

  let bestText = working
  let bestScore = before
  for (const candidate of candidates) {
    const score = mojibakeScore(candidate)
    if (score < bestScore) {
      bestScore = score
      bestText = candidate
    }
  }

  if (bestText === working) return { text: working, repaired: hadBurned, warnings }

  if (/[\uFFFD锟斤拷]/.test(bestText)) {
    bestText = bestText.replace(/\uFFFD+/g, '').replace(/锟斤拷/g, '')
    warnings.push('部分乱码内容无法恢复，已清除')
  }

  return { text: bestText, repaired: true, warnings }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/mojibake.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/mojibake.ts tests/mojibake.test.ts
git commit -F - <<'EOF'
feat(core): Repair double-encoded mojibake text

Downloaded TXT files are often re-encoded twice, producing Latin-1
garbage or burned replacement runs that no encoding switch can fix.

- Detect Latin-1 and replacement-run corruption by character mix
- Reverse the wrong decode only when the result scores cleaner
- Strip unrecoverable replacement runs with an explicit warning

Related: 无
EOF
```

---

### Task 5: 章节切分

**Files:**
- Create: `src/core/chapters.ts`
- Test: `tests/chapters.test.ts`

**Interfaces:**
- Consumes: `normalizeForHash`、`fnv1a`（Task 1）
- Produces:
  - `cnNumberToInt(s: string): number | null`
  - `normalizeTitleForHash(title: string): string`
  - `chapterTitleHash(title: string): string`
  - `parseChapterOrdinal(title: string): number | null`
  - `isChapterTitleLine(raw: string): { title: string; level: ChapterLevel } | null`
  - `splitChapters(text: string): { detected: boolean; chapters: SplittedChapter[] }`
  - `splitAtMarkerLines(text: string, markerLines: number[]): { detected: boolean; chapters: SplittedChapter[] }`
  - 类型 `SplittedChapter { title: string; level: ChapterLevel; startLine: number; paragraphs: string[] }`

- [ ] **Step 1: 写失败测试 `tests/chapters.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  chapterTitleHash,
  cnNumberToInt,
  parseChapterOrdinal,
  splitAtMarkerLines,
  splitChapters
} from '../src/core/chapters'

const sample = [
  '第一章 风起',
  '正文第一段。',
  '他翻到第三章。',
  '第二章 云涌',
  '正文第二段。',
  '【第三章】雨落',
  '正文第三段。'
].join('\n')

describe('splitChapters', () => {
  it('splits common chapter titles and ignores sentence look-alikes', () => {
    const result = splitChapters(sample)
    expect(result.detected).toBe(true)
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 风起', '第二章 云涌', '【第三章】雨落'])
    expect(result.chapters[0].paragraphs).toEqual(['正文第一段。', '他翻到第三章。'])
  })

  it('treats short text without markers as one chapter', () => {
    const result = splitChapters('只有一段文字，没有任何章节。')
    expect(result.detected).toBe(false)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].title).toBe('正文')
    expect(result.chapters[0].paragraphs).toEqual(['只有一段文字，没有任何章节。'])
  })

  it('splits at manually supplied marker lines', () => {
    const text = ['第一章 甲', '内容一', '第二章 乙', '内容二'].join('\n')
    const result = splitAtMarkerLines(text, [0, 2])
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 甲', '第二章 乙'])
    expect(result.chapters[0].paragraphs).toEqual(['内容一'])
  })
})

describe('chapter numbering', () => {
  it('parses Chinese numerals', () => {
    expect(cnNumberToInt('五百零二')).toBe(502)
    expect(cnNumberToInt('十二')).toBe(12)
    expect(cnNumberToInt('三')).toBe(3)
    expect(cnNumberToInt('abc')).toBeNull()
  })

  it('hash-normalizes Arabic and Chinese chapter numbers equally', () => {
    expect(chapterTitleHash('第12章 风起')).toBe(chapterTitleHash('第十二章 风起'))
  })

  it('extracts chapter ordinals', () => {
    expect(parseChapterOrdinal('第五百零二章 决战')).toBe(502)
    expect(parseChapterOrdinal('序章')).toBeNull()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/chapters.test.ts`
Expected: FAIL，`Cannot find module '../src/core/chapters'`。

- [ ] **Step 3: 实现 `src/core/chapters.ts`**

```ts
import type { ChapterLevel } from './model'
import { fnv1a, normalizeForHash } from './text'

export interface SplittedChapter {
  title: string
  level: ChapterLevel
  startLine: number
  paragraphs: string[]
}

export interface SplitResult {
  detected: boolean
  chapters: SplittedChapter[]
}

const DIGITS: Record<string, number> = {
  零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4,
  五: 5, 六: 6, 七: 7, 八: 8, 九: 9
}
const UNITS: Record<string, number> = { 十: 10, 百: 100, 千: 1000 }

export function cnNumberToInt(s: string): number | null {
  if (/^\d+$/.test(s)) return parseInt(s, 10)
  let total = 0
  let current = 0
  for (const ch of s) {
    if (ch in DIGITS) {
      current = DIGITS[ch]
    } else if (ch in UNITS) {
      total += (current === 0 ? 1 : current) * UNITS[ch]
      current = 0
    } else if (ch === '万') {
      total = (total + current) * 10000
      current = 0
    } else {
      return null
    }
  }
  return total + current
}

const VOLUME_RE = /^第[零〇一二两三四五六七八九十百千万0-9]+[卷部集篇]/
const CHAPTER_RE = /^第[零〇一二两三四五六七八九十百千万0-9]+[章节回]/
const SPECIAL_RE = /^(序章|楔子|引子|前言|序言|尾声|终章|大结局|完本感言|后记|番外)/
const BRACKET_RE = /^[【\[（(]\s*第[^】\]）)]{1,24}[章节回][^】\]）)]{0,24}[】\]）)]/
const ENGLISH_RE = /^chapter\s+\d+/i

export function isChapterTitleLine(raw: string): { title: string; level: ChapterLevel } | null {
  const title = raw.trim()
  if (!title || title.length > 40) return null
  if (/[。！？…]$/.test(title)) return null
  if (/https?:\/\/|www\.|最新章节|请记住本站/.test(title)) return null
  if (VOLUME_RE.test(title)) return { title, level: 'volume' }
  if (CHAPTER_RE.test(title) || SPECIAL_RE.test(title) || BRACKET_RE.test(title) || ENGLISH_RE.test(title)) {
    return { title, level: 'chapter' }
  }
  return null
}

export function normalizeTitleForHash(title: string): string {
  const converted = title.replace(
    /第([零〇一二两三四五六七八九十百千万0-9]+)([章节回卷部集篇])/g,
    (match, num: string, unit: string) => {
      const n = cnNumberToInt(num)
      return n === null ? match : `第${n}${unit}`
    }
  )
  return normalizeForHash(converted)
}

export function chapterTitleHash(title: string): string {
  return fnv1a(normalizeTitleForHash(title))
}

export function parseChapterOrdinal(title: string): number | null {
  const match = /第([零〇一二两三四五六七八九十百千万0-9]+)[章节回卷部集篇]/.exec(title)
  if (!match) return null
  return cnNumberToInt(match[1])
}

interface Candidate {
  line: number
  title: string
  level: ChapterLevel
}

function buildFromCandidates(lines: string[], candidates: Candidate[]): SplitResult {
  const chapters: SplittedChapter[] = []
  const first = candidates[0]
  if (first && first.line > 0) {
    const preface = lines.slice(0, first.line).map((l) => l.trim()).filter(Boolean)
    if (preface.length > 0) {
      chapters.push({ title: '前言', level: 'chapter', startLine: 0, paragraphs: preface })
    }
  }
  candidates.forEach((candidate, index) => {
    const end = index + 1 < candidates.length ? candidates[index + 1].line : lines.length
    const paragraphs = lines.slice(candidate.line + 1, end).map((l) => l.trim()).filter(Boolean)
    chapters.push({ title: candidate.title, level: candidate.level, startLine: candidate.line, paragraphs })
  })
  return { detected: true, chapters }
}

export function splitChapters(text: string): SplitResult {
  const lines = text.split(/\r\n|\r|\n/)
  const candidates: Candidate[] = []
  lines.forEach((line, i) => {
    const hit = isChapterTitleLine(line)
    if (hit) candidates.push({ line: i, title: hit.title, level: hit.level })
  })

  if (candidates.length < 3) {
    const paragraphs = lines.map((l) => l.trim()).filter(Boolean)
    return {
      detected: false,
      chapters: [{ title: '正文', level: 'chapter', startLine: 0, paragraphs }]
    }
  }
  return buildFromCandidates(lines, candidates)
}

export function splitAtMarkerLines(text: string, markerLines: number[]): SplitResult {
  const lines = text.split(/\r\n|\r|\n/)
  const candidates: Candidate[] = markerLines
    .filter((line) => line >= 0 && line < lines.length)
    .sort((a, b) => a - b)
    .map((line) => {
      const hit = isChapterTitleLine(lines[line])
      return { line, title: lines[line].trim(), level: hit?.level ?? 'chapter' }
    })

  if (candidates.length === 0) return splitChapters(text)
  return buildFromCandidates(lines, candidates)
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/chapters.test.ts`
Expected: 6 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/chapters.ts tests/chapters.test.ts
git commit -F - <<'EOF'
feat(core): Split chapters from title patterns

Chapter boundaries drive both the table of contents and duplicate
detection, so false positives are worse than missed markers.

- Recognize volume, chapter, special, bracketed and English titles
- Reject sentence-like lines by length and ending punctuation
- Fall back to a single chapter and support manual marker lines

Related: 无
EOF
```

---

### Task 6: 广告清洗

**Files:**
- Create: `src/core/cleaning.ts`
- Test: `tests/cleaning.test.ts`

**Interfaces:**
- Consumes: `AdRule`、`CleanedChapter`（Task 1）；`stripZeroWidth`、`normalizeForHash`（Task 1）
- Produces:
  - `BUILTIN_AD_RULES: AdRule[]`
  - `cleanChapters(chapters: SplittedChapter[], rules: AdRule[]): { chapters: CleanedChapter[]; adLinesRemoved: number; duplicateParagraphsMerged: number }`

- [ ] **Step 1: 写失败测试 `tests/cleaning.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { BUILTIN_AD_RULES, cleanChapters } from '../src/core/cleaning'
import type { SplittedChapter } from '../src/core/chapters'

function chapter(paragraphs: string[]): SplittedChapter {
  return { title: '第一章', level: 'chapter', startLine: 0, paragraphs }
}

describe('cleanChapters', () => {
  it('removes built-in ad lines but keeps story paragraphs', () => {
    const result = cleanChapters(
      [chapter(['萧炎推门而入。', 'www.example-novel.com', '请记住本站笔趣阁', '他看到了药老。'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['萧炎推门而入。', '他看到了药老。'])
    expect(result.adLinesRemoved).toBe(2)
  })

  it('merges consecutive duplicate paragraphs', () => {
    const result = cleanChapters(
      [chapter(['第一段内容。', '第一段内容。', '第二段内容。'])],
      BUILTIN_AD_RULES
    )
    expect(result.chapters[0].paragraphs).toEqual(['第一段内容。', '第二段内容。'])
    expect(result.duplicateParagraphsMerged).toBe(1)
  })

  it('removes ad sentences inside short paragraphs only', () => {
    const short = cleanChapters([chapter(['请记住本站。正文很短。'])], BUILTIN_AD_RULES)
    expect(short.chapters[0].paragraphs).toEqual(['正文很短。'])

    const long = '这是一段足够长的正文内容，用来验证短句广告规则不会误伤超过三十字的段落，请记住本站。'
    const kept = cleanChapters([chapter([long])], BUILTIN_AD_RULES)
    expect(kept.chapters[0].paragraphs).toEqual([long])
  })

  it('applies user rules', () => {
    const rules = [
      ...BUILTIN_AD_RULES,
      { id: 'user-1', name: '求收藏', type: 'line' as const, pattern: '求收藏', enabled: true }
    ]
    const result = cleanChapters([chapter(['正文。', '求收藏求推荐票'])], rules)
    expect(result.chapters[0].paragraphs).toEqual(['正文。'])
  })

  it('drops empty chapters content but keeps chapter records', () => {
    const result = cleanChapters([chapter(['www.biquge.com', ''])], BUILTIN_AD_RULES)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].paragraphs).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/cleaning.test.ts`
Expected: FAIL，`Cannot find module '../src/core/cleaning'`。

- [ ] **Step 3: 实现 `src/core/cleaning.ts`**

```ts
import type { SplittedChapter } from './chapters'
import type { AdRule, CleanedChapter } from './model'
import { normalizeForHash, stripZeroWidth } from './text'

export const BUILTIN_AD_RULES: AdRule[] = [
  { id: 'url', name: '网址', type: 'line', pattern: 'https?://|www\\.', enabled: true },
  {
    id: 'site',
    name: '站点与章节广告',
    type: 'line',
    pattern: '笔趣阁|顶点小说|书趣阁|请记住本站|天才一秒记住|一秒记住|最新章节|本章未完',
    enabled: true
  },
  { id: 'contact', name: '引流联系方式', type: 'line', pattern: '公众号|qq群|QQ群|加群|加微信', enabled: true },
  { id: 'mobile', name: '手机阅读提示', type: 'line', pattern: '手机阅读|手机用户请浏览|手机版阅读', enabled: true },
  {
    id: 'sentence',
    name: '短句广告',
    type: 'sentence',
    pattern: '请记住本站|最新章节|一秒记住|加入书签|投推荐票',
    enabled: true
  }
]

export interface CleanResult {
  chapters: CleanedChapter[]
  adLinesRemoved: number
  duplicateParagraphsMerged: number
}

export function cleanChapters(chapters: SplittedChapter[], rules: AdRule[]): CleanResult {
  const lineRules = rules
    .filter((rule) => rule.enabled && rule.type === 'line')
    .map((rule) => new RegExp(rule.pattern))
  const sentenceRules = rules
    .filter((rule) => rule.enabled && rule.type === 'sentence')
    .map((rule) => new RegExp(rule.pattern))

  let adLinesRemoved = 0
  let duplicateParagraphsMerged = 0

  const cleaned = chapters.map((chapter): CleanedChapter => {
    const paragraphs: string[] = []
    let previous = ''

    for (const raw of chapter.paragraphs) {
      const line = stripZeroWidth(raw).replace(/\u3000/g, ' ').trim()
      if (!line) continue

      if (lineRules.some((re) => re.test(line))) {
        adLinesRemoved++
        continue
      }

      let text = line
      if (line.length <= 30) {
        const sentences = line.split(/(?<=[。！？!?])/)
        const kept = sentences.filter((sentence) => !sentenceRules.some((re) => re.test(sentence)))
        if (kept.length !== sentences.length) {
          adLinesRemoved++
          text = kept.join('').trim()
        }
      }
      if (!text) continue

      const normalized = normalizeForHash(text)
      if (normalized && normalized === previous) {
        duplicateParagraphsMerged++
        continue
      }
      previous = normalized
      paragraphs.push(text)
    }

    return {
      title: chapter.title,
      level: chapter.level,
      startLine: chapter.startLine,
      paragraphs
    }
  })

  return { chapters: cleaned, adLinesRemoved, duplicateParagraphsMerged }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/cleaning.test.ts`
Expected: 5 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/cleaning.ts tests/cleaning.test.ts
git commit -F - <<'EOF'
feat(core): Remove ad lines and duplicate paragraphs

Downloaded web novels carry site promos between paragraphs; leaving
them in breaks immersion and inflates duplicate detection noise.

- Ship conservative built-in line and sentence rules
- Merge only consecutive identical paragraphs
- Keep chapter records even when all text was removed

Related: 无
EOF
```

---

### Task 7: 重复章节标记

**Files:**
- Create: `src/core/dedupe.ts`
- Test: `tests/dedupe.test.ts`

**Interfaces:**
- Consumes: `toBig`、`hammingBig`（Task 2）
- Produces: `markDuplicateChapters(items: DedupeItem[]): boolean[]`，其中 `DedupeItem { titleHash: string; simhash: string; charCount: number }`

- [ ] **Step 1: 写失败测试 `tests/dedupe.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import { markDuplicateChapters } from '../src/core/dedupe'
import { simhash64 } from '../src/core/text'

const textA = '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着，指甲几乎嵌入掌心。'
const textB = '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中却异常平静。'

describe('markDuplicateChapters', () => {
  it('flags later chapters with identical content and title', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length }
    ])
    expect(flags).toEqual([false, true])
  })

  it('flags near-identical content even when titles differ', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'bbb', simhash: simhash64(textA), charCount: textA.length }
    ])
    expect(flags).toEqual([false, true])
  })

  it('does not flag genuinely different chapters', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'bbb', simhash: simhash64(textB), charCount: textB.length }
    ])
    expect(flags).toEqual([false, false])
  })

  it('does not flag chapters with very different lengths', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length * 3 }
    ])
    expect(flags).toEqual([false, false])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/dedupe.test.ts`
Expected: FAIL，`Cannot find module '../src/core/dedupe'`。

- [ ] **Step 3: 实现 `src/core/dedupe.ts`**

```ts
import { hammingBig, toBig } from './text'

export interface DedupeItem {
  titleHash: string
  simhash: string
  charCount: number
}

export function markDuplicateChapters(items: DedupeItem[]): boolean[] {
  const flags = new Array<boolean>(items.length).fill(false)
  const sims = items.map((item) => toBig(item.simhash))

  const byTitle = new Map<string, number[]>()
  items.forEach((item, index) => {
    const list = byTitle.get(item.titleHash) ?? []
    list.push(index)
    byTitle.set(item.titleHash, list)
  })

  for (const list of byTitle.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a]
        const j = list[b]
        if (flags[j]) continue
        const ratio = items[i].charCount / Math.max(1, items[j].charCount)
        if (ratio < 0.8 || ratio > 1.25) continue
        if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (flags[j]) continue
      const ratio = items[i].charCount / Math.max(1, items[j].charCount)
      if (ratio < 0.8 || ratio > 1.25) continue
      if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
    }
  }

  return flags
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/dedupe.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/dedupe.ts tests/dedupe.test.ts
git commit -F - <<'EOF'
feat(core): Flag suspected duplicate chapters

Split-volume downloads often repeat chapters; deleting text silently
would lose content, so duplicates are only marked for review.

- Compare normalized titles first, then fuzzy content fingerprints
- Require similar length to avoid flagging short parallel passages
- Never delete; callers decide how to present the flag

Related: 无
EOF
```

---

### Task 8: 同书判定与合并计划

**Files:**
- Create: `src/core/sameBook.ts`
- Test: `tests/sameBook.test.ts`

**Interfaces:**
- Consumes: `BookMeta`、`CleanedChapter`（Task 1）；`hamming64`、`toBig`、`hammingBig`（Task 2）；`chapterTitleHash`、`parseChapterOrdinal`（Task 5）；`simhash64`（Task 2）
- Produces:
  - `normalizeBookTitle(fileName: string): string`
  - `chapterMatchRate(base: BookMeta, other: BookMeta): number`
  - `shouldSuspectSameBook(incomingNormalizedTitle: string, incomingMeta: BookMeta, existingNormalizedTitle: string, existingMeta: BookMeta): boolean`
  - `planMerge(base: MergeSource, incoming: MergeSource): CleanedChapter[]`，其中 `MergeSource { meta: BookMeta; chapters: CleanedChapter[] }`

- [ ] **Step 1: 写失败测试 `tests/sameBook.test.ts`**

```ts
import { describe, expect, it } from 'vitest'
import {
  chapterMatchRate,
  normalizeBookTitle,
  planMerge,
  shouldSuspectSameBook
} from '../src/core/sameBook'
import { chapterTitleHash } from '../src/core/chapters'
import { simhash64 } from '../src/core/text'
import type { BookMeta, ChapterMeta, CleanedChapter } from '../src/core/model'

function makeChapter(index: number, title: string, body: string): { meta: ChapterMeta; chapter: CleanedChapter } {
  const meta: ChapterMeta = {
    index,
    title,
    level: 'chapter',
    titleHash: chapterTitleHash(title),
    startLine: index,
    charCount: body.length,
    simhash: simhash64(body),
    flags: {}
  }
  return { meta, chapter: { title, level: 'chapter', startLine: index, paragraphs: [body] } }
}

function makeBook(id: string, titles: string[], bodyFor: (i: number) => string) {
  const metas: ChapterMeta[] = []
  const chapters: CleanedChapter[] = []
  titles.forEach((title, i) => {
    const built = makeChapter(i, title, bodyFor(i))
    metas.push(built.meta)
    chapters.push(built.chapter)
  })
  const meta: BookMeta = { version: 1, id, title: id, encoding: 'utf8', chapters: metas, createdAt: '2026-01-01T00:00:00.000Z' }
  return { meta, chapters }
}

describe('normalizeBookTitle', () => {
  it('strips volume ranges, brackets, site names and quality tags', () => {
    expect(normalizeBookTitle('斗罗大陆_1-500章.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('《斗罗大陆》501-1000章 精校版.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('斗罗大陆[笔趣阁].txt')).toBe('斗罗大陆')
  })
})

describe('chapterMatchRate', () => {
  it('counts matching chapters by title and content', () => {
    const base = makeBook('a', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    const same = makeBook('b', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    expect(chapterMatchRate(base.meta, same.meta)).toBe(1)
  })

  it('returns zero for unrelated books', () => {
    const base = makeBook('a', ['第一章'], () => '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着。')
    const other = makeBook('b', ['第一章'], () => '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中异常平静。')
    expect(chapterMatchRate(base.meta, other.meta)).toBe(0)
  })
})

describe('shouldSuspectSameBook', () => {
  it('suspects by normalized title even without overlapping chapters', () => {
    const first = makeBook('a', ['第一章'], (i) => `第一册内容${i}`)
    const second = makeBook('b', ['第五百零一章'], () => '第二册内容，和第一册没有重叠章节。')
    expect(shouldSuspectSameBook('斗罗大陆', second.meta, '斗罗大陆', first.meta)).toBe(true)
  })

  it('suspects unrelated titles when content overlaps heavily', () => {
    const first = makeBook('a', ['第一章'], (i) => `相同的正文内容${i}，用于指纹匹配。`)
    const second = makeBook('b', ['第一章'], (i) => `相同的正文内容${i}，用于指纹匹配。`)
    expect(shouldSuspectSameBook('甲书', second.meta, '乙书', first.meta)).toBe(true)
  })

  it('does not suspect unrelated titles and content', () => {
    const first = makeBook('a', ['第一章'], () => '萧炎站在广场中央，四周的族人议论纷纷。')
    const second = makeBook('b', ['第一章'], () => '林动抬头望向天空，那里有云层翻涌。')
    expect(shouldSuspectSameBook('甲书', second.meta, '乙书', first.meta)).toBe(false)
  })
})

describe('planMerge', () => {
  it('merges non-overlapping volume ranges in numeric order', () => {
    const first = makeBook('a', ['第一章', '第二章'], (i) => `第一册第${i}章正文`)
    const second = makeBook('b', ['第三章', '第四章'], (i) => `第二册第${i}章正文`)
    const merged = planMerge(first, second)
    expect(merged.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章', '第四章'])
  })

  it('deduplicates overlapping chapters and keeps the longer copy', () => {
    const body = '重叠章节的正文内容足够长，用于验证去重逻辑。'
    const first = makeBook('a', ['第一章', '第二章'], (i) => (i === 1 ? body : `第一册第${i}章正文`))
    const second = makeBook('b', ['第二章', '第三章'], (i) => (i === 0 ? body : `第二册第${i}章正文`))
    const merged = planMerge(first, second)
    expect(merged.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章'])
  })

  it('keeps both chapters when titles match but content differs', () => {
    const first = makeBook('a', ['第一章'], () => '第一本书里第一章的正文，内容和其他书完全不同。')
    const second = makeBook('b', ['第一章'], () => '另一本同名书的第一章，讲的是另一个完全不同的故事。')
    const merged = planMerge(first, second)
    expect(merged).toHaveLength(2)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/sameBook.test.ts`
Expected: FAIL，`Cannot find module '../src/core/sameBook'`。

- [ ] **Step 3: 实现 `src/core/sameBook.ts`**

```ts
import { parseChapterOrdinal } from './chapters'
import type { BookMeta, CleanedChapter } from './model'
import { hammingBig, toBig } from './text'

export interface MergeSource {
  meta: BookMeta
  chapters: CleanedChapter[]
}

const NOISE_PATTERNS: RegExp[] = [
  /\d+\s*[-~—至]\s*\d+\s*章?/g,
  /https?:\/\/\S+/gi,
  /www\.[a-z0-9.-]+/gi,
  /《|》/g,
  /[\[【（(][^\]】）)]*[\]】）)]/g,
  /(全本|完结|精校版|无错版|全集|txt|下载|小说|电子书|最新章节)/gi,
  /(笔趣阁|顶点小说|书趣阁)/g
]

export function normalizeBookTitle(fileName: string): string {
  let title = fileName.replace(/\.txt$/i, '')
  for (const pattern of NOISE_PATTERNS) title = title.replace(pattern, '')
  return title.replace(/[\s_\-—]+/g, '').toLowerCase()
}

export function chapterMatchRate(base: BookMeta, other: BookMeta): number {
  const small = base.chapters.length <= other.chapters.length ? base.chapters : other.chapters
  const large = base.chapters.length <= other.chapters.length ? other.chapters : base.chapters
  if (small.length === 0) return 0

  const index = new Map<string, bigint[]>()
  for (const chapter of large) {
    const list = index.get(chapter.titleHash) ?? []
    list.push(toBig(chapter.simhash))
    index.set(chapter.titleHash, list)
  }

  let matched = 0
  for (const chapter of small) {
    const candidates = index.get(chapter.titleHash)
    if (!candidates) continue
    const fingerprint = toBig(chapter.simhash)
    if (candidates.some((candidate) => hammingBig(candidate, fingerprint) <= 3)) matched++
  }
  return matched / small.length
}

export function shouldSuspectSameBook(
  incomingNormalizedTitle: string,
  incomingMeta: BookMeta,
  existingNormalizedTitle: string,
  existingMeta: BookMeta
): boolean {
  if (incomingNormalizedTitle && incomingNormalizedTitle === existingNormalizedTitle) return true
  return chapterMatchRate(incomingMeta, existingMeta) >= 0.05
}

export function planMerge(base: MergeSource, incoming: MergeSource): CleanedChapter[] {
  const chapters = [...base.chapters]
  const sims = base.meta.chapters.map((chapter) => toBig(chapter.simhash))
  const titleIndex = new Map<string, number[]>()
  base.meta.chapters.forEach((chapter, index) => {
    const list = titleIndex.get(chapter.titleHash) ?? []
    list.push(index)
    titleIndex.set(chapter.titleHash, list)
  })

  for (let j = 0; j < incoming.chapters.length; j++) {
    const chapter = incoming.chapters[j]
    const meta = incoming.meta.chapters[j]
    const sameTitle = titleIndex.get(meta.titleHash) ?? []
    const fingerprint = toBig(meta.simhash)

    let matched = false
    for (const index of sameTitle) {
      if (hammingBig(sims[index], fingerprint) <= 3) {
        matched = true
        const existingLength = chapters[index].paragraphs.join('').length
        if (meta.charCount > existingLength) {
          chapters[index] = chapter
          sims[index] = fingerprint
        }
        break
      }
    }

    if (!matched) {
      titleIndex.set(meta.titleHash, [...(titleIndex.get(meta.titleHash) ?? []), chapters.length])
      chapters.push(chapter)
      sims.push(fingerprint)
    }
  }

  const ordinals = chapters.map((chapter) => parseChapterOrdinal(chapter.title))
  if (ordinals.every((ordinal) => ordinal !== null)) {
    const order = chapters
      .map((_, index) => index)
      .sort((a, b) => ordinals[a]! - ordinals[b]! || a - b)
    return order.map((index) => chapters[index])
  }
  return chapters
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/sameBook.test.ts`
Expected: 8 passed。

- [ ] **Step 5: 提交**

```bash
git add src/core/sameBook.ts tests/sameBook.test.ts
git commit -F - <<'EOF'
feat(core): Detect same book and plan merges

Split-volume downloads arrive as separate files; merging must never
silently drop chapters or merge unrelated books that share a title.

- Normalize noisy file names and match chapters by title plus content
- Treat title match or 5% content overlap as a suspect, never silent
- Merge overlaps only when content is near-identical, keeping longer copy
- Keep both chapters on title collision with different content

Related: 无
EOF
```

---

### Task 9: 导入解析管线

**Files:**
- Create: `src/core/pipeline.ts`
- Test: `tests/pipeline.test.ts`

**Interfaces:**
- Consumes: `decodeBook`（Task 3）、`repairMojibake`（Task 4）、`splitChapters`、`chapterTitleHash`（Task 5）、`cleanChapters`、`BUILTIN_AD_RULES`（Task 6）、`markDuplicateChapters`（Task 7）、`simhash64`（Task 2）、类型（Task 1）
- Produces:
  - `titleFromFileName(fileName: string): string`
  - `buildChapterMetas(chapters: CleanedChapter[]): ChapterMeta[]`
  - `parseBookFile(contents: Buffer, fileName: string, options?: { userRules?: AdRule[]; id?: string; now?: string }): ParseBookResult`
  - 类型 `ParseBookResult { title; encoding; sourceText; chapters; meta; stats; warnings }`

- [ ] **Step 1: 写失败测试 `tests/pipeline.test.ts`**

```ts
import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { parseBookFile } from '../src/core/pipeline'

function makeBookText(count: number): string {
  const lines: string[] = []
  for (let i = 1; i <= count; i++) {
    lines.push(
      `第${i}章 风起云涌`,
      `这是第${i}章的正文内容，用来测试导入流程是否稳定。`,
      'www.example-ad.com',
      `第${i}章的更多正文，故事继续向前推进。`,
      ''
    )
  }
  return lines.join('\n')
}

describe('parseBookFile', () => {
  it('parses a 200-chapter GBK book end to end', () => {
    const buf = iconv.encode(makeBookText(200), 'gbk')
    const result = parseBookFile(buf, '斗罗大陆_1-200章.txt')

    expect(result.encoding).toBe('gb18030')
    expect(result.title).toBe('斗罗大陆_1-200章')
    expect(result.chapters).toHaveLength(200)
    expect(result.meta.chapters).toHaveLength(200)
    expect(result.stats.adLinesRemoved).toBe(200)
    expect(result.chapters[0].paragraphs).toEqual([
      '这是第1章的正文内容，用来测试导入流程是否稳定。',
      '第1章的更多正文，故事继续向前推进。'
    ])
  })

  it('keeps source text for later re-cleaning', () => {
    const buf = iconv.encode(makeBookText(3), 'utf8')
    const result = parseBookFile(buf, '测试小说.txt')
    expect(result.sourceText).toContain('www.example-ad.com')
    expect(result.chapters[0].paragraphs.join('')).not.toContain('www.example-ad.com')
  })

  it('rejects a whitespace-only file', () => {
    expect(() => parseBookFile(Buffer.from('   \n\n  \n'), '空白.txt')).toThrow('文件没有可阅读的正文')
  })

  it('assigns stable title hashes and fingerprints', () => {
    const buf = iconv.encode(makeBookText(3), 'utf8')
    const result = parseBookFile(buf, '测试小说.txt')
    expect(result.meta.chapters[0].titleHash).toHaveLength(8)
    expect(result.meta.chapters[0].simhash).toMatch(/^[0-9a-f]{16}$/)
    expect(result.meta.chapters[0].charCount).toBeGreaterThan(0)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: FAIL，`Cannot find module '../src/core/pipeline'`。

- [ ] **Step 3: 实现 `src/core/pipeline.ts`**

```ts
import { randomUUID } from 'node:crypto'
import { chapterTitleHash, splitChapters } from './chapters'
import { BUILTIN_AD_RULES, cleanChapters } from './cleaning'
import { markDuplicateChapters } from './dedupe'
import { decodeBook } from './encoding'
import { repairMojibake } from './mojibake'
import type { AdRule, BookMeta, ChapterMeta, CleanedChapter, ImportStats } from './model'
import { simhash64 } from './text'

export interface ParseBookResult {
  title: string
  encoding: string
  sourceText: string
  chapters: CleanedChapter[]
  meta: BookMeta
  stats: ImportStats
  warnings: string[]
}

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.txt$/i, '').trim()
  return base || '未命名'
}

export function buildChapterMetas(chapters: CleanedChapter[]): ChapterMeta[] {
  const metas: ChapterMeta[] = chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    level: chapter.level,
    titleHash: chapterTitleHash(chapter.title),
    startLine: chapter.startLine,
    charCount: chapter.paragraphs.join('').length,
    simhash: simhash64(chapter.paragraphs.join('\n')),
    flags: {}
  }))

  const duplicates = markDuplicateChapters(
    metas.map((meta) => ({ titleHash: meta.titleHash, simhash: meta.simhash, charCount: meta.charCount }))
  )
  duplicates.forEach((isDuplicate, index) => {
    if (isDuplicate) metas[index].flags.suspectedDuplicate = true
  })
  return metas
}

export function parseBookFile(
  contents: Buffer,
  fileName: string,
  options: { userRules?: AdRule[]; id?: string; now?: string } = {}
): ParseBookResult {
  const decoded = decodeBook(contents)
  const repair = repairMojibake(decoded.text, decoded.encoding)
  const split = splitChapters(repair.text)
  const cleaned = cleanChapters(split.chapters, [...BUILTIN_AD_RULES, ...(options.userRules ?? [])])

  const paragraphCount = cleaned.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0)
  if (paragraphCount === 0) throw new Error('文件没有可阅读的正文')

  const metas = buildChapterMetas(cleaned.chapters)
  const title = titleFromFileName(fileName)
  const stats: ImportStats = {
    adLinesRemoved: cleaned.adLinesRemoved,
    duplicateParagraphsMerged: cleaned.duplicateParagraphsMerged,
    suspectedDuplicateChapters: metas.filter((meta) => meta.flags.suspectedDuplicate).length
  }
  const meta: BookMeta = {
    version: 1,
    id: options.id ?? randomUUID(),
    title,
    encoding: decoded.encoding,
    chapters: metas,
    createdAt: options.now ?? new Date().toISOString()
  }

  return {
    title,
    encoding: decoded.encoding,
    sourceText: repair.text,
    chapters: cleaned.chapters,
    meta,
    stats,
    warnings: repair.warnings
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/pipeline.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 运行全部测试与类型检查**

Run: `npm test`
Expected: 全部通过。

Run: `npm run typecheck`
Expected: 通过。

- [ ] **Step 6: 提交**

```bash
git add src/core/pipeline.ts tests/pipeline.test.ts
git commit -F - <<'EOF'
feat(core): Add end-to-end import parsing pipeline

One call must turn raw bytes into cleaned chapters plus the metadata
that storage and the reader rely on.

- Chain decode, repair, split, clean and duplicate marking
- Preserve repaired source text for later re-cleaning
- Reject files with no readable paragraphs

Related: 无
EOF
```

---

### Task 10: 存储层

**Files:**
- Create: `src/main/storage/fsUtil.ts`
- Create: `src/main/storage/library.ts`
- Create: `src/main/storage/book.ts`
- Test: `tests/storage.test.ts`

**Interfaces:**
- Consumes: 类型（Task 1）、`CleanedChapter`（Task 1）
- Produces:
  - `atomicWriteJson(path: string, value: unknown, backup?: boolean): Promise<void>`
  - `readJson<T>(path: string): Promise<T | null>`
  - `class LibraryRepository`：`list()`、`save(entries)`、`add(entry)`、`update(id, patch)`、`remove(id)`、`findByFileHash(hash)`
  - `class BookRepository`：`writeBook(book)`、`readMeta(id)`、`readChapter(id, index)`、`readSource(id)`、`readProgress(id)`、`writeProgress(id, value)`
  - 类型 `BookFiles { meta: BookMeta; sourceText: string; chapters: CleanedChapter[] }`、`ProgressFile { progress: BookProgress | null; bookmarks: Bookmark[] }`

- [ ] **Step 1: 写失败测试 `tests/storage.test.ts`**

```ts
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import type { BookMeta, LibraryEntry } from '../src/core/model'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-storage-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

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
    chapterCount: 2,
    progressPercent: 0,
    stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  }
}

function meta(id: string): BookMeta {
  return {
    version: 1,
    id,
    title: id,
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'aaaaaaaa', startLine: 0, charCount: 10, simhash: '0000000000000001', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'bbbbbbbb', startLine: 5, charCount: 10, simhash: '0000000000000002', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('LibraryRepository', () => {
  it('adds, updates and removes entries', async () => {
    const library = new LibraryRepository(root)
    await library.add(entry('a', '甲书'))
    await library.add(entry('b', '乙书'))
    expect((await library.list()).map((e) => e.id)).toEqual(['a', 'b'])

    await library.update('a', { progressPercent: 42 })
    expect((await library.list())[0].progressPercent).toBe(42)

    await library.remove('a')
    expect((await library.list()).map((e) => e.id)).toEqual(['b'])
    expect(await library.findByFileHash('hash-b')).not.toBeNull()
    expect(await library.findByFileHash('hash-a')).toBeNull()
  })

  it('falls back to the backup file when the main index is corrupt', async () => {
    const library = new LibraryRepository(root)
    await library.add(entry('a', '甲书'))
    await library.add(entry('b', '乙书'))
    await writeFile(join(root, 'library.json'), '{ not valid json', 'utf8')
    expect((await library.list()).map((e) => e.id)).toEqual(['a'])
  })
})

describe('BookRepository', () => {
  it('writes a book and reads chapters back', async () => {
    const books = new BookRepository(root)
    const bookMeta = meta('book-1')
    await books.writeBook({
      meta: bookMeta,
      sourceText: '第一章\n第一段。\n第二章\n第二段。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。', '另一段。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二段。'] }
      ]
    })

    expect(await books.readMeta('book-1')).toEqual(bookMeta)
    expect(await books.readChapter('book-1', 0)).toBe('第一段。\n\n另一段。')
    expect(await books.readSource('book-1')).toContain('第一段。')
    expect(await readFile(join(root, 'books', 'book-1', 'chapters', '00000.txt'), 'utf8')).toBe('第一段。\n\n另一段。')
  })

  it('backs up the previous book directory on rewrite', async () => {
    const books = new BookRepository(root)
    const bookMeta = meta('book-1')
    const files = {
      meta: bookMeta,
      sourceText: '原文',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 1, paragraphs: ['第二段。'] }
      ]
    }
    await books.writeBook(files)
    await books.writeBook({ ...files, sourceText: '新的原文' })

    const backups = await readdir(join(root, 'books', 'book-1', 'backup'))
    expect(backups.length).toBe(1)
    expect(await books.readSource('book-1')).toBe('新的原文')
  })

  it('reads and writes progress with bookmarks', async () => {
    const books = new BookRepository(root)
    await books.writeBook({
      meta: meta('book-2'),
      sourceText: '原文',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['第一段。'] },
        { title: '第二章', level: 'chapter', startLine: 1, paragraphs: ['第二段。'] }
      ]
    })
    expect(await books.readProgress('book-2')).toEqual({ progress: null, bookmarks: [] })
    await books.writeProgress('book-2', {
      progress: { chapterKey: 'aaaaaaaa', chapterIndex: 0, paragraphIndex: 1, percent: 50, updatedAt: '2026-01-02T00:00:00.000Z' },
      bookmarks: []
    })
    const stored = await books.readProgress('book-2')
    expect(stored.progress?.percent).toBe(50)
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/storage.test.ts`
Expected: FAIL，`Cannot find module '../src/main/storage/book'`。

- [ ] **Step 3: 实现 `src/main/storage/fsUtil.ts`**

```ts
import { promises as fs } from 'node:fs'
import { dirname } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function atomicWriteJson(path: string, value: unknown, backup = true): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  if (backup && (await pathExists(path))) {
    await fs.copyFile(path, `${path}.bak`)
  }
  await fs.rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}
```

- [ ] **Step 4: 实现 `src/main/storage/library.ts`**

```ts
import { join } from 'node:path'
import type { LibraryEntry } from '../../core/model'
import { atomicWriteJson, readJson } from './fsUtil'

interface LibraryFile {
  version: 1
  entries: LibraryEntry[]
}

export class LibraryRepository {
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

  async save(entries: LibraryEntry[]): Promise<void> {
    await atomicWriteJson(this.file, { version: 1, entries })
  }

  async add(entry: LibraryEntry): Promise<void> {
    const entries = await this.list()
    if (entries.some((existing) => existing.id === entry.id)) return
    entries.push(entry)
    await this.save(entries)
  }

  async update(id: string, patch: Partial<LibraryEntry>): Promise<void> {
    const entries = await this.list()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) return
    entries[index] = { ...entries[index], ...patch }
    await this.save(entries)
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((entry) => entry.id !== id))
  }

  async findByFileHash(fileHash: string): Promise<LibraryEntry | null> {
    const entries = await this.list()
    return entries.find((entry) => entry.fileHash === fileHash) ?? null
  }
}
```

- [ ] **Step 5: 实现 `src/main/storage/book.ts`**

```ts
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { BookMeta, BookProgress, Bookmark, CleanedChapter } from '../../core/model'
import { atomicWriteJson, ensureDir, pathExists, readJson } from './fsUtil'

export interface BookFiles {
  meta: BookMeta
  sourceText: string
  chapters: CleanedChapter[]
}

export interface ProgressFile {
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export class BookRepository {
  constructor(private readonly root: string) {}

  private booksDir(): string {
    return join(this.root, 'books')
  }

  private bookDir(id: string): string {
    return join(this.booksDir(), id)
  }

  async writeBook(files: BookFiles): Promise<void> {
    const booksDir = this.booksDir()
    await ensureDir(booksDir)

    const tmp = join(booksDir, `.tmp-${files.meta.id}`)
    await fs.rm(tmp, { recursive: true, force: true })
    await ensureDir(join(tmp, 'chapters'))

    await fs.writeFile(join(tmp, 'source.txt'), files.sourceText, 'utf8')
    await fs.writeFile(join(tmp, 'meta.json'), JSON.stringify(files.meta, null, 2), 'utf8')

    for (let i = 0; i < files.chapters.length; i++) {
      const name = `${String(files.meta.chapters[i].index).padStart(5, '0')}.txt`
      await fs.writeFile(join(tmp, 'chapters', name), files.chapters[i].paragraphs.join('\n\n'), 'utf8')
    }

    const target = this.bookDir(files.meta.id)
    let backupSource: string | null = null
    if (await pathExists(target)) {
      backupSource = join(booksDir, `.bak-${files.meta.id}-${Date.now()}`)
      await fs.rename(target, backupSource)
    }

    await fs.rename(tmp, target)

    if (backupSource) {
      const backupDir = join(target, 'backup', new Date().toISOString().replace(/[:.]/g, '-'))
      await ensureDir(backupDir)
      const entries = await fs.readdir(backupSource)
      for (const entry of entries) {
        await fs.rename(join(backupSource, entry), join(backupDir, entry))
      }
      await fs.rm(backupSource, { recursive: true, force: true })
      const allBackups = await fs.readdir(join(target, 'backup'))
      if (allBackups.length === 0) await fs.rm(join(target, 'backup'), { recursive: true, force: true })
    }
  }

  async readMeta(id: string): Promise<BookMeta> {
    const meta = await readJson<BookMeta>(join(this.bookDir(id), 'meta.json'))
    if (!meta) throw new Error(`书籍数据缺失：${id}`)
    return meta
  }

  async readChapter(id: string, index: number): Promise<string> {
    const name = `${String(index).padStart(5, '0')}.txt`
    return fs.readFile(join(this.bookDir(id), 'chapters', name), 'utf8')
  }

  async readSource(id: string): Promise<string> {
    return fs.readFile(join(this.bookDir(id), 'source.txt'), 'utf8')
  }

  async readProgress(id: string): Promise<ProgressFile> {
    const stored = await readJson<ProgressFile>(join(this.bookDir(id), 'progress.json'))
    return stored ?? { progress: null, bookmarks: [] }
  }

  async writeProgress(id: string, value: ProgressFile): Promise<void> {
    await atomicWriteJson(join(this.bookDir(id), 'progress.json'), value)
  }
}
```

- [ ] **Step 6: 运行测试确认通过**

Run: `npx vitest run tests/storage.test.ts`
Expected: 4 passed。

- [ ] **Step 7: 提交**

```bash
git add src/main/storage tests/storage.test.ts
git commit -F - <<'EOF'
feat(storage): Persist books and library on disk

A portable reader must survive crashes without corrupting the library
or losing the previous version of a book between rewrites.

- Write books to a temp directory and rename atomically
- Keep the previous book directory under backup/ on rewrite
- Fall back to library.json.bak when the main index is unreadable

Related: 无
EOF
```

---

### Task 11: 导入服务

**Files:**
- Create: `src/main/services/import.ts`
- Test: `tests/import-service.test.ts`

**Interfaces:**
- Consumes: `parseBookFile`（Task 9）、`normalizeBookTitle`、`chapterMatchRate`（Task 8）、`LibraryRepository`（Task 10）、`BookRepository`（Task 10）
- Produces:
  - `class ImportService`：`constructor(library, books, userRules?: () => AdRule[])`、`importFile(filePath: string): Promise<ImportOutcome | DuplicateOutcome>`
  - 类型 `ImportOutcome { entry: LibraryEntry; suspects: { id: string; title: string; overlap: number }[] }`
  - 类型 `DuplicateOutcome { duplicate: true; title: string }`

- [ ] **Step 1: 写失败测试 `tests/import-service.test.ts`**

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportService } from '../src/main/services/import'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-import-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeBookText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(
      `第${i}章 风起云涌`,
      `这是第${i}章的正文内容，用来测试导入流程是否稳定。`,
      'www.example-ad.com',
      `第${i}章的更多正文，故事继续向前推进。`,
      ''
    )
  }
  return lines.join('\n')
}

describe('ImportService', () => {
  it('imports a file and records it in the library', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '斗罗大陆_1-50章.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 50), 'gbk'))

    const outcome = await service.importFile(file)
    if ('duplicate' in outcome) throw new Error('unexpected duplicate')

    expect(outcome.entry.chapterCount).toBe(50)
    expect(outcome.entry.encoding).toBe('gb18030')
    expect(outcome.entry.stats.adLinesRemoved).toBe(50)
    expect((await library.list())).toHaveLength(1)
    expect((await books.readMeta(outcome.entry.id)).chapters).toHaveLength(50)
  })

  it('rejects the same file twice by content hash', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '重复.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
    await service.importFile(file)

    const second = await service.importFile(file)
    expect(second).toMatchObject({ duplicate: true, title: '重复' })
  })

  it('reports a suspect when the second volume shares the normalized title', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const first = join(root, '斗罗大陆_1-50章.txt')
    const second = join(root, '斗罗大陆_51-100章.txt')
    await writeFile(first, iconv.encode(makeBookText(1, 50), 'utf8'))
    await writeFile(second, iconv.encode(makeBookText(51, 100), 'utf8'))

    const firstOutcome = await service.importFile(first)
    if ('duplicate' in firstOutcome) throw new Error('unexpected duplicate')

    const secondOutcome = await service.importFile(second)
    if ('duplicate' in secondOutcome) throw new Error('unexpected duplicate')

    const suspect = secondOutcome.suspects.find((item) => item.id === firstOutcome.entry.id)
    expect(suspect).toBeDefined()
    expect(suspect?.title).toBe('斗罗大陆_1-50章')
    expect((await library.list())).toHaveLength(2)
  })

  it('propagates parse errors without touching the library', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '空.txt')
    await writeFile(file, Buffer.from('   \n\n   '))
    await expect(service.importFile(file)).rejects.toThrow('文件没有可阅读的正文')
    expect(await library.list()).toEqual([])
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/import-service.test.ts`
Expected: FAIL，`Cannot find module '../src/main/services/import'`。

- [ ] **Step 3: 实现 `src/main/services/import.ts`**

```ts
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AdRule, LibraryEntry } from '../../core/model'
import { parseBookFile } from '../../core/pipeline'
import { chapterMatchRate, normalizeBookTitle } from '../../core/sameBook'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export interface ImportOutcome {
  entry: LibraryEntry
  suspects: { id: string; title: string; overlap: number }[]
}

export interface DuplicateOutcome {
  duplicate: true
  title: string
}

export class ImportService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly userRules: () => AdRule[] = () => []
  ) {}

  async importFile(filePath: string): Promise<ImportOutcome | DuplicateOutcome> {
    const contents = await readFile(filePath)
    const fileHash = createHash('sha256').update(contents).digest('hex')

    const existingByHash = await this.library.findByFileHash(fileHash)
    if (existingByHash) return { duplicate: true, title: existingByHash.title }

    const fileName = basename(filePath)
    const parsed = parseBookFile(contents, fileName, { userRules: this.userRules() })

    await this.books.writeBook({
      meta: parsed.meta,
      sourceText: parsed.sourceText,
      chapters: parsed.chapters
    })

    const entry: LibraryEntry = {
      id: parsed.meta.id,
      title: parsed.title,
      normalizedTitle: normalizeBookTitle(fileName),
      sourceFileName: fileName,
      fileHash,
      encoding: parsed.encoding,
      importedAt: parsed.meta.createdAt,
      lastReadAt: null,
      chapterCount: parsed.meta.chapters.length,
      progressPercent: 0,
      stats: parsed.stats
    }
    await this.library.add(entry)

    const suspects: ImportOutcome['suspects'] = []
    for (const other of await this.library.list()) {
      if (other.id === entry.id) continue
      const otherMeta = await this.books.readMeta(other.id)
      const overlap = chapterMatchRate(parsed.meta, otherMeta)
      const sameTitle =
        Boolean(entry.normalizedTitle) && entry.normalizedTitle === other.normalizedTitle
      if (sameTitle || overlap >= 0.05) {
        suspects.push({ id: other.id, title: other.title, overlap })
      }
    }

    return { entry, suspects }
  }
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/import-service.test.ts`
Expected: 4 passed。

- [ ] **Step 5: 运行全部测试与类型检查**

Run: `npm test && npm run typecheck`
Expected: 全部通过。

- [ ] **Step 6: 提交**

```bash
git add src/main/services/import.ts tests/import-service.test.ts
git commit -F - <<'EOF'
feat(app): Import TXT files into the library

Import is the only entry point users have, so it must deduplicate by
content and surface suspected split-volume pairs without acting on them.

- Hash files to reject repeat imports
- Parse, persist and register each accepted book
- Report same-title or content-overlapping suspects for confirmation

Related: 无
EOF
```

---

### Task 12: IPC 与书架界面

**Files:**
- Create: `src/main/services/paths.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/src/App.tsx`
- Modify: `src/renderer/src/styles.css`

**Interfaces:**
- Consumes: `LibraryRepository`、`BookRepository`（Task 10）、`ImportService`（Task 11）、`ReaderApi`、`ImportSummary`（Task 1）
- Produces: 可运行的桌面应用；`window.api.libraryList()`、`window.api.chooseAndImport()` 实际可用。

- [ ] **Step 1: 写数据目录解析 `src/main/services/paths.ts`**

```ts
import { app } from 'electron'
import { dirname, join } from 'node:path'

export function resolveDataDir(): string {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
  }
  if (app.isPackaged) {
    return join(dirname(app.getPath('exe')), 'data')
  }
  return join(process.cwd(), 'data')
}
```

- [ ] **Step 2: 重写 `src/main/index.ts`，注册存储与 IPC**

```ts
import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { basename, join } from 'node:path'
import { ImportService } from './services/import'
import { resolveDataDir } from './services/paths'
import { BookRepository } from './storage/book'
import { LibraryRepository } from './storage/library'

const dataDir = resolveDataDir()
const library = new LibraryRepository(dataDir)
const books = new BookRepository(dataDir)
const importer = new ImportService(library, books)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => 'pong')
  ipcMain.handle('library:list', () => library.list())
  ipcMain.handle('library:choose-import', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    }
    const selection = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

    if (selection.canceled || selection.filePaths.length === 0) {
      return { imported: 0, duplicates: [], suspects: [], errors: [] }
    }

    let imported = 0
    const duplicates: string[] = []
    const suspects: { id: string; title: string; overlap: number }[] = []
    const errors: string[] = []

    for (const file of selection.filePaths) {
      try {
        const outcome = await importer.importFile(file)
        if ('duplicate' in outcome) {
          duplicates.push(outcome.title)
          continue
        }
        imported += 1
        suspects.push(...outcome.suspects)
        win?.webContents.send('import:progress', { fileName: basename(file), stage: 'done' })
      } catch (error) {
        errors.push(`${basename(file)}: ${(error as Error).message}`)
      }
    }

    return { imported, duplicates, suspects, errors }
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
```

- [ ] **Step 3: 重写 `src/preload/index.ts`**

```ts
import { contextBridge, ipcRenderer } from 'electron'
import type { ReaderApi } from '../shared/api'

const api: ReaderApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  chooseAndImport: () => ipcRenderer.invoke('library:choose-import'),
  onImportProgress: (callback) => {
    const listener = (_event: unknown, payload: { fileName: string; stage: string }): void => {
      callback(payload)
    }
    ipcRenderer.on('import:progress', listener)
    return () => {
      ipcRenderer.removeListener('import:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
```

- [ ] **Step 4: 重写 `src/renderer/src/App.tsx` 为书架页**

```tsx
import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../core/model'

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function App() {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName}`)
    })
  }, [])

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
      setMessage(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
      await refresh()
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>我的书架</h1>
        <button onClick={() => void handleImport()} disabled={busy}>
          {busy ? '导入中…' : '导入 TXT'}
        </button>
      </header>

      {progress && <p className="hint">{progress}</p>}
      {message && <p className="hint">{message}</p>}

      {entries.length === 0 ? (
        <p className="empty">书架还是空的，拖入或导入一个 TXT 文件开始阅读。</p>
      ) : (
        <div className="grid">
          {entries.map((entry) => (
            <div className="card" key={entry.id}>
              <div className="cover">{coverInitial(entry.title)}</div>
              <div className="meta">
                <div className="title" title={entry.title}>
                  {entry.title}
                </div>
                <div className="sub">{entry.chapterCount} 章 · {entry.encoding}</div>
                <div className="sub">
                  进度 {entry.progressPercent}% · 广告清理 {entry.stats.adLinesRemoved} 行
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 5: 更新 `src/renderer/src/styles.css`**

```css
* { box-sizing: border-box; }
body {
  margin: 0;
  font-family: 'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif;
  background: #f5f3ee;
  color: #2b2b2b;
}
.app { padding: 24px 32px; }
.toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 16px;
}
.toolbar h1 { font-size: 20px; margin: 0; }
.toolbar button {
  border: none;
  background: #4a6741;
  color: #fff;
  padding: 8px 18px;
  border-radius: 6px;
  font-size: 14px;
  cursor: pointer;
}
.toolbar button:disabled { opacity: 0.6; cursor: default; }
.hint { color: #6b6b6b; font-size: 13px; margin: 8px 0; }
.empty { color: #8a8a8a; margin-top: 64px; text-align: center; }
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 16px;
}
.card {
  display: flex;
  gap: 12px;
  padding: 12px;
  background: #fff;
  border-radius: 8px;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}
.cover {
  width: 56px;
  height: 76px;
  border-radius: 4px;
  background: #4a6741;
  color: #fff;
  font-size: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}
.meta { min-width: 0; }
.title {
  font-size: 14px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.sub { font-size: 12px; color: #8a8a8a; margin-top: 4px; }
```

- [ ] **Step 6: 类型检查与构建**

Run: `npm run typecheck`
Expected: 通过。

Run: `npm run build`
Expected: 构建成功。

- [ ] **Step 7: 手动验收**

Run: `npm run dev`
Expected:
1. 打开窗口，显示"我的书架"空书架；
2. 点击"导入 TXT"，选择一个真实的 TXT 文件，书架出现卡片，显示章节数、编码、广告清理行数；
3. 再次导入同一文件，提示"已在书库"；
4. 关闭应用后重新 `npm run dev`，书架内容仍在（数据在项目根 `data/`）。

如第 2 步出现异常编码或章节数不符预期，记录现象，不要在本任务里改解析核心，回到对应任务的测试补充复现用例。

- [ ] **Step 8: 提交**

```bash
git add src/main src/preload src/renderer
git commit -F - <<'EOF'
feat(ui): Show bookshelf and import progress

The foundation is only real once a user can import a file and see the
resulting book in the app.

- Expose typed IPC for listing and importing books
- Open a native file dialog from the main process
- Render the bookshelf with chapter count, encoding and cleaning stats

Related: 无
EOF
```

---

## 完成标准

- `npm test` 全部通过，`npm run typecheck` 通过，`npm run build` 成功；
- `npm run dev` 可导入真实 TXT，书架正确显示章节数与清洗统计；
- 同一文件重复导入被拦截；分卷文件导入时被标记为"疑似同一本书"；
- 数据保存在项目根 `data/`，重启后仍在。

## 下一份计划

`2026-10-29-reader-app.md`（第二份计划）将基于本计划产出的接口实现：阅读页卷轴模式与虚拟化、排版与主题设置、目录抽屉、全书搜索、书签、进度锚点写入、重新清洗/切章、同书合并弹窗与合并执行、错误处理与打包。接口以本计划各任务的 `Produces` 为准，若有变更需先改本计划并同步。
