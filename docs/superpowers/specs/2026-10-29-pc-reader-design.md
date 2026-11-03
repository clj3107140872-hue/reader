# PC 小说阅读器（Reader）设计规格

- 日期：2026-10-29
- 状态：待评审
- 项目根目录：`reader/`

## 1. 背景与目标

### 1.1 问题

市面上小说阅读软件以手机为主，PC 端体验是附带品；现有桌面阅读器（含 markdown 阅读器）功能单薄，只负责"把文字显示出来"，没有为长时间沉浸阅读和"读懂"做设计。中文网文 TXT 在桌面端尤其缺乏智能解析：编码/乱码、章节切分、广告行、重复内容都需要人工处理。

### 1.2 定位

一款 **Windows 桌面端、离线、单体、绿色** 的小说 TXT 阅读器。第一版核心价值：

1. **干净**——导入即完成编码识别、乱码修复、章节切分、广告清洗、重复识别；
2. **沉浸**——精细排版、宽度自适应、键盘全操作、进度精确记忆；
3. 为后续 **摸鱼模式、网络书源、AI 辅助、TTS 听书** 预留架构位置。

### 1.3 目标用户与约束

- 第一用户即开发者本人，后续无偿分享给朋友；
- **无账号、无云同步、无支付、无任何联网功能**；
- Windows 10/11，绿色便携：程序目录内自带 `data/`，拷贝文件夹即搬迁全部书籍与进度。

### 1.4 成功标准

- 一本 5MB、数百章的典型网文 TXT：从导入到开始阅读 ≤ 1 分钟；
- 全书零乱码、零广告残留、章节完整；
- 连续阅读 1 小时不卡顿、进度不漂移；
- 分卷导入（如 1–500 章、501–1000 章）可被识别为同一本书并无重复合并。

## 2. 范围

### 2.1 MVP（P0）

| # | 能力 | 验收要点 |
|---|---|---|
| 1 | TXT 导入 | 拖拽 / 多选；自动识别 UTF-8 / GBK / GB18030 / UTF-16 / Big5；可手动切编码并实时预览；可修复双重编码乱码 |
| 2 | 章节切分 | 自动识别常见标题格式；识别不足时进入手动标记；切错可改标记后重切，无需重新导入 |
| 3 | 广告清洗 | 内置保守规则；可开关；清洗前后红绿对比预览；用户自定义规则 |
| 4 | 重复识别 | 段落重复合并、重复章节标记（默认不删）、同一文件重复导入拦截 |
| 5 | 同书识别与合并 | 分卷文件合并为一本书，重叠章节自动去重，合并前备份可撤销 |
| 6 | 书架 | 书名、进度、排序、右键操作（重新清洗 / 重新切章 / 查看来源 / 删除） |
| 7 | 阅读器 | 卷轴模式；键盘全操作；排版设置；目录；全书搜索；书签；进度记忆到段落 |
| 8 | 便携 | 绿色版；数据目录随程序；`library.json` 自动备份与回滚 |

### 2.2 非目标（v1 不做）

AI 辅助理解、TTS 听书、网络书源、EPUB/MOBI/PDF/Markdown、书本翻页模式、摸鱼模式、账号、云同步、自动更新、高亮/批注/笔记（数据模型留定位锚点，功能二期）。

## 3. 技术决策

### 3.1 技术栈

**Electron + TypeScript + React + Vite（electron-vite）+ 纯文件存储。**

选择依据：用户基本不写代码、依赖 AI 维护，优先"出错可搜、单一语言、生态成熟"，而不是包体最小。

被否决方案：

- **Tauri 2**：包体小，但引入 Rust 第二语言，编译错误对非程序员是死胡同；
- **Python + PySide6**：解析逻辑好写，但伪装外壳、平滑滚动等 UI 表现力差，摸鱼模式受限；
- **SQLite（better-sqlite3）**：原生模块，每次 Electron 升级需重编译，是典型踩坑点；v1 用 JSON + 分章文件，上层用仓储接口隔离，将来替换不影响业务。

