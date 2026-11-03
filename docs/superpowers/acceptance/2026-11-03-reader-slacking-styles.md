# 摸鱼模式多风格验收记录（2026-11-03）

> 本记录覆盖 `2026-11-03-reader-slacking-mode.md` 之后的第二版：`disguise` 由布尔值改为枚举，新增「透明悬浮」「代码注释」两种风格。不透明度、置顶、老板键的验收结论沿用前一份，并在本次回归中重跑。

## 改动

- 设置 `slacking.disguise` 改为枚举：`none` / `notepad` / `transparent` / `code`，默认 `none`。
  - 兼容旧配置：`true` 迁移为 `notepad`，`false` / 非法值迁移为 `none`；`tests/settings.test.ts` 覆盖。
- 设置面板「摸鱼模式」改为四选一按钮（关闭 / 记事本 / 透明悬浮 / 代码注释），选中后显示对应说明。
- 窗口形态按「风格 + 是否有书」决定（`disguiseWindowKind`）：
  - 书架页始终是带边框的普通窗口；只有打开书籍时才应用透明 / 代码形态。
  - 透明、代码两种风格需要改 `frame` / `transparent` / `resizable` 等构造参数，切换时新建窗口、旧窗口在就绪后销毁；切换前通过 `app:flush-request` / `app:flush-done` 等待阅读进度落盘，5 秒兜底。
  - 新窗口以 `?bookId=&style=` 启动，首帧即按目标风格渲染；阅读位置随进度恢复。
- 透明悬浮：
  - 无边框、透明背景、不可调整大小、无阴影；正文与背景全透明，只留文字。
  - 主进程每 2 秒（移动/缩放后 250ms 防抖）用 `desktopCapturer` 抓窗口身后画面，裁剪窗口区域后取中位亮度，经 `slacking:backdrop` 通知渲染层；深色背景用浅色文字，浅色背景用深色文字，颜色切换有 200ms 过渡。
  - 验收模式跳过真实采样；`debug:backdrop` 用于驱动同一通道。
- 代码注释：
  - 无边框、32 位深不透明窗口，背景 `#1e1e1e`，仿 VS Code：标签栏、行号、状态栏、固定代码块。
  - 上下两段伪代码固定不动；中间区域是小说正文，按绿色注释渲染（Consolas 14px/20px，`// ` 前缀，悬挂缩进），独立滚动。
- 窗口尺寸：
  - 无边框窗口在页面四边/四角提供 6–10px 的拖拽条，通过 `window:resize-start/move/end` 在渲染层捕获指针、主进程用 `setBounds` 调整窗口；透明窗口保持 `resizable: false`（避免破坏透明合成），完全依赖这套自定义拖拽。
  - 最小尺寸：透明 `120×80`，代码 `300×240`（普通窗口仍为 `800×600`）；代码模式下上下伪代码可收缩裁切，保证注释区至少约 96px。
  - 透明模式正文不再限制 `max-width`，窗口多大文字框就多大，缩小时同步换行。
  - 代码模式注释列右侧新增拖拽条，可独立调整正文宽度（160px 起，记忆在 `localStorage`），与窗口缩放互不影响。
- 退出：`Esc` 优先关闭设置抽屉，其次退出伪装（窗口换回普通形态），最后才返回书架；伪装下 Ctrl/Cmd 组合键不触发阅读快捷键。
- 阅读页标题：记事本/透明为 `工作文档.txt - 记事本`，代码为 `codenovel.js - Visual Studio Code`。
- 调试接口新增 `debugSetBackdrop`、`setViewState`、`onFlushRequest` / `notifyFlushed`、`onBackdropTone`；`debugWindowState` 增加 `disguise`、`windowKind`、`resizable`。

## 测试

- `npm test`：30 个测试文件、194 条用例全部通过
  - `tests/settings.test.ts`：旧布尔值迁移、四风格合并、`disguiseWindowKind` 在「有书/无书」下的窗口形态
  - `tests/backdrop.test.ts`：`isDarkBitmap` 的深/浅/空位图判定（中位亮度）
  - `tests/window-resize.test.ts`：八方向拖拽的边界计算、最小尺寸钳制、对边固定
- `npm run typecheck`：通过
- `npm run build`：通过

## 离屏验收

