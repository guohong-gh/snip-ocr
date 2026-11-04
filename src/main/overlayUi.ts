import type { WebContents } from 'electron'
import { TOOL_LABELS, toolIconFor, type ToolKey } from '@shared/icons'
import type { IconTheme } from '@shared/ipc'

export const OVERLAY_ACTION_PREFIX = '__SNIP_ACTION__'
export const OVERLAY_COPY_PREFIX = '__SNIP_COPY__'

const TOOL_ORDER: ToolKey[] = ['ocr', 'pin', 'save', 'longshot', 'cancel', 'confirm']

export function overlayIcons(theme: IconTheme, customIconUrl: string | null): Record<ToolKey, string> {
  return {
    ocr: toolIconFor(theme, 'ocr', customIconUrl),
    pin: toolIconFor(theme, 'pin', customIconUrl),
    save: toolIconFor(theme, 'save', customIconUrl),
    longshot: toolIconFor(theme, 'longshot', customIconUrl),
    cancel: toolIconFor(theme, 'cancel', customIconUrl),
    confirm: toolIconFor(theme, 'confirm', customIconUrl),
  }
}

const OVERLAY_CSS = `
.screenshots-operations-buttons > .screenshots-button,
.screenshots-operations-buttons > .screenshots-operations-divider {
  display: none !important;
}
.screenshots-operations {
  position: fixed !important;
  left: -10000px !important;
  top: -10000px !important;
  opacity: 0 !important;
  pointer-events: none !important;
}
#snip-toolbar {
  --snip-strip-ink: #181a17;
  --snip-strip-muted: #181a17;
  --snip-strip-hover: #eceded;
  --snip-signal: #2456b8;
  --snip-signal-ink: #ffffff;
  --snip-proof: #c33d26;
  position: fixed;
  z-index: 2147483002;
  display: none;
  align-items: center;
  gap: 2px;
  padding: 4px;
  border: 1px solid #d8dad2;
  border-radius: 3px;
  background: #ffffff;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.18);
}
.screenshots-canvas-border-top,
.screenshots-canvas-border-right,
.screenshots-canvas-border-bottom,
.screenshots-canvas-border-left,
.screenshots-canvas-point-top,
.screenshots-canvas-point-top-right,
.screenshots-canvas-point-right,
.screenshots-canvas-point-right-bottom,
.screenshots-canvas-point-bottom,
.screenshots-canvas-point-bottom-left,
.screenshots-canvas-point-left,
.screenshots-canvas-point-left-top {
  background-color: #4f7cff !important;
}
.screenshots-canvas-size {
  display: none !important;
}
#snip-size-badge {
  position: fixed;
  z-index: 2147483001;
  display: none;
  padding: 4px 7px;
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 2px;
  background: rgba(20, 21, 23, 0.9);
  color: #f2f2ec;
  font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1.2;
  white-space: nowrap;
  pointer-events: none;
  transform: translateX(-50%);
}
#snip-live-frame {
  position: fixed;
  z-index: 2147483000;
  display: none;
  overflow: hidden;
  box-sizing: border-box;
  border: 1px solid #4f7cff;
  pointer-events: none;
}
#snip-live-image {
  position: absolute;
  display: block;
  max-width: none;
  max-height: none;
  pointer-events: none;
  user-select: none;
}
body.snip-live-drag [class^='screenshots-canvas-border'],
body.snip-live-drag [class^='screenshots-canvas-point'] {
  opacity: 0 !important;
}
body.snip-live-drag .screenshots-canvas-body {
  opacity: 0 !important;
}
body.snip-live-drag .screenshots-canvas {
  background: transparent !important;
}
.screenshots-operations-buttons {
  display: flex !important;
  align-items: center !important;
  gap: 2px !important;
  padding: 4px !important;
  overflow: visible !important;
}
.snip-tool-btn {
  position: relative;
  display: flex;
  width: 62px;
  height: 54px;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 5px;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--snip-strip-ink);
  font-family: 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
  cursor: pointer;
  transition:
    background 140ms ease-out,
    border-color 140ms ease-out,
    color 140ms ease-out;
}
.snip-tool-btn:hover {
  background: var(--snip-strip-hover);
}
.snip-tool-btn:focus-visible {
  outline: 2px solid var(--snip-signal);
  outline-offset: -2px;
}
.snip-tool-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
.snip-tool-btn .snip-tool-icon {
  display: flex;
  width: 20px;
  height: 20px;
  align-items: center;
  justify-content: center;
}
.snip-tool-btn .snip-tool-icon svg,
.snip-tool-btn .snip-tool-icon img {
  display: block;
  width: 20px;
  height: 20px;
  object-fit: contain;
}
.snip-tool-btn .snip-tool-label {
  color: var(--snip-strip-muted);
  font-size: 10px;
  line-height: 1;
  letter-spacing: 0.02em;
}
.snip-tool-btn:hover .snip-tool-label {
  color: var(--snip-strip-ink);
}
.snip-tool-btn[data-snip-tool="pin"]:hover,
.snip-tool-btn[data-snip-tool="ocr"]:hover {
  border-color: #2456b8;
  background: #2456b8;
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="pin"]:hover .snip-tool-label,
.snip-tool-btn[data-snip-tool="ocr"]:hover .snip-tool-label {
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="save"]:hover {
  border-color: #181a17;
  background: #181a17;
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="save"]:hover .snip-tool-label {
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="confirm"]:hover {
  border-color: #2f6b4f;
  background: #2f6b4f;
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="confirm"]:hover .snip-tool-label {
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="cancel"]:hover {
  border-color: #c33d26;
  background: #c33d26;
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="cancel"]:hover .snip-tool-label {
  color: #ffffff;
}
.snip-tool-btn[data-snip-tool="pin"]:hover .snip-tool-icon img,
.snip-tool-btn[data-snip-tool="ocr"]:hover .snip-tool-icon img,
.snip-tool-btn[data-snip-tool="save"]:hover .snip-tool-icon img,
.snip-tool-btn[data-snip-tool="confirm"]:hover .snip-tool-icon img,
.snip-tool-btn[data-snip-tool="cancel"]:hover .snip-tool-icon img {
  filter: brightness(0) invert(1);
}
#snip-ocr-sidebar {
  --snip-paper: #f4f5f1;
  --snip-plate: #fbfcf8;
  --snip-ink: #181a17;
  --snip-ink-2: #565b54;
  --snip-ink-3: #8a8f86;
  --snip-rule: rgba(24, 26, 23, 0.16);
  --snip-rule-2: rgba(24, 26, 23, 0.42);
  --snip-signal: #2456b8;
  --snip-signal-ink: #ffffff;
  --snip-proof: #c33d26;
  position: fixed;
  right: 24px;
  top: 50%;
  display: flex;
  width: 340px;
  max-height: 70vh;
  flex-direction: column;
  overflow: hidden;
  border: 1px solid var(--snip-rule-2);
  border-radius: 3px;
  background: var(--snip-paper);
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.24);
  opacity: 0;
  pointer-events: none;
  transform: translateY(-50%) translateX(16px);
  transition:
    opacity 160ms ease-out,
    transform 160ms ease-out;
  user-select: text;
  z-index: 2147482999;
  font-family: 'Segoe UI Variable Text', 'Segoe UI', 'Microsoft YaHei UI', 'PingFang SC', sans-serif;
}
#snip-ocr-sidebar.show {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(-50%) translateX(0);
}
.snip-sidebar-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 11px 12px 10px;
  border-bottom: 1px solid var(--snip-rule);
  background: var(--snip-plate);
}
.snip-sidebar-title {
  color: var(--snip-ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: 0.01em;
}
.snip-sidebar-lang {
  margin-left: 7px;
  padding: 1px 4px;
  border: 1px solid var(--snip-rule);
  border-radius: 1px;
  color: var(--snip-ink-3);
  font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
  font-size: 8.5px;
  font-weight: 400;
  letter-spacing: 0.04em;
}
.snip-sidebar-close {
  display: grid;
  width: 24px;
  height: 24px;
  place-items: center;
  padding: 0;
  border: 1px solid transparent;
  border-radius: 2px;
  background: transparent;
  color: var(--snip-ink-2);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.snip-sidebar-close:hover {
  border-color: var(--snip-rule);
  color: var(--snip-proof);
}
.snip-sidebar-close:focus-visible,
.snip-sidebar-copy:focus-visible {
  outline: 2px solid var(--snip-signal);
  outline-offset: 2px;
}
.snip-sidebar-text {
  width: 100%;
  min-height: 180px;
  flex: 1;
  padding: 13px 14px;
  border: 0;
  outline: none;
  resize: none;
  background: var(--snip-paper);
  color: var(--snip-ink);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.75;
  user-select: text;
}
.snip-sidebar-text::placeholder {
  color: var(--snip-ink-3);
}
.snip-sidebar-text::selection {
  background: rgba(36, 86, 184, 0.16);
}
.snip-sidebar-status {
  min-height: 17px;
  padding: 0 14px 9px;
  color: var(--snip-ink-3);
  font-size: 10.5px;
  line-height: 1.5;
}
.snip-sidebar-status.error {
  color: var(--snip-proof);
}
.snip-sidebar-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 8px 12px;
  border-top: 1px solid var(--snip-rule);
  background: var(--snip-plate);
}
.snip-sidebar-count {
  color: var(--snip-ink-2);
  font-family: 'Cascadia Mono', Consolas, ui-monospace, monospace;
  font-size: 9.5px;
  font-variant-numeric: tabular-nums;
}
.snip-sidebar-copy {
  height: 28px;
  padding: 0 14px;
  border: 1px solid var(--snip-signal);
  border-radius: 2px;
  background: var(--snip-signal);
  color: var(--snip-signal-ink);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  transition:
    background 140ms ease-out,
    border-color 140ms ease-out;
}
.snip-sidebar-copy:hover:not(:disabled) {
  border-color: #1b4699;
  background: #1b4699;
}
.snip-sidebar-copy:disabled {
  border-color: var(--snip-rule-2);
  background: transparent;
  color: var(--snip-ink-3);
  cursor: not-allowed;
}
@media (prefers-color-scheme: dark) {
  #snip-ocr-sidebar {
    --snip-paper: #191c1e;
    --snip-plate: #202427;
    --snip-ink: #eceded;
    --snip-ink-2: #aeb3aa;
    --snip-ink-3: #7c8178;
    --snip-rule: rgba(236, 237, 231, 0.14);
    --snip-rule-2: rgba(236, 237, 231, 0.4);
    --snip-signal: #8fb3ff;
    --snip-signal-ink: #0e1a2e;
    --snip-proof: #ff8468;
  }
  .snip-sidebar-copy:hover:not(:disabled) {
    border-color: #b4ccff;
    background: #b4ccff;
  }
}
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    transition-duration: 0.01ms !important;
  }
}
`

