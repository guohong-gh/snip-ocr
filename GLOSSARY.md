# 术语表

本仓库核心领域术语。代码、文档、issue 标题和测试命名沿用这里的叫法，避免同义词漂移。每条均以现有代码或文档为依据。

| 术语 | 含义 | 依据 |
| --- | --- | --- |
| 截图 | 用户唤起遮罩、框选区域后生成的一次画面采集。成功出口为复制、另存为、贴图、长图完成。 | `src/main/screenshot.ts`；README「截图工具栏」 |
| 截图工具栏 | 框选完成后出现在选区下方的 6 个动作：OCR / 贴图 / 另存为 / 长图 / 取消 / 确定。 | `src/main/screenshot.ts`、`src/shared/icons.ts`；README「截图工具栏（6 按钮）」 |
| 贴图 | 由「贴图」或 `Alt+P` 生成的置顶浮窗（`snip-pin`）：无边框、透明、始终置顶、可拖拽缩放，退出即消失。 | `src/main/pin.ts`、`src/renderer/pin.tsx`；README「贴图」 |
| 截图历史（旧称：贴图历史，已弃用） | 成功截图（复制 / 另存为 / 贴图 / 长图完成四种出口）的本地记录，默认保留最近 50 条；主窗「截图历史」入口与 `Alt+P` 读取它。代码与数据目录仍用 `pinHistory` / `pin-history` 命名，仅为标识符，面向人的文案统一用「截图历史」。 | `src/main/pinHistory.ts`（`PIN_HISTORY_LIMIT = 50`）；README「截图历史」；`docs/USER_GUIDE.md` 3.6 |
| 长截图（长图） | 点「长图」后进入的被动跟随纵向拼接：框选固定区域后滚动页面，画面停稳且内容有变化才入栈，结束时纵向拼接。仅纵向、仅单屏。 | `src/main/stitch.ts`；README「长截图」 |
| OCR | 本地文字识别（Windows.Media.Ocr），结果显示在遮罩右侧 OCR 侧栏，全程离线、零网络。 | `src/main/ocr.ts`；README「本地识字（OCR）」 |
| 主窗口 | 应用主界面，默认 680×560，可缩放到 480×400 – 1200×900；关闭后隐藏到托盘而非退出。 | `src/main/homeWindow.ts`；README「主窗口与设置」 |
| 托盘 | 系统托盘入口：截图 / 打开主界面 / 设置快捷键… / 关闭所有贴图 (N) / 退出。 | `src/main/index.ts`；README「主窗口与设置」 |
| 数据目录 | 运行数据优先写安装目录 `data/`；安装目录不可写时回退 `%APPDATA%\snip-ocr`。 | `src/main/config.ts`；README「贴图」「截图历史」 |
| 图标主题 | 工具栏与托盘图标风格：`default` / `deepseek` / `chibi` / `custom`。 | `src/shared/ipc.ts`（`ICON_THEMES`）；README「图标定制」 |