- 临时数据目录 `C:/Users/Administrator/AppData/Local/Temp/reader-slacking-acceptance`（`PORTABLE_EXECUTABLE_DIR` 指向该目录），`READER_ACCEPTANCE=1` 离屏启动；未打开可见窗口，未触碰仓库 `data/`
- 端口：验收前把构建产物调试端口临时改为 9333，验收后已 `npm run build` 还原为 9222（grep 复核）
- 验收脚本：`acceptance.cjs`（CDP，窗口重建后自动重连新页面）
- 场景与结果：
  1. 正常阅读页：滚动到第 9 段后进度落盘；无伪装退出按钮
  2. 记事本：同一窗口内切换，`windowKind = normal`、`disguise = notepad`；假菜单栏、标题、`data-slacking="notepad"` 就绪；设置抽屉自动关闭；`Esc` 退出后工具栏恢复、`disguise = none`
  3. 代码注释：换到新窗口，`windowKind = code`、可缩放；标题 `codenovel.js - Visual Studio Code`；标签栏/状态栏存在；背景 `rgb(30, 30, 30)`；正文绿色 `rgb(106, 153, 85)`、Consolas 14px/20px、`::before` 为 `"// "`；上方代码行 ≥ 10；恢复的 `scrollTop > 0`；滚动 200px 后代码块位置不变、正文上移超过 100px；进度保留
  4. 代码模式窗口缩放：`windowResizeStart('se')` +120×80 后边界同步放大，再 `se` −120×−80 恢复；继续缩到最小 `300×240`，注释区高度仍 ≥ 90px，随后恢复原尺寸
  5. 代码模式文字框：拖动 `.vscode-column-resizer` 向左 120px，注释列宽度减少 ≥100px，且宽度写入 `localStorage`
  6. 从代码模式按 `Esc`：换回带边框普通窗口，工具栏恢复、标题恢复 `Reader`，阅读位置保留
  7. 透明悬浮：换到新窗口，`windowKind = transparent`、原生 `resizable = false`；拖动条与退出按钮存在；`body`、`.reader`、`.reader-scroll` 背景均为 `rgba(0, 0, 0, 0)`；标题为 `工作文档.txt - 记事本`；位置恢复
  8. 透明自适应：`debugSetBackdrop(true)` 后正文颜色过渡到 `rgb(244, 244, 244)`；切回 `false` 后过渡到 `rgb(17, 17, 17)`；设置持久化 `disguise: transparent`
  9. 透明窗口缩放：自定义拖拽可把窗口缩到最小 `120×80`，再恢复原尺寸（证明 `setBounds` 在非 resizable 透明窗口上仍然生效）
  10. 从透明模式按 `Esc`：恢复普通窗口与工具栏；章节与位置未变
  11. 回归：不透明度 0.75 即时生效；置顶勾选生效；老板键改为 `Ctrl+Shift+J`、动作 `minimize` 后隐藏/恢复；退出后设置全部持久化
- 未自动化（离屏环境限制）：
  - 真实透明窗口在桌面上的合成观感、任务栏/Alt-Tab 表现
  - 桌面采样链路（`desktopCapturer`）本身：验收模式按设计禁用，改用调试 IPC 验证渲染侧换色
  - 多显示器、缩放比例、桌面壁纸为复杂图案时的中位亮度表现

## 已知说明

- 透明窗口的原生 `resizable` 仍为 `false`（Electron 对透明窗口的缩放支持不可靠）；缩放完全由页面四边/四角的拖拽条驱动 `setBounds`，实测最小可到 `120×80`。
- 桌面采样只取窗口中心区域的中位亮度，背景一半黑一半白时按中位数取一侧，不保证每个字都对比充分。
- 代码注释模式的伪代码为固定文案，仅作伪装背景，不随正文变化；窗口很矮时上下伪代码会被裁切，优先保证注释区可见。
- 代码模式的注释列宽度只存在渲染层 `localStorage`（随 `userData` 迁移），不写 `settings.json`；窗口临时缩得比已存宽度还窄时由 CSS 收窄，放大后恢复。
- 书架页不应用透明/代码形态，避免「空书架透明悬浮」这种更反常的画面。
- 老板键注册失败（被其他程序占用）只写日志，界面暂不提示。
