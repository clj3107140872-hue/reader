# 日夜模式与跟随系统验收记录（2026-11-03）

## 改动

- 设置新增 `themeMode`：`day`（日间）/ `night`（夜间）/ `system`（跟随系统），默认日间。
- `theme` 保留为日间配色（浅色 / 护眼绿 / 羊皮纸）；夜间始终渲染深色，切回日间时恢复上次的日间配色。
- 渲染层通过 `prefers-color-scheme` 监听系统深浅色变化，系统切换时阅读页即时换色，无需重启。
- 排版面板新增三段式「日间 / 夜间 / 跟随系统」控件；配色块点击逻辑：
  - 点「深色」→ 夜间模式；
  - 点任一浅色配色 → 日间模式并使用该配色；
  - 跟随系统时，系统浅色用所选日间配色，系统深色用深色。
- 旧设置兼容：原先 `theme: "dark"` 的用户升级后自动迁移为 `theme: "light" + themeMode: "night"`，不会掉回浅色且保持深色显示。

## 测试

- `npm test`：28 个测试文件、182 条用例全部通过
  - 新增 2 条：旧深色主题迁移、日/夜/跟随系统的配色解析（含系统深浅两种输入）
  - 原有设置持久化用例改为断言 `themeMode: "night"` 且日间配色保留
- `npm run typecheck`：通过
- `npm run build`：通过

## 离屏验收

- 临时数据目录 `C:/Users/Administrator/AppData/Local/Temp/reader-theme-acceptance`（`PORTABLE_EXECUTABLE_DIR` 指向其中 `data-root`），`READER_ACCEPTANCE=1` 离屏启动，未打开可见窗口，未触碰仓库 `data/`
- 端口：验收前把构建产物调试端口临时改为 9333，验收后已 `npm run build` 还原为 9222（grep 复核）
- 系统深浅色通过 CDP `Emulation.setEmulatedMedia`（`prefers-color-scheme`）模拟，窗口内实时生效
- 场景与结果：
  1. 默认打开：`data-theme="light"`，模式控件为「日间 / 夜间 / 跟随系统」，日间与「浅色」为选中态
  2. 点「夜间」：`data-theme="dark"`，深色块选中；`getSettings()` 为 `themeMode: "night"`、`theme: "light"`
  3. 点「护眼绿」：`data-theme="green"`，模式回到日间，`theme: "green"`
  4. 模拟系统浅色 → 点「跟随系统」：保持 `green`，显示跟随系统说明文案
  5. 模拟系统深色：即时切到 `dark`，模式仍为「跟随系统」，深色块选中
  6. 模拟系统恢复浅色：即时切回 `green`
  7. 设置持久化为 `themeMode: "system"`、`theme: "green"`
- 未自动化：真实 Windows 系统主题切换（以 CDP 模拟替代，渲染层监听路径一致）；设置面板关闭后系统切换（监听在 App 层，理论一致）；四种配色的像素级视觉核对

## 已知说明

- 书架页保持原有浅色样式，日夜模式只作用于阅读页；如后续需要书架也跟随，可复用同一 `resolveTheme`。
