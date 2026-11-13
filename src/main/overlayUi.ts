import type { WebContents } from 'electron'
import { TOOL_LABELS, toolIconFor, type ToolKey } from '@shared/icons'
import type { IconTheme } from '@shared/ipc'
import {
  OVERLAY_ACTION_PREFIX,
  OVERLAY_COPY_PREFIX,
  OVERLAY_HUD_RECT_PREFIX,
  OVERLAY_PIN_REQUEST_KEY,
  OVERLAY_REPLY_NAMES,
  OVERLAY_TRANSLATE_PREFIX,
  OVERLAY_TRANSLATE_STATUS_PREFIX,
} from '@shared/overlayProtocol'
import designTokensCss from '@shared/designTokens.css?raw'
import overlayCss from './overlay/overlay.css?raw'
import { installCropSelection } from './overlay/cropSelection'
import { installLongShotHud } from './overlay/longShotHud'
import { installAnnotationLayer } from './overlay/annotationLayer'
import {
  ANNOTATION_COLORS,
  ANNOTATION_COLOR_LABELS,
  ANNOTATION_COLOR_ORDER,
  ANNOTATION_STROKE_WIDTH,
  ANNOTATION_TOOL_LABELS,
  ANNOTATION_TOOLS,
  appendAnnotationPoint,
  createAnnotationStroke,
  eraseAnnotationStrokes,
  isPointOnAnnotation,
  renderAnnotations,
} from '@shared/annotation'

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


