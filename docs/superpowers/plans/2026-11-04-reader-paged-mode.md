# 书本翻页模式（P1）实现计划

> 目标：在现有卷轴阅读之外增加「翻页」阅读模式，按整页翻动，保留进度、书签、搜索跳转与摸鱼样式。

## 设计决策

1. **按章分页，而不是全书分页。** 翻页模式只渲染当前章，用 CSS 多栏把这一章切成整页；翻到章末自动进入下一章第一页，往前则进入上一章最后一页。理由：
   - 全书一次性排版在几 MB 的小说上会长时间卡顿、占用大量内存；按章排版只处理 2–10k 字的章节，切换页是纯 `scrollLeft`，瞬时完成。
   - 中文小说按章起新页是自然阅读习惯，章节边界不会显得突兀。
   - 代码注释伪装本身就是滚动语义，翻页模式对它不生效（仍按行滚动）。
2. **设置项**：`AppSettings.readingMode: 'scroll' | 'paged'`，默认 `scroll`；旧配置文件缺省即为卷轴。
3. **分页实现**：`.reader-scroll` 在翻页模式下 `overflow: hidden`，内层 `.reader-page` 固定高度 + `column-width: 100000px`（保证一栏 = 一页宽）+ `column-fill: auto` + `column-gap`。第 N 页 = `scrollLeft = N × (页宽 + 栏间距)`。这样换行、标点、图片都不需要手工测量。
4. **进度仍以「章 + 段」存储**，翻页后取页面顶部命中的段落作为锚点；恢复进度、窗口缩放、字号变化都按该锚点重新定位到它所在的页。书签、目录、搜索、进度条拖动沿用同一套跳转逻辑。
5. **交互**：
   - `PageUp` / `PageDown`、`Space` / `Shift+Space`、`←` / `→`、`↑` / `↓` 翻页；书末/书首不动。
   - 滚轮：累计 100px 翻一页（行模式 ×20、页模式 ×400），两次翻页至少间隔 300ms，避免触控板惯性连翻。
   - 底部进度条在翻页模式显示「本章 x / y 页」。
   - 设置面板新增「阅读模式：卷轴 / 翻页」分段按钮与说明。
6. **摸鱼兼容**：记事本、透明悬浮沿用同一分页逻辑（各自的内边距变量）；代码注释保持按行滚动，不套用分页。

## 文件改动

- `src/core/model.ts`：新增 `ReadingMode` 类型与 `AppSettings.readingMode`。
- `src/shared/settings.ts`：默认值、`normalizeSettings` 校验、`SettingsPatch.readingMode`、`READING_MODE_OPTIONS`。
- `src/renderer/src/reader/pagination.ts`（新建）：纯函数 `pageCountFor`、`pageIndexForOffset`、`scrollLeftForPage`、`wheelPageStep`。
- `src/renderer/src/pages/Reader.tsx`：
  - `ReaderBody` 的 `data-chapter-index` / `data-chapter-section` 改用 `chapter.meta.index`（翻页时只渲染一章，数组下标不再等于书内章节号）。
  - 翻页渲染：只挂载当前章；翻页滚动与页码状态；`applyPagedAnchor` / `measurePaged` / `turnPage` / 统一跳转 `goToPosition`。
  - 窗口尺寸变化（ResizeObserver）与排版设置变化后按锚点重排；模式切换保持位置。
  - 键盘、滚轮分支；`positionInSection` 按栏过滤段落，避免多栏下取到其他栏的段落。
- `src/renderer/src/components/SettingsPanel.tsx`：阅读模式分组。
- `src/renderer/src/components/ProgressBar.tsx`：可选 `page` 属性，显示「本章 x / y 页」。
- `src/renderer/src/styles.css`：翻页布局与各摸鱼样式的内边距变量。
- `src/main/index.ts`：伪装窗口 URL 带上 `mode`，避免切换窗口后首帧闪回卷轴。
- `src/renderer/src/App.tsx`：`seededSettings` 读取 URL 里的 `mode`。

## 测试（TDD）

1. `tests/pagination.test.ts`（先红后绿）：
   - `pageCountFor`：单页、整页、亚像素噪声；`pageIndexForOffset`：栏边界与 1px 容差；`scrollLeftForPage`；`wheelPageStep`：像素/行/整页模式、反向滚动丢弃旧余量。
2. `tests/settings.test.ts`：默认卷轴、接受 `paged`、非法值回落、补丁不影响其他字段。

## 验收

- `npm test`、`npm run typecheck`、`npm run build`。
- 离屏验收（`READER_ACCEPTANCE=1` + 临时数据目录，不打开可见窗口，不碰仓库 `data/`）：
  - 默认卷轴；设置切到翻页后 `.reader-scroll` 进入分页布局，`scrollWidth > clientWidth`，出现「本章 x / y 页」。
  - 键盘 / 滚轮翻页：页宽 + 栏间距的整数倍、页码递增、顶部段落变化、进度落盘。
  - 章末下一页进入下一章第一页；章首上一页回到上一章最后一页。
  - 字号变化 / 窗口缩放后锚点仍在当前页附近且页码仍在范围内。
  - 卷轴 ↔ 翻页切换保持阅读位置；重启后设置与进度保留。
  - 记事本与透明样式仍可翻页；代码注释样式不受影响。
- 记录到 `docs/superpowers/acceptance/2026-11-04-reader-paged-mode.md`。