### 3.2 关键决策记录

| 决策 | 结论 |
|---|---|
| 阅读模式 | 卷轴（连续滚动），不做书本翻页 |
| 页面宽度 | 默认舒适宽度，随窗口自适应；有可调最大宽度，可解除 |
| 存储粒度 | 一本书一个文件夹，一章一个文本文件 |
| 原始文本 | 每本书保留 `source.txt`（解码修复后原文），支持不重导入的重新清洗/切章 |
| 重复章节 | 只标记不删除 |
| 清洗强度 | 默认保守：宁漏勿错 |
| 合并同书 | 永不静默合并，弹窗确认，合并前备份 |

## 4. 架构

### 4.1 分层与进程职责

```
renderer（React 界面）
   书架页 · 阅读页 · 设置 · 导入进度
        ▲
        │ preload（contextBridge 暴露类型化 IPC）
        ▼
main（Electron 主进程）
   窗口管理 · IPC 路由 · 导入编排 · 书库/阅读服务
   （二期摸鱼模式：全局快捷键/托盘/窗口呈现集中于此层）
        ▲                    ▲
        │                    │
storage（fs 仓储层）     core（纯 TS 解析核心）
JSON 索引 + 分章文件      编码识别·乱码修复·切分·清洗·去重·合并判定
```

- **core**：纯函数库，不依赖 Electron / fs / DOM；输入字节或字符串，输出结构化章节。可以在 Node 环境直接单测；耗时增大时可整体迁入 worker 线程，只需改调度层。
- **storage**：唯一触碰磁盘的业务层，提供 `LibraryRepository` / `BookRepository` 接口。
- **main**：组合 core + storage，处理 IPC、并行导入、进度事件、窗口。
- **renderer**：只做展示与交互，无 Node 权限。`contextIsolation: true`、`nodeIntegration: false`，全部文件访问经 IPC。

### 4.2 仓库目录结构

```
reader/
  package.json
  electron.vite.config.ts
  src/
    core/
      encoding/        # 编码识别、乱码修复
      chapters/        # 标题识别、切分、手动标记
      cleaning/        # 广告规则、清洗
      dedupe/          # 段落/章节重复、同书判定
      model/           # 共享类型
    main/
      index.ts
      windows.ts       # 窗口创建与呈现（二期摸鱼入口）
      ipc/
      services/        # import / library / reader / settings
    preload/
      index.ts
    renderer/
      src/
        pages/         # Library, Reader
        components/
        state/
  tests/               # core 单测与 fixtures
  docs/
```

## 5. 数据模型与磁盘布局

### 5.1 数据目录（随程序）

```
data/
  library.json              # 书库索引（写入前保留 library.json.bak）
  settings.json             # 全局设置（带 version）
  rules/user-ads.json       # 用户自定义清洗规则
  logs/app.log              # 应用日志，滚动保留
  books/<bookId>/
    source.txt              # 解码+乱码修复后的原文
    meta.json               # 书籍元数据 + 章节列表 + 指纹
    chapters/00000.txt      # 清洗后的章节正文（UTF-8，段落间空一行）
    progress.json           # 阅读进度 + 书签
    backup/                 # 合并/重洗前的备份（如有）
```

- 绿色版判定：打包后取 `process.env.PORTABLE_EXECUTABLE_DIR`，否则取可执行文件目录；开发环境为 `./data`。
- 章节文件名为五位补零索引（从 `00000` 起），与 `meta.json` 的 `index` 一致。
- 原子写入：先写 `books/.tmp-<id>/`，完成后整体改名为 `books/<id>/`；`library.json` 通过临时文件 + rename 写入。

### 5.2 类型定义

