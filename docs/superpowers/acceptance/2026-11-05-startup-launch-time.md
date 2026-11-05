# 启动慢排查与绿色版（2026-11-05）

## 现象

用户反馈：双击启动时等待时间变长，之前没有这个问题。

## 排查结论

**不是应用代码变慢，也不是 EPUB / 图标改动引入的回归。** 卡顿来自 electron-builder 的 portable 自解压壳：

- 便携 exe 每次启动都会把内置的整个 Electron 运行时解压到 `%TEMP%\<随机 UUID>\`，App 退出后再删掉。模板 `portable.nsi` 里固定是 `RMDir /r $INSTDIR` → `File /r` 全量解压 → `ExecWait` → 再 `RMDir /r`，**没有复用已有解压目录的路径**，`portable.unpackDirName` 只是换目录名，仍然每次重解压。
- 本次打包后解压体积 310 MB（裁剪前 358 MB），在带 Defender 实时扫描的机器上约 5–7 秒；解包版（`win-unpacked\Reader.exe`）直接启动约 1 秒。
- `dist/data/logs/app.log` 显示用户历次启动都走便携 exe（`data=...\dist\data`），11-05 09:34 那次正常写入了 `app start`，没有报错、没有卡在库修复。旧 dist 便携版与新 release-dist 便携版耗时一致，进一步排除代码回归。

## 实测（离屏验收，临时目录，不触碰真实数据）

| 启动方式 | app start | 渲染进程就绪 |
| --- | --- | --- |
| `dist/Reader-0.1.0-portable.exe`（旧） | 5.8–6.2 s | 6.1–6.5 s |
| `release-dist/Reader-0.1.0-portable.exe`（新） | 6.3–7.1 s | 6.6–7.7 s |
| `win-unpacked\Reader.exe`（解包版） | 0.76–1.08 s | 1.02–1.68 s |
| `dist\Reader-win-x64\Reader.exe`（绿色版，迁移数据后） | 0.15–0.6 s | — |

（计时含进程启动轮询误差；便携版主要成本是解压 310 MB，与机器磁盘 / 杀软扫描有关。）

## 处理

- `electron-builder.yml`：`win.electronLanguages` 只保留 `zh-CN`、`en-US`，解压体积 358 → 310 MB，portable exe 110.6 → 98.1 MB；新增 `zip` 目标，产出可直接解压运行的绿色包 `Reader-0.1.0-win.zip`（135 MB）。
- 给用户准备 `dist\Reader-win-x64\`：解压绿色包，并把 `dist\data` 完整复制进去（book 库、设置、userData 均迁移；`library.json` 哈希一致），桌面创建 `Reader.lnk` 指向该目录的 `Reader.exe`。以后日常从桌面图标启动约 1 秒；原便携 exe 保留，供分享 / 下载。
- 打包与冒烟：`npm run build` + `electron-builder --win --config.directories.output=release-dist` 成功；绿色版以 `READER_ACCEPTANCE=1` 离屏启动，日志确认 `data=...\dist\Reader-win-x64\data`，`app start` 正常、无报错、主窗口句柄 0，真实 `data/` 未改动。
- 测试：35 文件 / 224 条全部通过；本次只改打包配置，不动源码。

## 已知取舍

- 未升版本、未发 GitHub Release、未改动旧 `dist/Reader-0.1.0-portable.exe`。
- 旧便携版与绿色版从此各有一份 `data`；日常应固定使用绿色版，避免两边导入产生分叉。
- 便携版每次启动仍需解压，这是 electron-builder portable 格式的固有行为；要分享给朋友且要求快，建议发 ZIP 绿色包。
- 旧的 11-03 解压目录（`%TEMP%\3LafZ5zXgowh0l39DaD16D1d8c4`）被一个已退出的 Reader 进程对象占用，删除被拒，暂留（约 358 MB）。
