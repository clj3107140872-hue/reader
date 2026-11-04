# EPUB 导入与应用图标验收记录（2026-11-04）

- 测试：`npm test` 全绿，35 个测试文件、224 条用例全部通过（新增 `tests/epub.test.ts` 8 条、EPUB 导入集成 1 条）
- 类型检查：`npm run typecheck` 通过（无诊断输出）
- 构建：`npm run build` 通过（main / preload / renderer 均构建成功）
- 离屏验收：临时目录 `C:/Users/Administrator/AppData/Local/Temp/reader-epub-acceptance`（`PORTABLE_EXECUTABLE_DIR` 指向其中 `portable`），以 `READER_ACCEPTANCE=1` 离屏启动开发构建，未打开可见窗口，未触碰仓库 `data/`
- 自动检查：9 条，全部通过
- 打包验证：`release-dist` 打包成功；打包后的 portable exe 以离屏模式冒烟通过（`packaged=true`，主窗口句柄 0），未影响正在运行的旧版程序

## EPUB 验收覆盖

- 导入含 NCX 目录、作者、JPEG 封面的 `.epub`：导入队列无错误，书架新增 1 本
- 书架卡片：标题「测试之书」、副标题「EPUB · 2 章」、封面 `data:image/jpeg;base64,…` 正常解码（naturalWidth > 0）
- 悬停信息：显示作者「某作者」与格式「EPUB」，不再显示「编码」行
- 右键菜单：EPUB 书籍隐藏「切换编码…」，「重新清洗」「删除」等仍在
- `openBook`：`meta.format = epub`、作者、2 章；正文段落含 `你好&世界。`（实体已解码）、`<br>` 转行、标题未重复
- 搜索：正文命中「你好」，返回 1 条带上下文的结果
- 阅读界面：点击卡片正常进入阅读页，章标题与段落渲染正确，返回书架正常
- `bookCover(id)`：返回 data URL；无封面时返回 null

## TXT 回归

- 导入普通 `.txt`：卡片仍显示「TXT · 3 章 · utf8」，无封面图，编码与章节切分不受影响
- 旧书目（无 `format` 字段）按 TXT 处理，书架、阅读、搜索行为不变

## 图标

- 新增 `build/icon.svg`：深绿圆角底 + 米白书页 + 书脊 + 金色书签，16px / 32px 下仍可辨认
- `scripts/make-icon.mjs`：离屏 Electron 以 512px 渲染一次，再用 `nativeImage.resize(quality: 'best')` 生成 16/24/32/48/64/128/256 的 PNG，打包为 `build/icon.ico`，同时输出 `build/icon.png`
- 开发模式窗口使用 `build/icon.png`；打包后的 exe 由 electron-builder 默认读取 `build/icon.ico`，已从 `release-dist/win-unpacked/Reader.exe` 提取并核对图标
- 图标生成过程中的坑：关掉唯一离屏窗口会触发 Electron 默认的 `window-all-closed` 退出，脚本已注册空监听防止提前退出

## 未自动化 / 已知取舍

- 不还原原书 CSS、字体、行内图片与分页样式，正文按阅读器统一排版
- 带 DRM 的 EPUB 直接拒绝并提示，不做解密；仅字体混淆（IDPF/Adobe）放行
- 封面只取 OPF 中标记的 cover-image，未标记封面的书显示首字占位
- 非 spine 内容（注释、附注等）不入正文
- 超大 EPUB（数百 MB）未做性能压测，解析时按单文件 64 MB / 总计 512 MB 上限拒绝
- 本次不升版本、不发 Release，等用户确认后再按发布流程打包