```ts
interface LibraryEntry {
  id: string                 // uuid
  title: string
  normalizedTitle: string    // 去噪音、去空白、全半角统一后的书名
  sourceFileName: string
  fileHash: string           // SHA-256，拦截同一文件重复导入
  encoding: string
  importedAt: string
  lastReadAt: string | null
  chapterCount: number
  progressPercent: number
  stats: {
    adLinesRemoved: number
    duplicateParagraphsMerged: number
    suspectedDuplicateChapters: number
  }
}

interface BookMeta {
  version: 1
  id: string
  title: string
  encoding: string
  chapters: ChapterMeta[]
  createdAt: string
}

interface ChapterMeta {
  index: number              // 0 起，等于文件名
  title: string
  level: 'volume' | 'chapter'
  titleHash: string          // 归一化标题（中文数字→阿拉伯、去空白标点）的哈希
  startLine: number          // source.txt 中的起始行号
  charCount: number
  simhash: string            // 正文采样 SimHash（64bit hex）
  flags: { suspectedDuplicate?: boolean }
}

interface BookProgress {
  chapterKey: string         // 章节 titleHash：合并/重切后仍可定位
  chapterIndex: number       // 兜底
  paragraphIndex: number
  percent: number            // 全书百分比
  updatedAt: string
}

interface Bookmark {
  id: string
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
  createdAt: string
}

interface AppSettings {
  version: 1
  theme: 'light' | 'dark' | 'green' | 'sepia'
  typography: {
    fontFamily: string        // 预设中文字体族名
    fontSize: number          // px，默认 18
    lineHeight: number        // 默认 1.8
    paragraphSpacing: number  // em，默认 0.8
    pagePadding: number       // px，默认 32
    maxContentWidth: number | null  // px，默认 860；null = 不限制
  }
  cleaning: { enabled: boolean; enableUserRules: boolean }
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean }
}

interface AdRule {
  id: string
  name: string
  type: 'line' | 'sentence'
  pattern: string            // 正则
  enabled: boolean
}
```

### 5.3 仓储接口（示意）

```ts
interface LibraryRepository {
  list(): Promise<LibraryEntry[]>
  add(entry: LibraryEntry): Promise<void>
  update(id: string, patch: Partial<LibraryEntry>): Promise<void>
  remove(id: string): Promise<void>
}

interface BookRepository {
  readMeta(id: string): Promise<BookMeta>
  writeMeta(id: string, meta: BookMeta): Promise<void>
  readChapter(id: string, index: number): Promise<string>
  writeBook(id: string, files: BookFiles): Promise<void>   // 原子落盘
  readSource(id: string): Promise<string>
  readProgress(id: string): Promise<BookProgress | null>
  writeProgress(id: string, progress: BookProgress): Promise<void>
}
```

## 6. 解析核心（core）

### 6.1 编码识别

顺序：

1. BOM 命中（UTF-8 `EF BB BF`、UTF-16LE `FF FE`、UTF-16BE `FE FF`）直接用；
2. 严格 UTF-8 解码（遇到非法序列即失败）不报错 → 判定 UTF-8；
3. 否则对候选编码（GB18030、Big5、无 BOM 的 UTF-16LE）解码首 64KB 样本并打分：
   - 加分：前 500 高频汉字字符占比；
   - 减分：不可映射/替换字符数、控制字符数；
   - 取加权分最高者；
4. 界面永远提供手动切换编码 + 实时预览，默认选中评分最高项；导入结果记录最终编码。

### 6.2 乱码修复（双重编码）

在解码后立即检测，命中则尝试反解，**还原后常用汉字占比提升才采用**，否则保留原文并提示：

| 病症 | 特征 | 修复 |
|---|---|---|
| 替换符烧毁（`锟斤拷`） | 出现 `EF BF BD` 被按 GBK 解读形成的串 | 尝试反解；信息已丢失时清除垃圾串并提示"部分内容不可恢复" |
| GBK 被当 Latin-1 | 大量 `U+00C0–U+00FF` 拉丁字符、缺少中文标点 | 按 Latin-1 重编码为字节，再按 GBK 解码 |
| UTF-8 被当 Latin-1 | 同上但字节可被 UTF-8 严格解码 | 按 Latin-1 重编码为字节，再按 UTF-8 解码 |

