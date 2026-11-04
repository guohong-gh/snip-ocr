!macro customUnInstall
  ; 常规情况：配置、贴图临时文件、Chromium 缓存都在 $INSTDIR\data 下
  RMDir /r "$INSTDIR\data"
  ; 兜底：安装目录不可写时数据会回退到 %APPDATA%\snip-ocr（含旧版本残留）
  RMDir /r "$APPDATA\snip-ocr"
!macroend
