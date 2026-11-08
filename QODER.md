# QODER.md — snip-ocr（桌面截图工具）

> 工程约束以本文件为准。Trae 的规则入口是 [AGENTS.md](./AGENTS.md)（全局行为规范），本文件是其工程约束附件，只补充本项目的技术栈、目录边界与硬性禁区；两者互补，不重复条款。

## 项目概述

Electron 桌面截图工具，用来平替系统截图：主窗口 + 托盘常驻、全局快捷键框选、松手后复制/保存/贴图，或在遮罩内做本地 OCR。
界面按 `snipocr.html` 原型实现；只做桌面端「截图 / 复制 / 保存 / 贴图 / 本地识字」，零网络请求、零账号体系；不含浏览器扩展。

## 技术栈

- 语言 / 框架：TypeScript 5.9.3（strict，双向配置 `tsconfig.node.json` + `tsconfig.web.json`）、Electron 33.4.11、React 19.3.1、Vite 8.3.5 + electron-vite 6.0.0
- 关键依赖：`electron-screenshots` 0.6.2（遮罩窗与选区，内部用 `node-screenshots` 原生捕获，`desktopCapturer` 兜底）、`electron-builder` 26.18.0（NSIS + portable）
- 数据库 / 消息队列 / 外部服务：**无**。持久化只在 `data/`：`config.json`（原子写：临时文件 + rename）、`icons/custom.png`（自定义图标）、`pin-history/`（截图历史，默认保留 10 条，可在设置中选 5/10/50）、`ocr/`（OCR 临时图，结束即删）。打包态 `userData` 被指到 exe 同级 `data/`；安装目录不可写时回退 `%APPDATA%\snip-ocr`。卸载必须无残留（[build/installer.nsh](./build/installer.nsh) 兜底清理 `$APPDATA\snip-ocr`）
- 包管理器：**npm**（本仓库用 `package-lock.json`，不要改成 pnpm）
- Lint 工具：**未引入**。静态检查由 `npm run typecheck` 承担；新增 lint 依赖属未批准依赖，需先同意

## 构建与测试命令

```bash
npm install                                    # 国内网络先设 ELECTRON_MIRROR
npm run dev                                    # 开发启动，显示主窗口（关闭隐藏到托盘）
npm run typecheck                              # 类型检查（等价模板的 lint + tsc --noEmit）
npm run build                                  # typecheck + electron-vite 构建到 out/
npm run selftest                               # 自动化验收，等价模板的 pnpm test
npm run icon                                   # 纯 Node 重新生成图标（scripts/gen-icon.mjs）
npm run dist                                   # 只解包的 Windows 产物，快速验证打包
npm run pack                                   # 出安装包到 dist/
```

直接调 electron 前必须 `unset ELECTRON_RUN_AS_NODE`，否则 `app` 是 undefined。启动参数：`--hidden` 只留托盘（开机自启）、`--settings` 打开设置弹窗、`--selftest` 自检。

## 目录结构

```
src/
├── main/
│   ├── index.ts          # 启动、托盘与菜单、单实例锁、设置/贴图快捷键、IPC 装配
│   ├── homeWindow.ts     # 主窗口：首页/设置弹窗、标题栏动作、显示/隐藏、启动参数
│   ├── screenshot.ts     # ⛔ 唯一截图入口：遮罩生命周期、上次截图缓存、6 动作分发（贴图/确定分离）、长图被动跟随会话、singleWindow 复用
│   ├── stitch.ts         # 长图纵向拼接：整行灰度指纹多候选打分、固定表头屏蔽、增量重叠（供实时预览）、20000 物理像素分段导出
│   ├── overlayUi.ts      # 遮罩注入：6 按钮工具栏（含长图）、长图细边框 HUD、实时预览缩略窗、可拖拽 OCR 侧栏、主题图标、裁剪取图
│   ├── pin.ts            # 贴图窗口：几何换算、创建/显示、拖拽缩放、单张关闭、临时图清理
│   ├── pinHistory.ts     # 截图历史：复制/另存/贴图/长图四种来源，原图/缩略图落盘、history.json 索引、默认 10 条（可选 5/10/50）淘汰
│   ├── ocr.ts            # Windows 本地 OCR：临时图、PowerShell/WinRT 桥、15 秒超时、文本规范化、长图分块与系统已装语言选择
│   ├── config.ts         # userData 读写、配置归一化、打包态 data/ 目录与旧目录迁移
│   └── selftest.ts       # 合成事件 + DOM 断言的自动化验收
├── preload/index.ts      # contextBridge，只暴露 window.snip
├── shared/ipc.ts         # ⛔ Electron IPC 通道名与共享类型的唯一定义处
├── shared/icons.ts       # 工具栏默认/DeepSeek/菲比丘比图标常量
├── renderer/src/         # 主窗 + 设置弹窗（index.html/App.tsx）+ 贴图页（pin.*）
assets/                   # 运行时图标（tray.png 32px、icon.png 256px），打进 asar
build/                    # 仅 electron-builder 用的安装包图标，运行时禁止读
out/  dist/               # ⛔ 构建与打包产物，禁止手改
scripts/
├── icon-art.mjs          # PNG 编码器 + 参数化图标画法
└── gen-icon.mjs          # 桌面端图标生成
```