### 6.3 章节切分

标题正则族（示例，实现时集中于规则表）：

- 卷/部/集/篇：`^第[零〇一二三四五六七八九十百千万0-9]+[卷部集篇]`
- 章/节/回：`^第[零〇一二三四五六七八九十百千万0-9]+[章节回]`
- 特殊：`^(序章|楔子|引子|前言|序言|尾声|终章|大结局|完本感言|后记|番外)`
- 括号变体：`^[【\[（(]第.+?[章节回].*[】\]）)]`
- 英文：`^Chapter\s+\d+`

反误判约束（全部满足才算标题行）：

- 整行 ≤ 40 字；
- 不以 `。！？…` 结尾；
- 不含 URL 或广告特征词；
- 同文件有效标题行 ≥ 3，否则判定"未识别到章节"并进入手动标记模式。

兜底与纠正：

- 手动标记模式：展示 `source.txt` 行列表（虚拟滚动），点击勾选标题行；支持按正则批量标记；确认后重切。
- 章节标记（行号列表）独立保存于 `meta.json`；修改标记只重切章节文件，不重新导入。

### 6.4 广告清洗

三层处理，默认全保守：

1. **整行删除**（line 规则）：网址 / `www.` / `最新章节` / `请记住本站` / 站点名黑名单（笔趣阁、顶点、书趣阁等）/ 公众号、QQ群 / `手机阅读` / `本章未完` / `天才一秒记住` 等；
2. **句子级删除**（sentence 规则）：仅当段落 ≤ 30 字且句子含明确广告词组时删除；
3. **卫生清理**：连续空行压缩为一行、全角空格、零宽字符（`​` 等）、行首尾空白。

规则管理：

- 内置规则随程序版本发布；用户规则存 `rules/user-ads.json`（`AdRule[]`），可在设置中增删改、单条开关；
- 每条规则记录命中次数，供发现误伤；
- 导入完成后提供**清洗报告**与**红绿对比预览**（原文 vs 清洗后），可调整规则后重新清洗；
- 清洗只删行/句，不改写正文；任何删除都计入 `stats`。

### 6.5 重复识别

- **规范化**：去所有空白与零宽字符，全角转半角（保留标点）；
- **段落级**：连续重复段落（≥ 2 段）合并为一处；跨章完全相同且 > 50 字的段落仅在同书合并时去重；短句、诗词不处理；
- **章节级**：标题哈希相同，或 SimHash 汉明距离 ≤ 3 且字数比在 0.8–1.25 之间 → 标记 `suspectedDuplicate`（**不删除**，目录显示角标）；
- **文件级**：文件 SHA-256 相同 → 拒绝导入并提示"已在书库"。

### 6.6 同书识别与合并

判定信号：

1. **书名归一化**：文件名剥离噪音——区间（`1-500章`/`501-1000`/`全本`）、书名号、`TXT`/`下载`/`精校版`/`无错版`/`完结`、站点名与域名、`[作者]` 前后缀——去空白、全半角统一；
2. **内容指纹（决定性）**：以章节数较少的一本为分母，章节匹配率 =（标题哈希相同 或 正文 SimHash 汉明 ≤ 3 的章节数）/ 总章节数；**匹配率 ≥ 5% 判定极可能同书**，与文件名无关；
3. **章节序号**：解析"第X章"数字（中文数字→阿拉伯）用于排序与定位重叠区。

流程：

```
导入第二份文件 → 归一化书名匹配 或 内容匹配率 ≥ 5%
  → 弹窗「疑似同一本书」，展示证据（书名匹配/内容重叠百分比）
     ① 合并到《书名》 ② 作为新书导入 ③ 取消
  → 选择合并：
     备份现有 books/<id>/ 至 backup/<时间戳>/
     按 titleHash + 序号对齐章节
     重叠章节保留"清洗后字数更多、广告命中更少"的一版
     新章节按序号插入正确位置
     重写 chapters/ 与 meta.json，更新书库索引
```

