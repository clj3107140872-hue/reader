# 网络书源验收（2026-11-07）

## 自动化

- `npm test`：56 个测试文件 / 345 条用例全过
- `npm run typecheck`：通过
- `npm run build`：通过
- `node scripts/acceptance-network.cjs`：通过（离屏、临时数据目录、127.0.0.1 假书源）
- 未访问真实站点；未触碰 `data/`。

## 覆盖

### 验收脚本覆盖（`scripts/acceptance-network.cjs`，真实应用）

导入书源（粘贴 JSON，IPC）/ 优质池搜索（IPC）/ 加入书架（IPC）/
书架网络徽标 / 阅读器懒加载第一章 / 按需读取章节（IPC）/ 书源页列表 /
网络搜索页打开 / 更新目录、下载全本、转本地（IPC）/ 转本地后徽标消失 /
关闭联网提示。

### 单测覆盖（`npm test`）

全量搜索与同名分组、已在书架标记、最佳来源排序（`tests/network-search.test.ts`、
`tests/network-search-ui.test.tsx`）；断网读缓存、加书去重、信息页失败回退与警告、
目录失败（`tests/network-book.test.ts`）；书源删除与重新关联、legado 分享链接、
导入上限（`tests/source-service.test.ts`、`tests/network-book.test.ts`、
`tests/booksource-legado.test.ts`）；取消下载（`tests/network-download.test.ts`）；
转本地与重洗（`tests/network-convert.test.ts`、`tests/network-e2e.test.ts`）。

## 已知限制

- 不支持 JS、XPath、WebView、登录/验证码/DRM；这类书源标为部分兼容。
- 不内置、不推荐、不分享书源。
- 网络封面不落盘，书架用书名首字占位。
- 网络书进度按章节估算，未缓存章节没有真实字数。
- 离屏验收用 `READER_ALLOW_LOCAL_SOURCES=1` 放行 127.0.0.1 假书源；正式运行仍只允许 http(s) 公网地址。