function buildScript(icons: Record<ToolKey, string>): string {
  return `
(() => {
  try {
  const ICONS = ${JSON.stringify(icons)};
  const ORDER = ${JSON.stringify(TOOL_ORDER)};
  const LABELS = ${JSON.stringify(TOOL_LABELS)};
  const ACTION_PREFIX = ${JSON.stringify(OVERLAY_ACTION_PREFIX)};
  const COPY_PREFIX = ${JSON.stringify(OVERLAY_COPY_PREFIX)};

  if (!window.__snipOverlayInstalled) {
    window.__snipOverlayInstalled = true;
    window.__snipCaptureSeq = 0;
    installSidebar();
    window.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      const bar = document.getElementById('snip-ocr-sidebar');
      if (!bar || !bar.classList.contains('show')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      hideSidebar();
    }, true);
    if (window.screenshots && typeof window.screenshots.on === 'function') {
      // 库的 reset ack 在 rAF 里发送；遮罩隐藏时 rAF 会被节流，主进程会白等 500ms。
      // 这里收到 reset 立即回 ack，React 自己的 reset 仍照常执行。
      window.screenshots.on('reset', () => {
        try { window.screenshots.reset(); } catch {}
      });
      window.screenshots.on('capture', () => {
        hideSidebar();
        window.__snipCaptureSeq = (window.__snipCaptureSeq || 0) + 1;
        setLongShotCount(0);
      });
      window.screenshots.on('ocr-result', (payload) => applyOcrResult(payload));
    }
  }

  function installSidebar() {
    if (document.getElementById('snip-ocr-sidebar')) return;
    const bar = document.createElement('div');
    bar.id = 'snip-ocr-sidebar';
    bar.innerHTML = [
      '<div class="snip-sidebar-head">',
      '<span><span class="snip-sidebar-title">OCR 识别结果</span><span class="snip-sidebar-lang"></span></span>',
      '<button type="button" class="snip-sidebar-close" aria-label="关闭">×</button>',
      '</div>',
      '<textarea class="snip-sidebar-text" spellcheck="false" aria-label="OCR 识别结果" placeholder="识别结果会出现在这里"></textarea>',
      '<div class="snip-sidebar-status"></div>',
      '<div class="snip-sidebar-foot"><span class="snip-sidebar-count">0 字</span>',
      '<button type="button" class="snip-sidebar-copy" disabled>复制</button></div>'
    ].join('');
    document.body.appendChild(bar);
    const textarea = bar.querySelector('.snip-sidebar-text');
    const copyBtn = bar.querySelector('.snip-sidebar-copy');
    textarea.addEventListener('input', updateCount);
    copyBtn.addEventListener('click', copySidebarText);
    bar.querySelector('.snip-sidebar-close').addEventListener('click', hideSidebar);
  }

  let lastRequestId = 0;
  let sidebarStatus = 'loading';
  let ocrBusy = false;
  let discardOcr = false;
  let ocrTimer = 0;
  let longShotCount = 0;

  function setLongShotCount(count) {
    longShotCount = Number.isFinite(count) ? Math.max(0, Math.floor(count)) : 0;
    const button = document.querySelector('.snip-tool-btn[data-snip-tool="longshot"]');
    if (button) {
      const label = button.querySelector('.snip-tool-label');
      if (label) label.textContent = longShotCount ? '继续' : '长图';
      button.title = longShotCount ? '继续长截图' : '长截图';
    }
    if (longShotCount) scheduleSizeBadge();
    else updateSizeBadge();
  }

  function sidebar() { return document.getElementById('snip-ocr-sidebar'); }
  function setOcrBusy(busy) {
    ocrBusy = busy;
    document.querySelectorAll('.snip-tool-btn').forEach((button) => {
      const key = button.dataset.snipTool;
      if (key === 'ocr') button.disabled = busy;
    });
    if (!busy && ocrTimer) {
      clearTimeout(ocrTimer);
      ocrTimer = 0;
    }
  }
  function hideSidebar() {
    const bar = sidebar();
    if (bar) bar.classList.remove('show');
    if (ocrBusy) discardOcr = true;
    setOcrBusy(false);
  }
  function positionSidebar() {
    const bar = sidebar();
    if (!bar) return;
    const canvas = document.querySelector('.screenshots-canvas');
    let side = 'right';
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.left + rect.width / 2 > window.innerWidth / 2) side = 'left';
    }
    const width = Math.min(340, Math.round(window.innerWidth * 0.4));
    bar.style.width = width + 'px';
    if (side === 'left') {
      bar.style.left = '24px';
      bar.style.right = 'auto';
    } else {
      bar.style.right = '24px';
      bar.style.left = 'auto';
    }
  }
  function updateCount() {
    const bar = sidebar();
    if (!bar) return;
    const value = bar.querySelector('.snip-sidebar-text').value || '';
    bar.querySelector('.snip-sidebar-count').textContent = value.length + ' 字';
  }
  function setStatus(text, isError) {
    const bar = sidebar();
    if (!bar) return;
    const el = bar.querySelector('.snip-sidebar-status');
    el.textContent = text || '';
    el.classList.toggle('error', Boolean(isError));
  }
  function showSidebar(title, text, status, language) {
    installSidebar();
    const bar = sidebar();
    bar.querySelector('.snip-sidebar-title').textContent = title;
    bar.querySelector('.snip-sidebar-lang').textContent = language || '';
    const textarea = bar.querySelector('.snip-sidebar-text');
    textarea.value = text || '';
    textarea.readOnly = status !== 'ready';
    sidebarStatus = status;
    setStatus(status === 'loading' ? '' : '', false);
    const copyBtn = bar.querySelector('.snip-sidebar-copy');
    copyBtn.disabled = status !== 'ready' || !(text || '').trim();
    copyBtn.textContent = '复制';
    updateCount();
    bar.classList.add('show');
    positionSidebar();
    textarea.focus();
  }
  function applyOcrResult(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (discardOcr) {
      discardOcr = false;
      if (typeof payload.requestId === 'number') lastRequestId = payload.requestId;
      setOcrBusy(false);
      return;
    }
    if (typeof payload.requestId === 'number') {
      if (payload.requestId < lastRequestId) return;
      lastRequestId = payload.requestId;
    }
    setOcrBusy(false);
    if (payload.status === 'ready') {
      showSidebar('OCR 识别结果', String(payload.text || ''), 'ready', String(payload.language || ''));
      const bar = sidebar();
      if (bar) bar.querySelector('.snip-sidebar-copy').disabled = !String(payload.text || '').trim();
    } else if (payload.status === 'error' || payload.status === 'empty') {
      showSidebar('OCR 识别结果', '', 'error', '');
      setStatus(String(payload.error || '识别失败'), true);
    }
  }
  function copySidebarText() {
    const bar = sidebar();
    if (!bar) return;
    const value = bar.querySelector('.snip-sidebar-text').value || '';
    if (!value.trim()) return;
    try {
      console.log(COPY_PREFIX + btoa(unescape(encodeURIComponent(value))));
      const btn = bar.querySelector('.snip-sidebar-copy');
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = '复制'; }, 1500);
    } catch {
      setStatus('复制失败', true);
    }
  }

  function findLibraryButton(title) {
    return Array.from(document.querySelectorAll('.screenshots-button'))
      .find((node) => node.title === title);
  }
  function onTool(key) {
    if (key === 'longshot') {
      console.log(ACTION_PREFIX + JSON.stringify({ action: 'longshot' }));
      return;
    }
    if (key === 'save') {
      const button = findLibraryButton('保存为文件');
      if (button) button.click();
      return;
    }
    if (key === 'cancel') {
      const button = findLibraryButton('关闭');
      if (button) button.click();
      return;
    }
    if (key === 'confirm') {
      const button = findLibraryButton('复制到剪贴板');
      if (button) button.click();
      return;
    }
    if (key === 'pin') {
      const button = findLibraryButton('复制到剪贴板');
      if (!button) return;
      window.__snipPinRequest = true;
      button.click();
      return;
    }
    if (key === 'ocr') {
      if (ocrBusy) return;
      discardOcr = false;
      setOcrBusy(true);
      showSidebar('OCR 识别结果', '正在识别中…', 'loading');
      console.log(ACTION_PREFIX + JSON.stringify({ action: 'ocr', requestId: Date.now() }));
      if (ocrTimer) clearTimeout(ocrTimer);
      ocrTimer = setTimeout(() => {
        ocrTimer = 0;
        if (!ocrBusy) return;
        setOcrBusy(false);
        const bar = sidebar();
        if (bar && bar.classList.contains('show')) setStatus('识别超时，请重试', true);
      }, 20000);
      return;
    }
  }

  function placeToolbarRect(x, y, width, height) {
    const op = installToolbar();
    if (width < 2 || height < 2) {
      op.style.display = 'none';
      return;
    }
    op.style.display = 'flex';
    const barWidth = op.offsetWidth;
    const barHeight = op.offsetHeight;
    let left = Math.round(x + width - barWidth);
    let top = Math.round(y + height + 10);
    if (top + barHeight > window.innerHeight - 8) top = Math.round(y - barHeight - 10);
    left = Math.max(8, Math.min(left, window.innerWidth - barWidth - 8));
    top = Math.max(8, Math.min(top, window.innerHeight - barHeight - 8));
    op.style.left = left + 'px';
    op.style.top = top + 'px';
  }
  function positionToolbar() {
    const op = document.getElementById('snip-toolbar');
    const canvas = document.querySelector('.screenshots-canvas');
    if (!op) return;
    if (!canvas || liveStart) {
      op.style.display = 'none';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    placeToolbarRect(rect.left, rect.top, rect.width, rect.height);
  }

  let sizeBadge = null;
  let sizeRaf = 0;
  let sizeSettleTimer = 0;
  let liveFrame = null;
  let liveRaf = 0;
  let liveStart = null;
  let liveSettleTimer = 0;

  function ensureSizeBadge() {
    if (sizeBadge) return sizeBadge;
    sizeBadge = document.createElement('div');
    sizeBadge.id = 'snip-size-badge';
    document.body.appendChild(sizeBadge);
    return sizeBadge;
  }
  function ensureLiveFrame() {
    if (liveFrame) return liveFrame;
    liveFrame = document.createElement('div');
    liveFrame.id = 'snip-live-frame';
    const image = document.createElement('img');
    image.id = 'snip-live-image';
    image.alt = '';
    image.draggable = false;
    liveFrame.appendChild(image);
    document.body.appendChild(liveFrame);
    return liveFrame;
  }
  function placeSizeBadge(x, y, width, height) {
    const badge = ensureSizeBadge();
    if (width < 2 || height < 2) {
      badge.style.display = 'none';
      return;
    }
    badge.textContent =
      (longShotCount ? '长图 · 第 ' + longShotCount + ' 段 · ' : '') +
      Math.round(width) + ' × ' + Math.round(height);
    badge.style.display = 'block';
    const center = Math.max(8, Math.min(window.innerWidth - 8, Math.round(x + width / 2)));
    let top = Math.round(y + height - 26);
    if (height < 34 || top < 8) top = Math.round(Math.min(window.innerHeight - 30, y + height + 6));
    badge.style.left = center + 'px';
    badge.style.top = top + 'px';
  }
  function updateSizeBadge() {
    sizeRaf = 0;
    const canvas = document.querySelector('.screenshots-canvas');
    if (!canvas) {
      ensureSizeBadge().style.display = 'none';
      return;
    }
    const rect = canvas.getBoundingClientRect();
    placeSizeBadge(rect.left, rect.top, rect.width, rect.height);
  }
  function scheduleSizeBadge() {
    if (sizeRaf) return;
    sizeRaf = requestAnimationFrame(updateSizeBadge);
  }
  function updateLiveFrame() {
    liveRaf = 0;
    const frame = ensureLiveFrame();
    if (!liveStart) {
      frame.style.display = 'none';
      return;
    }
    const x = Math.min(liveStart.x, liveStart.x2);
    const y = Math.min(liveStart.y, liveStart.y2);
    const width = Math.abs(liveStart.x2 - liveStart.x);
    const height = Math.abs(liveStart.y2 - liveStart.y);
    if (width < 2 || height < 2) {
      frame.style.display = 'none';
      placeSizeBadge(0, 0, 0, 0);
      return;
    }
    frame.style.display = 'block';
    frame.style.left = Math.round(x) + 'px';
    frame.style.top = Math.round(y) + 'px';
    frame.style.width = Math.round(width) + 'px';
    frame.style.height = Math.round(height) + 'px';
    const image = frame.querySelector('#snip-live-image');
    const background = document.querySelector('.screenshots-background-image');
    if (image instanceof HTMLImageElement) {
      if (background instanceof HTMLImageElement && background.src && image.src !== background.src) {
        image.src = background.src;
      }
      image.style.width = window.innerWidth + 'px';
      image.style.height = window.innerHeight + 'px';
      image.style.left = -Math.round(x) + 'px';
      image.style.top = -Math.round(y) + 'px';
    }
    placeSizeBadge(x, y, width, height);
  }
  function scheduleLiveFrame() {
    if (liveRaf) return;
    liveRaf = requestAnimationFrame(updateLiveFrame);
  }
  function startLiveFrame(event) {
    if (liveStart) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!target.closest('.screenshots-background')) return;
    const canvas = document.querySelector('.screenshots-canvas');
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.width >= 2 && rect.height >= 2) return;
    }
    if (liveSettleTimer) {
      clearTimeout(liveSettleTimer);
      liveSettleTimer = 0;
    }
    liveStart = { x: event.clientX, y: event.clientY, x2: event.clientX, y2: event.clientY };
    const toolbar = document.getElementById('snip-toolbar');
    if (toolbar) toolbar.style.display = 'none';
    document.body.classList.add('snip-live-drag');
    updateLiveFrame();
  }
  function endLiveFrame() {
    if (!liveStart) return;
    liveStart = null;
    document.body.classList.remove('snip-live-drag');
    if (liveRaf) {
      cancelAnimationFrame(liveRaf);
      liveRaf = 0;
    }
    if (liveSettleTimer) clearTimeout(liveSettleTimer);
    liveSettleTimer = setTimeout(() => {
      liveSettleTimer = 0;
      if (liveFrame) liveFrame.style.display = 'none';
      scheduleSizeBadge();
    }, 300);
  }

  function installToolbar() {
    let toolbar = document.getElementById('snip-toolbar');
    if (!toolbar) {
      toolbar = document.createElement('div');
      toolbar.id = 'snip-toolbar';
      document.body.appendChild(toolbar);
    }
    if (!toolbar.querySelector('.snip-tool-btn')) {
      ORDER.forEach((key) => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'snip-tool-btn' + (key === 'cancel' ? ' danger' : '');
        button.dataset.snipTool = key;
        button.title =
          key === 'pin'
            ? '生成贴图'
            : key === 'confirm'
              ? '复制到剪贴板'
              : LABELS[key];
        button.innerHTML = '<span class="snip-tool-icon">' + ICONS[key] + '</span><span class="snip-tool-label">' + LABELS[key] + '</span>';
        button.addEventListener('click', (event) => {
          event.preventDefault();
          event.stopPropagation();
          onTool(key);
        });
        toolbar.appendChild(button);
      });
    }
    return toolbar;
  }
  function ensureToolbar() {
    installToolbar();
    positionToolbar();
    if (!liveStart) scheduleSizeBadge();
    const panel = sidebar();
    if (panel && panel.classList.contains('show')) positionSidebar();
  }

  window.__snipSetTheme = (icons) => {
    if (!icons || typeof icons !== 'object') return;
    Object.keys(icons).forEach((key) => { ICONS[key] = icons[key]; });
    document.querySelectorAll('.snip-tool-btn').forEach((button) => {
      const key = button.dataset.snipTool;
      const icon = button.querySelector('.snip-tool-icon');
      if (key && icon && ICONS[key]) icon.innerHTML = ICONS[key];
    });
    ensureToolbar();
  };
  window.__snipHideSidebar = hideSidebar;
  window.__snipSetLongShot = setLongShotCount;
  window.__snipCropSelection = () => {
    const image = document.querySelector('.screenshots-background-image');
    const canvas = document.querySelector('.screenshots-canvas');
    if (!image || !canvas) return null;
    const bg = image.getBoundingClientRect();
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2 || bg.width < 1 || bg.height < 1) return null;
    const scaleX = image.naturalWidth / bg.width;
    const scaleY = image.naturalHeight / bg.height;
    const sx = Math.max(0, Math.round((rect.left - bg.left) * scaleX));
    const sy = Math.max(0, Math.round((rect.top - bg.top) * scaleY));
    const sw = Math.min(image.naturalWidth - sx, Math.round(rect.width * scaleX));
    const sh = Math.min(image.naturalHeight - sy, Math.round(rect.height * scaleY));
    if (sw < 1 || sh < 1) return null;
    const output = document.createElement('canvas');
    output.width = sw;
    output.height = sh;
    const ctx = output.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return output.toDataURL('image/png');
  };
  // 按固定 DIP 矩形裁切：长截图各段都用同一矩形，保证像素尺寸完全一致
  window.__snipCropRect = (x, y, width, height) => {
    const image = document.querySelector('.screenshots-background-image');
    if (!image) return null;
    const bg = image.getBoundingClientRect();
    if (bg.width < 1 || bg.height < 1) return null;
    const scaleX = image.naturalWidth / bg.width;
    const scaleY = image.naturalHeight / bg.height;
    const sx = Math.max(0, Math.round((x - bg.left) * scaleX));
    const sy = Math.max(0, Math.round((y - bg.top) * scaleY));
    const sw = Math.min(image.naturalWidth - sx, Math.round(width * scaleX));
    const sh = Math.min(image.naturalHeight - sy, Math.round(height * scaleY));
    if (sw < 1 || sh < 1) return null;
    const output = document.createElement('canvas');
    output.width = sw;
    output.height = sh;
    const ctx = output.getContext('2d');
    if (!ctx) return null;
    ctx.drawImage(image, sx, sy, sw, sh, 0, 0, sw, sh);
    return output.toDataURL('image/png');
  };

  const schedule = () => {
    if (window.__snipOverlayRaf) return;
    window.__snipOverlayRaf = requestAnimationFrame(() => {
      window.__snipOverlayRaf = 0;
      ensureToolbar();
    });
  };
  const observer = new MutationObserver(schedule);
  observer.observe(document.body, { childList: true, subtree: true });
  window.addEventListener('resize', () => {
    schedule();
    if (liveStart) scheduleLiveFrame();
    else scheduleSizeBadge();
  });
  window.addEventListener('pointermove', (event) => {
    if (liveStart) {
      liveStart.x2 = event.clientX;
      liveStart.y2 = event.clientY;
      scheduleLiveFrame();
      return;
    }
    scheduleSizeBadge();
  }, { passive: true });
  window.addEventListener('pointerdown', (event) => {
    startLiveFrame(event);
    schedule();
    if (!liveStart) scheduleSizeBadge();
  }, { passive: true, capture: true });
  function finishLivePointer(event) {
    document.body.classList.remove('snip-live-drag');
    if (liveStart) {
      liveStart.x2 = event.clientX;
      liveStart.y2 = event.clientY;
      updateLiveFrame();
      const x = Math.min(liveStart.x, liveStart.x2);
      const y = Math.min(liveStart.y, liveStart.y2);
      const width = Math.abs(liveStart.x2 - liveStart.x);
      const height = Math.abs(liveStart.y2 - liveStart.y);
      placeToolbarRect(x, y, width, height);
      endLiveFrame();
    }
    if (liveFrame && !liveStart) liveFrame.style.display = 'none';
    schedule();
    setTimeout(() => ensureToolbar(), 0);
    setTimeout(() => ensureToolbar(), 60);
    setTimeout(() => ensureToolbar(), 200);
    setTimeout(() => ensureToolbar(), 350);
    setTimeout(() => ensureToolbar(), 600);
    if (sizeSettleTimer) clearTimeout(sizeSettleTimer);
    sizeSettleTimer = setTimeout(() => scheduleSizeBadge(), 350);
  }
  window.addEventListener('pointerup', finishLivePointer, { passive: true, capture: true });
  // 某些合成/特殊鼠标事件只给 mouseup，不给 pointerup；再兜一次收尾
  window.addEventListener('mouseup', finishLivePointer, { passive: true, capture: true });
  window.addEventListener('pointercancel', () => endLiveFrame(), { passive: true });

  // singleWindow 复用遮罩页时，库的 React 会重建工具栏容器；每次 capture 后主动补回按钮
  if (window.screenshots && typeof window.screenshots.on === 'function') {
    window.screenshots.on('capture', () => {
      liveStart = null;
      document.body.classList.remove('snip-live-drag');
      if (liveRaf) {
        cancelAnimationFrame(liveRaf);
        liveRaf = 0;
      }
      if (liveSettleTimer) {
        clearTimeout(liveSettleTimer);
        liveSettleTimer = 0;
      }
      if (liveFrame) liveFrame.style.display = 'none';
      ensureSizeBadge().style.display = 'none';
      ensureToolbar();
      schedule();
      scheduleSizeBadge();
      requestAnimationFrame(() => ensureToolbar());
      setTimeout(() => ensureToolbar(), 60);
      setTimeout(() => ensureToolbar(), 200);
      setTimeout(() => ensureToolbar(), 400);
      setTimeout(() => ensureToolbar(), 700);
    });
  }
  ensureToolbar();
  } catch (error) {
    console.error('[snip-overlay-error]', error && (error.stack || error));
    throw error;
  }
})();
`
}