进度锚点：`chapterKey` 优先、`chapterIndex` 兜底、`percent` 最后兜底——合并与重切后进度不漂移。

## 7. 导入管线

阶段（每阶段通过 IPC 推送进度事件）：

```
读取文件 → 编码识别 → 解码 → 乱码修复 → 章节切分
        → 广告清洗 → 重复识别 → 指纹计算 → 原子落盘 → 更新书库
```

- 导入前：文件哈希查重；> 50MB 需用户确认；疑似同书走合并询问。
- 导入完成展示：编码、章节数、删除广告行数、合并重复段落数、疑似重复章节数。
- 导入在 main 进程执行；若大文件导致界面卡顿，将 core 调度迁入 worker 线程（只改调度层）。

## 8. 阅读体验

### 8.1 书架页

- 卡片网格：书名首字生成色块封面、书名、进度百分比、疑似重复章节角标；
- 操作：按钮/拖拽导入；排序（最近阅读 / 导入时间 / 书名）；右键菜单（重新清洗 / 重新切章 / 查看来源 / 删除——删除需二次确认，确认后移除书目录与索引项）。

### 8.2 阅读页

- **卷轴模式**：整本书连续滚动，跨章无缝；当前章前后各预挂载一章；单章 > 20 万字符时按 2000 字符分块虚拟化；
- **宽度自适应**：阅读区宽度 = min(窗口宽度 − 页边距 × 2, 最大宽度)；默认最大宽度 860px，可调或设为不限制；窗口任意拖动，内容实时重排；
- **键盘操作**：

| 键 | 行为 |
|---|---|
| `Space` / `PageDown` | 下一屏 |
| `PageUp` / `Shift+Space` | 上一屏 |
| `←` / `→` | 上一章 / 下一章 |
| `Ctrl+F` | 全书搜索（显示进度，可取消，最多返回 300 条，点击跳转并高亮） |
| `Ctrl+B` | 当前段落加/取消书签 |
| `Ctrl+=` / `Ctrl+-` | 字号增大 / 减小 |
| `Esc` | 关闭抽屉 / 返回书架 |
| `F11` | 全屏 |

- **排版**：字体（预设：系统默认、微软雅黑、宋体、楷体、仿宋）、字号、行距、段落间距、页边距、最大宽度、主题（浅色 / 深色 / 护眼绿 / 羊皮纸）；
- **目录**：左侧抽屉，可常驻可隐藏；目录搜索；当前章高亮；疑似重复章节角标；
- **底部进度条**：全书百分比 + 当前章 / 总章数 + 剩余时间估算（按 400 字/分钟）；点击跳转；
- **书签**：`Ctrl+B` 添加当前段落，面板列出"书名 · 章节 · 摘要"；
- **进度**：段落级 `IntersectionObserver` 定位，500ms 防抖写盘，退出强制 flush；写盘同时更新书库索引中的进度百分比与最近阅读时间；窗口大小/位置记忆。

### 8.3 设置

全局设置存 `settings.json`，立即生效；每本书单独记忆阅读位置与书签。

## 9. IPC 接口契约（概览）

```
library:list()                         → LibraryEntry[]
library:import(files: string[])        → 事件流：import:progress / import:done / import:suspect-same-book
import:resolve(token, 'merge' | 'new' | 'cancel')   → 答复同书判定弹窗
library:remove(id)
book:getMeta(id)                       → BookMeta
book:readChapter(id, index)            → string
book:reclean(id) / book:resplit(id)    → 事件流
book:updateMarkers(id, lines: number[])
book:search(id, query)                 → 事件流：search:progress / search:result
progress:get(id) / progress:save(id, p)
bookmark:list(id) / add / remove
settings:get() / settings:update(patch)
```

## 10. 错误处理

原则：每条错误"人能看懂 + 有下一步动作"，不出裸报错。