## 硬性约束（Never Do）

- ❌ 禁止使用 `any` 类型，禁止关掉 strict 或加 `@ts-ignore` 绕过
- ❌ 禁止把截图逻辑写出 [src/main/screenshot.ts](./src/main/screenshot.ts)（不得散落到 `index.ts`）；贴图窗口逻辑集中在 [src/main/pin.ts](./src/main/pin.ts)
- ❌ 禁止在 `src/shared/ipc.ts` 之外手写 IPC 通道名字面量，两端只能从它取值
- ❌ 禁止引入任何网络请求代码、License / 授权校验代码、支付 / 登录 / 云服务代码
- ✅ 唯一允许的外部二进制例外面（必须同时满足下列全部验收条件）：把 translateLocally 作为**可选、离线、用户手动安装**的本地翻译插件，支持中英双向（en→zh / zh→en）。
  1. 主包与 asar 内不得包含插件二进制或模型：`electron-builder.yml` 的 `files` 必须排除 `plugins/**`；未安装时「译成中文」入口置灰，并在状态行提示插件放置路径。
  2. 只允许以 `-m <model> -i <input> -o <output>` 调用，工作目录必须是插件内 `models/`；源码中不得出现 `-a` / `-d` 参数，不得出现 HTTP / HTTPS / WebSocket / telemetry / 自动更新代码；不得自行下载模型，未来接入需用户提供资产并校验体积（≤200 MiB）与哈希；selftest 必须保留「翻译实现不含联网参数」断言。
  3. 插件所有文件的 SHA256 固定在 [README.md](./README.md) 的「离线翻译插件」一节，替换任何文件需重新审批并同步哈希。
  4. 支持中英双向（en→zh / zh→en）；缺少对应方向的模型时，该方向入口必须置灰并如实提示缺失，不得下载模型、不得返回假译文。
- ❌ 禁止做标注与真实的更新服务 / 自动下载安装（截图工具栏只允许 OCR / 贴图 / 另存为 / 长图 / 取消 / 确定；贴图页只渲染图片与拖拽缩放，不得引入编辑器/标注逻辑）。截图历史默认保留 10 条，可在设置中选 5/10/50，改档位时按新上限裁剪已有记录，属既有功能；设置里的「检查更新」入口保留，但必须维持离线桩实现：不联网、不下载，只报告当前版本；正式分发采用代码签名 + 官网手动下载安装包，不做自动更新
- ❌ 禁止把 OCR 写出 [src/main/ocr.ts](./src/main/ocr.ts)：只允许 Windows.Media.Ocr 本地识别，不得联网、不得引入 OCR 依赖或远程服务；失败要如实通知，不得静默吞掉
- ❌ 禁止识字后自动覆盖剪贴板：结果必须进入遮罩内可编辑侧栏（[src/main/overlayUi.ts](./src/main/overlayUi.ts)），由用户点「复制」才写入剪贴板
- ❌ 禁止让主窗口关闭即退出：主窗关闭只隐藏到托盘，退出只走托盘菜单或设置 → 通用底部的「退出 snip-ocr」；截图开始前必须隐藏主窗，结束后按原可见状态恢复
- ❌ 禁止让贴图滚轮缩放改变窗口 bounds：滚轮只改 `.pin-image` 的 CSS transform（窗口内内容缩放），窗口大小只能由 8 向边框拖拽调整；拖拽移动不得重置缩放
- ❌ 禁止移除每张贴图的悬停关闭按钮：多张并存时用户必须能单独删除任意一张，同时保留双击/Esc/托盘关闭全部
- ❌ 禁止把「贴图」塞回「确定」：贴图按钮只生成贴图；确定只复制到剪贴板；`Alt+P` 贴最近一张截图（截图历史最新一条）始终可用
- ❌ 禁止重新引入 Chrome 扩展或任何浏览器端代码，本项目只交付桌面端
- ❌ 禁止在贴图窗口里传递 base64/IPC 大数组：图片一律走临时文件路径，并用 `snip-pin://` 自定义协议加载（禁止 `file://` 直链：dev 的 http 页面会被 Chromium 拦截；协议 handler 只允许 pins 目录内的 `pin-*.png`）
- ❌ 禁止让贴图窗口出现在任务栏或 Alt+Tab（Windows 必须保留 `type: 'toolbar'`）
- ❌ 禁止开启 `nodeIntegration` 或关掉 `contextIsolation`；渲染进程只走 `window.snip`
- ❌ 禁止运行时读取 `build/` 目录（那是打包资源，不进 asar）
- ❌ 禁止手动修改 `out/`、`dist/`，禁止用 `--no-verify` 类手段跳过检查
- ❌ 禁止引入未经批准的新依赖（含 lint / 测试框架 / 图像处理库）
- ❌ 禁止在未运行 `npm run selftest` 并通过的情况下声称任务完成
- ❌ 禁止在快捷键注册失败时伪造成功状态；必须如实降级并通知用户

