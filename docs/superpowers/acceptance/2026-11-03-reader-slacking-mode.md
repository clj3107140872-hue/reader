# 摸鱼模式验收记录（2026-11-03）

## 改动

- 设置新增 `slacking`：
  - `disguise`：伪装成记事本；
  - `opacity`：窗口不透明度，0.6–1，默认 1；
  - `alwaysOnTop`：窗口置顶；
  - `bossKey`：老板键，默认 `Ctrl+Shift+H`，可选 `Ctrl+Shift+J` / `Alt+Q` / `Ctrl+Alt+H` / 关闭；
  - `bossKeyAction`：`hide`（隐藏窗口，默认）/ `minimize`（最小化窗口）。
- 阅读页工具栏新增「摸鱼」；设置面板新增「摸鱼模式」分组（进入伪装、不透明度、置顶、老板键、老板键动作）。
- 伪装效果：
  - 窗口标题改为 `工作文档.txt - 记事本`，离开阅读页或退出伪装后恢复；
  - 顶部换成假的记事本菜单栏（文件 / 编辑 / 格式 / 查看 / 帮助），隐藏阅读器工具栏、警告条和进度条；
  - 正文使用 Consolas 等宽字体、15–20px、无首行缩进与段距，章节标题按普通文本行渲染；
  - 底部换成记事本状态栏（行列、100%、Windows (CRLF)、UTF-8）；
  - 伪装无视当前日夜配色，始终白底黑字。
- 退出方式：`Esc`（优先于返回书架）、菜单「文件 → 退出」、设置面板「退出伪装」。
- 老板键在应用运行期间注册为全局快捷键；隐藏/最小化后按同一组合键恢复。验收模式（`READER_ACCEPTANCE=1`）跳过注册，避免占用用户键盘。
- 窗口级设置即时生效：改不透明度/置顶无需重启；老板键变更后重新注册。

## 测试

- `npm test`：28 个测试文件、184 条用例全部通过
  - 新增 2 条设置用例：不透明度钳制与老板键校验；`slacking` 局部合并不丢失同级字段
- `npm run typecheck`：通过
- `npm run build`：通过

## 离屏验收

- 临时数据目录 `C:/Users/Administrator/AppData/Local/Temp/reader-slacking-acceptance`（`PORTABLE_EXECUTABLE_DIR` 指向该目录），`READER_ACCEPTANCE=1` 离屏启动；未打开可见窗口，未触碰仓库 `data/`
- 端口：验收前把构建产物调试端口临时改为 9333，验收后已 `npm run build` 还原为 9222（grep 复核）
- 场景与结果：
  1. 正常阅读页：工具栏存在「摸鱼」，无假菜单栏
  2. 先切到夜间（深色），再点「摸鱼」：`data-slacking="on"`，背景仍为 `rgb(255, 255, 255)`；工具栏与进度条消失；菜单为「文件 / 编辑 / 格式 / 查看 / 帮助」；状态栏含 `UTF-8`、`Windows (CRLF)`；正文 `Consolas`、字号 18px、段距 0、缩进 0；章节标题字重 400 且字号与正文一致；窗口标题为 `工作文档.txt - 记事本`；设置持久化 `disguise: true`
  3. 菜单「文件 → 退出」：工具栏恢复，标题恢复为 `Reader`，`disguise: false`
  4. 再次进入伪装后按 `Esc`：退出伪装但仍在阅读页（未返回书架），标题恢复
  5. 从设置面板点「进入伪装」：假菜单栏出现，设置抽屉自动关闭
  6. 不透明度滑杆设为 0.75：`getSettings()` 与 `debugWindowState().opacity` 均为 0.75
  7. 勾选「窗口置顶」：`debugWindowState().alwaysOnTop === true`
  8. 老板键改为 `Ctrl+Shift+J`、动作改为「最小化窗口」：`debugBossToggle()` 后 `minimised: true`，再次切换恢复
  9. 动作改为「隐藏窗口」：切换后 `visible: false`，再次切换恢复显示
  10. 退出后 `settings.json` 保留 `opacity: 0.75`、`alwaysOnTop: true`、`bossKey: "Ctrl+Shift+J"`、`disguise: false`
- 未自动化：真实全局快捷键按键（验收模式按设计跳过注册，改用调试 IPC 走同一动作函数）；任务栏/窗口标题在操作系统层面的显示；多显示器下的置顶与透明度观感

## 已知说明

- 伪装只作用于阅读页；书架页保持原样。离开阅读页时窗口标题会恢复。
- 假菜单除「文件 → 退出」外均为装饰项（禁用态），不执行真实记事本命令。
- 状态栏行号按当前段落序号模拟，不是真实文本行号。
- 老板键注册失败（被其他程序占用）只写日志，界面暂不提示；可在设置中改选其它组合键。
- 不透明度依赖 Electron `setOpacity`（Windows/macOS 支持）；本项目只面向 Windows。