| 场景 | 处理 |
|---|---|
| 文件读不了（权限/占用） | 提示路径与原因，不中断其他文件导入 |
| 所有编码候选低分 | 不硬导，进入手动选编码 + 实时预览 |
| 超大文件（> 50MB） | 提示预计耗时，确认后继续 |
| 同一文件重复导入 | 文件哈希命中，提示"已在书库" |
| 导入中途崩溃/断电 | 临时目录写入 + 成功后原子改名；失败清理残留 |
| `library.json` 损坏 | 启动自检，从 `.bak` 回滚并提示 |
| 单本书文件损坏 | 书架标记"损坏"，可"从 source.txt 重建" |
| 某章文件缺失 | 从 `source.txt` 重建；失败显示缺失占位，可跳过 |
| 未捕获异常 | 写 `logs/app.log`（滚动保留），界面提示"已记录日志" |
| 阅读中崩溃 | 进度防抖 + 退出 flush，重开回到原处 |

## 11. 测试策略

遵循全局测试规范：只测关键、不追覆盖率、测行为不测实现、不写脆弱测试。

- 自动化测试只覆盖 **core**（Vitest + 合成 fixtures）：
  - 编码识别：UTF-8 / GBK / GB18030 / UTF-16LE / Big5 各一条，断言识别结果与正文关键句；
  - 乱码修复：`锟斤拷`、Latin-1 双重编码各一条；
  - 切章：常见格式一条 + 反误判一条（正文含"第三章"类句子不得切分）；
  - 清洗：广告行删除、正文保留、自定义规则各一条；
  - 去重：重复章节被标记、正常章节不误杀；
  - 合并：两个分段文件合成一书，断言章节数、无重复、顺序正确；
  - 进度锚点：合并后 `chapterKey` 定位正确。
- 一条整本合成书端到端用例（约 200 章跑通导入管线）；
- UI 不写自动化测试，使用手动验收清单；
- 修复 bug 先写复现用例（红），再改代码（绿），保留该用例。

## 12. 扩展点与路线图

扩展点以**契约**形式存在，不写空实现：

- **书源**（P2）：core 的输入契约是"纯文本 + 元数据"，网络书源在同一位置注入内容，清洗/切分/渲染复用；
- **摸鱼模式**（P1）：窗口创建集中于 `main/windows.ts`，窗口能力与快捷键走配置，二期只扩展该模块；
- **AI / TTS**（P2/P3）：消费 core 输出的结构化章节与段落。

| 阶段 | 内容 |
|---|---|
| P0 | 本规格全部内容：导入、清洗、切章、去重、同书合并、书架、卷轴阅读、排版、书签、搜索 |
| P1 | 摸鱼模式（先专项调研：伪装、老板键、透明置顶）、书本翻页模式、EPUB、日夜模式切换（日间 / 夜间 / 跟随系统） |
| P2 | 网络书源、AI 辅助理解（用户可选开启的独立模块） |
| P3 | TTS 听书、其他格式 |

## 13. 风险与对策

| 风险 | 对策 |
|---|---|
| 广告规则误伤正文 | 默认保守；规则可开关；红绿预览；规则命中计数 |
| 编码探测误判 | 多信号打分；界面可手动切换并实时预览 |
| SimHash 判重误杀 | 只标记不删；阈值保守；可人工取消标记 |
| 书名噪点无法穷举 | 内容指纹为主证据，文件名只作辅助 |
| 单章超大渲染卡顿 | 单章分块虚拟化；跨章只挂载相邻章 |
| Electron 包体/内存偏大 | 个人与朋友场景可接受；P1 再评估 |
| 绿色版写盘权限（Program Files） | 绿色目录部署；检测不可写时提示更换目录 |

## 14. 术语

- **卷轴模式**：全文连续上下滚动的阅读方式，跨章无缝衔接。
- **书源**：手机阅读类 App 的规则文件，声明搜索/目录/正文的提取方式，用于抓取网络小说站点。
- **摸鱼模式**：让阅读界面伪装成工作窗口、可一键隐藏/淡化的桌面端特性（P1 专项设计）。
- **锟斤拷**：UTF-8 替换字符被错误按 GBK 解码后形成的典型乱码串。