## 本地验证闭环

完成任务前，必须依次运行并全部通过：

1. `npm run typecheck` —— 两份 tsconfig（node / web）均零报错
2. `npm run build` —— 产出 `out/main`、`out/preload`、`out/renderer`（含独立 `pin.html`）
3. `npm run selftest` —— 要求末行输出 `[selftest] ALL PASS`（最近一次开发态实跑：164 项 PASS + 9 项 INFO，其中 1 条 INFO 为 `Alt+A` 被占用时的注册结果；覆盖主窗首页/状态条/设置三页/图标预览、工具栏 6 动作（含独立贴图、确定复制、长图收起遮罩进入 HUD/选区透出真实屏幕（冻结图不可见）/实时预览在选区外且穿透/HUD 按钮与工具栏同款/完成复制/完成后另存与 OCR/关闭/长图单帧与普通截图像素一致）、拼接核心（重叠行数/容差打分/固定表头/到底指纹/分段导出/颜色 round-trip）、双击复制、保存、贴图创建/尺寸/位置/1:1/滚轮缩放与百分比/Ctrl+0/四角手柄/拖拽不回弹/8 向缩放/单张关闭/多贴图、遮罩内 OCR 侧栏动态选边/标题条拖拽不越界/textarea 仍可输入选中/编辑/字数/手动复制/关闭/迟到结果丢弃、贴图快捷键注册、Windows OCR 识别、截图历史覆盖复制/另存/贴图/长图四种来源且索引落盘、取消不记录、离线翻译（GB18030 解码/英译中真实链路/英文源启用/翻译中与失败态/未安装提示与安装路径/超长拒绝/源码不含联网参数））。验证 dev 的 http 页面可跑 `npx electron-vite dev -- --selftest`（`--` 之后的参数会透传给 Electron）
4. 改动涉及打包、图标或依赖时，追加 `npm run pack`，并对 `dist/win-unpacked/snip-ocr.exe --selftest` 再跑一次验收（0.4.2 打包版实跑：159 项 PASS + 9 项 INFO，0 FAIL，无插件与放入插件两种状态均 ALL PASS，含「运行数据位于程序目录 data/」「旧 %APPDATA% 已清理」「贴图走 snip-pin://」，以及把插件放到 `data\plugins\translate-locally` 后「翻译插件状态 pluginDir 指向程序目录 data/」「英译中链路可用」「超长文本拒绝翻译并提示」；清理测试插件后 `win-unpacked` 与 asar 内均无 `plugins/`）。改动涉及安装/数据目录时，还要做一次静默安装 → 运行 → 静默卸载，确认安装目录、`%APPDATA%\snip-ocr`、快捷方式与卸载注册表项全部清除
   打包环境注意：无外网时 `@electron/get` 会卡在校验 Electron 缓存，需设 `ELECTRON_MIRROR`（本机用 `https://npmmirror.com/mirrors/electron/`）；若 IDE/索引器锁住新解压的 `default_app.asar` 导致 `EPERM/EBUSY`，把输出指到工作区外（`npx electron-builder --config.directories.output=<临时目录>`）再拷回 `dist/`。

任何一项失败先修复再继续；新增交互要同步在 [src/main/selftest.ts](./src/main/selftest.ts) 补断言，不接受只靠人工点击。