export async function installOverlayUi(
  contents: WebContents,
  theme: IconTheme,
  customIconUrl: string | null,
): Promise<void> {
  await contents.insertCSS(OVERLAY_CSS)
  await contents.executeJavaScript(buildScript(overlayIcons(theme, customIconUrl)))
}

export async function updateOverlayTheme(
  contents: WebContents,
  theme: IconTheme,
  customIconUrl: string | null,
): Promise<void> {
  const icons = overlayIcons(theme, customIconUrl)
  await contents.executeJavaScript(`window.__snipSetTheme?.(${JSON.stringify(icons)})`)
}

export async function hideOverlaySidebar(contents: WebContents): Promise<void> {
  await contents.executeJavaScript('window.__snipHideSidebar?.()')
}

export async function captureOverlaySelection(contents: WebContents): Promise<Buffer | null> {
  const dataUrl = (await contents.executeJavaScript(
    'window.__snipCropSelection ? window.__snipCropSelection() : null',
  )) as unknown
  return decodePngDataUrl(dataUrl)
}

/** 按固定 DIP 矩形裁切，长截图各段共用同一矩形 */
export async function captureOverlayRect(
  contents: WebContents,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<Buffer | null> {
  const dataUrl = (await contents.executeJavaScript(
    `window.__snipCropRect ? window.__snipCropRect(${bounds.x}, ${bounds.y}, ${bounds.width}, ${bounds.height}) : null`,
  )) as unknown
  return decodePngDataUrl(dataUrl)
}

function decodePngDataUrl(dataUrl: unknown): Buffer | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return null
  try {
    return Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64')
  } catch {
    return null
  }
}