function buildScript(icons: Record<ToolKey, string>): string {
  return `
(() => {
  try {
  const ICONS = ${JSON.stringify(icons)};
  const ORDER = ${JSON.stringify(TOOL_ORDER)};
  const LABELS = ${JSON.stringify(TOOL_LABELS)};
  const ACTION_PREFIX = ${JSON.stringify(OVERLAY_ACTION_PREFIX)};
  const COPY_PREFIX = ${JSON.stringify(OVERLAY_COPY_PREFIX)};
  const TRANSLATE_PREFIX = ${JSON.stringify(OVERLAY_TRANSLATE_PREFIX)};
  const TRANSLATE_STATUS_PREFIX = ${JSON.stringify(OVERLAY_TRANSLATE_STATUS_PREFIX)};
  const HUD_PREFIX = ${JSON.stringify(OVERLAY_HUD_RECT_PREFIX)};
  const PIN_REQUEST_KEY = ${JSON.stringify(OVERLAY_PIN_REQUEST_KEY)};
  const REPLY_NAMES = ${JSON.stringify(OVERLAY_REPLY_NAMES)};
  const ANNOT_COLORS = ${JSON.stringify(ANNOTATION_COLORS)};
  const ANNOT_COLOR_LABELS = ${JSON.stringify(ANNOTATION_COLOR_LABELS)};
  const ANNOT_COLOR_ORDER = ${JSON.stringify(ANNOTATION_COLOR_ORDER)};
  const ANNOT_LABELS = ${JSON.stringify(ANNOTATION_TOOL_LABELS)};
  const ANNOT_TOOLS = ${JSON.stringify(ANNOTATION_TOOLS)};
  const ANNOT_STROKE_WIDTH = ${JSON.stringify(ANNOTATION_STROKE_WIDTH)};

  if (!window.__snipOverlayInstalled) {
    window.__snipOverlayInstalled = true;
    window.__snipCaptureSeq = 0;
    window.__snipAnnot = (${installAnnotationLayer.toString()})({
      colors: ANNOT_COLORS,
      colorLabels: ANNOT_COLOR_LABELS,
      labels: ANNOT_LABELS,
      toolOrder: ANNOT_TOOLS,
      colorOrder: ANNOT_COLOR_ORDER,
      strokeWidth: ANNOT_STROKE_WIDTH,
      createStroke: ${createAnnotationStroke.toString()},
      appendPoint: ${appendAnnotationPoint.toString()},
      hitTest: ${isPointOnAnnotation.toString()},
      erase: ${eraseAnnotationStrokes.toString()},
      render: ${renderAnnotations.toString()},
    });
    installSidebar();
    if (window.screenshots && typeof window.screenshots.on === 'function') {
      // 库的 reset ack 在 rAF 里发送；遮罩隐藏时 rAF 会被节流，主进程会白等 500ms。
      // 这里收到 reset 立即回 ack，React 自己的 reset 仍照常执行。
      window.screenshots.on('reset', () => {
        try { window.screenshots.reset(); } catch {}
      });
      window.screenshots.on('capture', () => {
        hideSidebar();
        resetSidebarDrag();
        resetTranslation();
        requestTranslateStatus();
        window.__snipAnnot?.reset();
        window.__snipCaptureSeq = (window.__snipCaptureSeq || 0) + 1;
        setLongShotCount(0);
      });
      window.screenshots.on(REPLY_NAMES.ocrResult, (payload) => applyOcrResult(payload));
      window.screenshots.on(REPLY_NAMES.translateStatus, (payload) => applyTranslateStatus(payload));
      window.screenshots.on(REPLY_NAMES.translateResult, (payload) => applyTranslateResult(payload));
      requestTranslateStatus();
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
      '<div class="snip-sidebar-translation" hidden></div>',
      '<div class="snip-sidebar-status"></div>',
      '<div class="snip-sidebar-foot"><span class="snip-sidebar-count">0 字</span>',
      '<span class="snip-sidebar-actions">',
      '<button type="button" class="snip-sidebar-translate" disabled title="正在检查翻译插件…">译成中文</button>',
      '<button type="button" class="snip-sidebar-copy" disabled>复制</button>',
      '</span></div>'
    ].join('');
    document.body.appendChild(bar);
    const textarea = bar.querySelector('.snip-sidebar-text');
    const copyBtn = bar.querySelector('.snip-sidebar-copy');
    const translateBtn = bar.querySelector('.snip-sidebar-translate');
    textarea.addEventListener('input', updateCount);
    copyBtn.addEventListener('click', copySidebarText);
    translateBtn.addEventListener('click', translateSidebarText);
    bar.querySelector('.snip-sidebar-close').addEventListener('click', hideSidebar);
    // 只在标题条空白处起拖，textarea/复制/关闭的指针事件不受影响
    bar.querySelector('.snip-sidebar-head').addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      if (event.target.closest('.snip-sidebar-close')) return;
      startSidebarDrag(event);
    });
  }

  let lastRequestId = 0;
  let sidebarStatus = 'loading';
  let sidebarDragged = false;
  let ocrBusy = false;
  let discardOcr = false;
  let ocrTimer = 0;
  let longShotCount = 0;
  /** null = 尚未收到主进程的插件状态；对象 = 各方向可用性 */
  let translateStatus = null;
  let translatePluginDir = '';
  let translateDirection = null;
  /** idle | loading | done | error */
  let translateState = 'idle';

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
    scheduleReportRects();
  }
  function resetSidebarDrag() {
    sidebarDragged = false;
    const bar = sidebar();
    if (!bar) return;
    bar.classList.remove('dragged', 'dragging');
    bar.style.left = '';
    bar.style.top = '';
    bar.style.right = '';
    bar.style.transform = '';
  }
  function startSidebarDrag(event) {
    const bar = sidebar();
    if (!bar) return;
    const rect = bar.getBoundingClientRect();
    const offsetX = event.clientX - rect.left;
    const offsetY = event.clientY - rect.top;
    sidebarDragged = true;
    bar.classList.add('dragging', 'dragged');
    const onMove = (moveEvent) => {
      const maxLeft = Math.max(0, window.innerWidth - bar.offsetWidth);
      const maxTop = Math.max(0, window.innerHeight - bar.offsetHeight);
      const left = Math.min(maxLeft, Math.max(0, moveEvent.clientX - offsetX));
      const top = Math.min(maxTop, Math.max(0, moveEvent.clientY - offsetY));
      bar.style.left = Math.round(left) + 'px';
      bar.style.top = Math.round(top) + 'px';
      bar.style.right = 'auto';
      bar.style.transform = 'none';
      scheduleReportRects();
    };
    const onUp = () => {
      bar.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      scheduleReportRects();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    onMove(event);
    event.preventDefault();
  }
  function positionSidebar() {
    const bar = sidebar();
    if (!bar) return;
    // 用户在本轮拖过就不再自动挪动
    if (sidebarDragged) {
      scheduleReportRects();
      return;
    }
    const canvas = document.querySelector('.screenshots-canvas');
    let side = 'right';
    if (canvas) {
      const rect = canvas.getBoundingClientRect();
      if (rect.left + rect.width / 2 > window.innerWidth / 2) side = 'left';
    }
    const width = Math.min(340, Math.round(window.innerWidth * 0.4));
    bar.style.width = width + 'px';
    bar.style.left = side === 'left' ? '24px' : 'auto';
    bar.style.right = side === 'left' ? 'auto' : '24px';
    bar.style.top = '';
    bar.style.transform = '';
    scheduleReportRects();
  }
  function updateCount() {
    const bar = sidebar();
    if (!bar) return;
    const value = bar.querySelector('.snip-sidebar-text').value || '';
    bar.querySelector('.snip-sidebar-count').textContent = value.length + ' 字';
    refreshTranslateButton();
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
    resetTranslation();
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
  function requestTranslateStatus() {
    try { console.log(TRANSLATE_STATUS_PREFIX); } catch {}
  }
  function applyTranslateStatus(payload) {
    if (!payload || typeof payload !== 'object') return;
    translateStatus = payload.directions && typeof payload.directions === 'object' ? payload.directions : null;
    translatePluginDir = String(payload.pluginDir || '');
    refreshTranslateButton();
  }
  function translateDirectionForLang(lang) {
    const lower = String(lang || '').toLowerCase();
    if (lower.startsWith('en')) return 'en-zh';
    if (lower.startsWith('zh')) return 'zh-en';
    return null;
  }
  function resetTranslation() {
    translateState = 'idle';
    translateDirection = null;
    const bar = sidebar();
    if (bar) {
      const box = bar.querySelector('.snip-sidebar-translation');
      if (box) {
        box.textContent = '';
        box.hidden = true;
      }
    }
    refreshTranslateButton();
  }
  function refreshTranslateButton() {
    const bar = sidebar();
    if (!bar) return;
    const btn = bar.querySelector('.snip-sidebar-translate');
    if (!btn) return;
    const lang = (bar.querySelector('.snip-sidebar-lang').textContent || '').trim();
    const text = (bar.querySelector('.snip-sidebar-text').value || '').trim();
    const direction = translateDirectionForLang(lang);
    let reason = '';
    if (!translateStatus) {
      reason = '正在检查翻译插件…';
    } else if (!direction) {
      reason = '仅支持中英互译';
    } else if (sidebarStatus !== 'ready' || !text) {
      reason = '暂无可翻译的文本';
    } else {
      const status = translateStatus[direction];
      if (!status || !status.available) reason = (status && status.reason) || '翻译不可用';
    }
    const busy = translateState === 'loading';
    btn.disabled = busy || Boolean(reason);
    btn.textContent = busy ? '翻译中…' : direction === 'zh-en' ? '译成英文' : '译成中文';
    btn.title = reason || (translateState === 'done' ? '重新翻译' : direction === 'zh-en' ? '本地中译英，不联网' : '本地英译中，不联网');
    if (sidebarStatus !== 'ready' || !translateStatus) return;
    const status = direction ? translateStatus[direction] : null;
    if (status && !status.available) {
      const detail = status.reason || '翻译不可用';
      setStatus(detail === '未安装翻译插件' ? detail + '：' + (translatePluginDir || 'plugins\\translate-locally') : detail, false);
    }
  }
  function translateSidebarText() {
    const bar = sidebar();
    if (!bar || translateState === 'loading') return;
    const value = (bar.querySelector('.snip-sidebar-text').value || '').trim();
    if (!value) return;
    const direction = translateDirectionForLang((bar.querySelector('.snip-sidebar-lang').textContent || '').trim());
    if (!direction) return;
    translateDirection = direction;
    translateState = 'loading';
    setStatus('本地翻译中…', false);
    refreshTranslateButton();
    try {
      console.log(TRANSLATE_PREFIX + btoa(unescape(encodeURIComponent(JSON.stringify({ text: value, direction: direction })))));
    } catch {
      translateState = 'error';
      setStatus('翻译请求发送失败', true);
      refreshTranslateButton();
    }
  }
  function applyTranslateResult(payload) {
    if (!payload || typeof payload !== 'object') return;
    const bar = sidebar();
    translateState = payload.ok ? 'done' : 'error';
    if (payload.ok && bar) {
      const box = bar.querySelector('.snip-sidebar-translation');
      box.textContent = String(payload.text || '');
      box.hidden = !box.textContent.trim();
      setStatus(translateDirection === 'zh-en' ? '已译成英文' : '已译成中文', false);
    } else {
      setStatus(String(payload.reason || '翻译失败'), true);
    }
    refreshTranslateButton();
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
      // 有笔迹时先用合成图交给库原有保存通道（弹窗/写盘仍由库负责）
      if (window.__snipAnnot?.hasStrokes() && window.__snipAnnot.commit('save')) return;
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
      if (window.__snipAnnot?.hasStrokes() && window.__snipAnnot.commit('copy')) return;
      const button = findLibraryButton('复制到剪贴板');
      if (button) button.click();
      return;
    }
    if (key === 'pin') {
      if (window.__snipAnnot?.hasStrokes() && window.__snipAnnot.commit('pin')) return;
      const button = findLibraryButton('复制到剪贴板');
      if (!button) return;
      window[PIN_REQUEST_KEY] = true;
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
    // 画笔模式下拖拽只画线，不重新框选
    if (window.__snipAnnot?.active()) return;
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
      const actions = document.createElement('div');
      actions.className = 'snip-toolbar-actions';
      toolbar.appendChild(actions);
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
        actions.appendChild(button);
      });
    }
    if (window.__snipAnnot) window.__snipAnnot.mount(toolbar);
    return toolbar;
  }
  function ensureToolbar() {
    installToolbar();
    if (window.__snipAnnot) window.__snipAnnot.sync();
    positionToolbar();
    if (!liveStart) scheduleSizeBadge();
    const panel = sidebar();
    if (panel && panel.classList.contains('show')) positionSidebar();
  }

  let rectRaf = 0;
  function scheduleReportRects() {
    if (rectRaf) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = 0;
      reportRects();
    });
  }
  const LONG = (${installLongShotHud.toString()})({
    actionPrefix: ACTION_PREFIX,
    icons: () => ICONS,
    reportRects: () => scheduleReportRects(),
    hideSidebar: () => hideSidebar(),
    isOcrBusy: () => ocrBusy,
    beginLongOcr: () => {
      discardOcr = false;
      setOcrBusy(true);
      showSidebar('OCR 识别结果', '正在识别长截图…', 'loading');
    },
  });
  function reportRects() {
    const toRect = (element) => {
      if (!element || element.style.display === 'none') return null;
      const rect = element.getBoundingClientRect();
      if (rect.width < 1 || rect.height < 1) return null;
      return {
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      };
    };
    const bar = sidebar();
    console.log(HUD_PREFIX + JSON.stringify({
      hud: toRect(LONG.hudElement()),
      sidebar: bar && bar.classList.contains('show') ? toRect(bar) : null
    }));
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
  (${installCropSelection.toString()})();
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
  // 双击复制：有笔迹时改走合成图，避免库内部 compose 丢掉标注
  window.addEventListener('dblclick', (event) => {
    const target = event.target;
    if (target instanceof Element && target.closest('#snip-toolbar, #snip-ocr-sidebar, #snip-long-hud')) return;
    if (!window.__snipAnnot || window.__snipAnnot.active() || !window.__snipAnnot.hasStrokes()) return;
    event.preventDefault();
    event.stopPropagation();
    window.__snipAnnot.commit('copy');
  }, { capture: true });

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
  await contents.insertCSS(`${designTokensCss}\n${overlayCss}`)
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

/** 读取遮罩内当前选区的裁剪 PNG，供 OCR / 贴图使用 */
export async function captureOverlaySelection(contents: WebContents): Promise<Buffer | null> {
  const dataUrl = (await contents.executeJavaScript(
    'window.__snipCropSelection ? window.__snipCropSelection() : null',
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
