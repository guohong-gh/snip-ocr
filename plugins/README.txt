snip-ocr 离线翻译插件（translateLocally）
==========================================

用途：提供「英译中」本地翻译，不联网、不上传。中译英接口已保留，
      需另外提供 models\zhen 模型；缺少该模型时中译英入口置灰，不下载、不返回假译文。

放置位置
--------
把本目录（translate-locally）整体放到以下任一位置：

开发模式：
  <项目根>\plugins\translate-locally\

安装版 / 绿色版：
  <程序目录>\data\plugins\translate-locally\
  （程序目录即 snip-ocr.exe 所在目录；绿色版为解压目录，安装版为安装目录。
    应用的数据目录固定在程序目录下的 data/，不是 %APPDATA%。）

目录结构必须是：
  translate-locally\
    translateLocally.exe
    models\
      enzh\
        config.intgemm8bitalpha.yml
        model_info.json
        model.enzh.intgemm.alphas.bin
        lex.50.50.enzh.s2t.bin
        srcvocab.enzh.spm
        trgvocab.enzh.spm

缺少 exe 或对应方向模型目录下任一文件，该方向即视为「未安装」。

说明
----
- 总占用约 105 MiB（exe 约 56.8 MiB + 模型约 48.7 MiB）。
- 应用只以 `-m en-zh-base -i <输入> -o <输出>` 调用本 exe，工作目录设为 models\。
- 引擎输出为 GB18030 编码，由应用转码，不要改输出文件编码。
- 应用不会调用联网参数，也不会自动更新或下载模型。
- 本 exe 为第三方开源程序（translateLocally / Bergamot），请自行确认来源可信。
