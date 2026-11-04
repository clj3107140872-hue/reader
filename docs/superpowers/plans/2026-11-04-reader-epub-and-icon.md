# EPUB 支持与应用图标实施计划

> **For agentic workers:** 按任务顺序执行；core 解析先写失败测试（TDD），再做导入与界面接入。

**Goal:** 让阅读器直接导入无 DRM 的 EPUB（书名、作者、目录、正文、封面），并给应用补一个书本样式图标。

**Architecture:** 在 core 新增纯函数 EPUB 解析器（自带最小 ZIP 读取，无新依赖），把每章 XHTML 转成纯文本段落，复用现有书库/阅读/搜索/书签管线；封面单独存 `cover.bin`，经 IPC 以 data URL 提供给书架。图标用离屏 Electron 把 SVG 栅格化为多尺寸 PNG 并打包成 ICO。

**Tech Stack:** TypeScript strict、Node zlib（inflateRawSync）、Electron、React、Vitest。

**Spec:** docs/superpowers/specs/2026-10-29-pc-reader-design.md（P1：EPUB）

## 全局约束

- 运行时依赖只有 `iconv-lite`，不得新增依赖
- 不引入 DRM 解密；遇到加密正文直接拒绝并给出可读提示
- 原书 CSS / 字体 / 行内图片不还原，统一用阅读器自身排版
- 现有 TXT 行为不得改变；旧书目（无 format 字段）按 TXT 处理
- 自动验收必须离屏（READER_ACCEPTANCE=1 + 临时目录），不碰真实 data/

## 数据模型

- `BookFormat = 'txt' | 'epub'`；`BookMeta.format?`、`BookMeta.author?`、`BookMeta.cover?: { mime }`
- `LibraryEntry.format?`、`author?`、`hasCover?`；缺省视为 TXT
- `cover.bin` 与 `source.txt` 同级；`BookFiles.cover?: Buffer | null`（undefined 保留、null 删除）

## 任务

### Task 1: core EPUB 解析器（TDD）

**Files:** Create `tests/epub.test.ts`、`src/core/epub.ts`

- 测试内实现最小 ZIP 写入器（store + deflate），构造 EPUB 夹具
- 覆盖：OPF 书名/作者、spine 顺序、NCX 与 EPUB3 nav 目录、XHTML 转段落（实体、块级、br、head/script/style 剥离）、标题回退、封面提取、非 linear 段落跳过、空文档跳过、仅字体混淆放行、加密正文拒绝、损坏包报错
- `parseEpub(contents, fileName): EpubBook`，含 warnings

### Task 2: 导入管线接入

**Files:** Modify `src/core/model.ts`、`src/core/pipeline.ts`（新增 `buildBookResult` 复用 meta/stats）、`src/main/services/import.ts`、`src/main/services/importQueue.ts`、`src/main/storage/book.ts`、`src/core/compose.ts`

- `.epub` 走 `parseEpub`，其余仍走 `parseBookFile`
- `writeBook` 支持 cover；重洗/重切/合并时保留 format/author/cover
- 导入队列接受 `.epub`，提示文案改为「只支持 TXT / EPUB」

### Task 3: 封面与界面接入

**Files:** Modify `src/shared/api.ts`、`src/preload/index.ts`、`src/main/index.ts`、`src/main/services/reader.ts`、`src/renderer/src/components/BookCard.tsx`、`BookInfo.tsx`、`pages/Library.tsx`、`styles.css`

- 新增 `bookCover(id): Promise<string | null>`（data URL）
- 书架卡片显示封面（无封面保持原样），书籍信息显示作者/格式
- 文件选择与拖拽文案、过滤器加入 EPUB
- EPUB 书籍隐藏「更换编码」入口；`applyEncoding` 在服务端也拒绝

### Task 4: 应用图标

**Files:** Create `build/icon.svg`、`build/icon.ico`、`scripts/make-icon.mjs`；Modify `electron-builder.yml`、`src/main/index.ts`

- 书本样式：圆角深色底 + 打开的书页，16px 下可辨认
- 离屏 Electron 渲染 16/24/32/48/64/128/256 PNG，打包 ICO；窗口与 exe 使用同一图标

### Task 5: 验证与交付

- `npm run typecheck`、`npm test`、`npm run build`
- 离屏验收：导入 EPUB、封面显示、阅读翻页/搜索正常、TXT 回归
- 提交并推送；不自动升版本/发包（等用户确认）
