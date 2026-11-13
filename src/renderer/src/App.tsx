import { useCallback, useEffect, useRef, useState } from 'react'
import HotkeyRecorder from './HotkeyRecorder'
import { prettyAccelerator } from './accelerator'
import {
  DEFAULT_HOTKEY,
  DEFAULT_PIN_HOTKEY,
  HISTORY_LIMITS,
  type HistoryLimit,
  type HistorySource,
  type IconTheme,
  type OcrLanguageInfo,
  type PinHistoryItem,
  type SetHotkeyResult,
  type SnipState,
  type UpdateProgress,
  type UpdateStatus,
} from '@shared/ipc'
import { toolIconFor, TOOL_LABELS, type ToolKey } from '@shared/icons'

type Tab = 'hotkeys' | 'general' | 'icons'

const HISTORY_SOURCE_LABELS: Record<HistorySource, string> = {
  copy: '复制',
  save: '另存',
  pin: '贴图',
  longshot: '长图',
}

interface HotkeySettingProps {
  title: string
  desc: string
  value: string
  defaultValue: string
  platform: string
  stateError: string | null
  onApply: (accelerator: string) => Promise<SetHotkeyResult>
}

function BrandMark() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="square">
      <path d="M3 8V3h5" />
      <path d="M16 3h5v5" />
      <path d="M21 16v5h-5" />
      <path d="M8 21H3v-5" />
      <path d="M12 9v6M9 12h6" opacity="0.5" />
    </svg>
  )
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="4" y1="7" x2="20" y2="7" />
      <circle cx="9" cy="7" r="2.5" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <circle cx="15" cy="12" r="2.5" />
      <line x1="4" y1="17" x2="20" y2="17" />
      <circle cx="11" cy="17" r="2.5" />
    </svg>
  )
}

function MinimizeIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </svg>
  )
}

function CaptureIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <path d="M4 8V4h4" />
      <path d="M16 4h4v4" />
      <path d="M20 16v4h-4" />
      <path d="M8 20H4v-4" />
      <rect x="8" y="8" width="8" height="8" opacity="0.6" />
    </svg>
  )
}

function BackIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <line x1="19" y1="12" x2="5" y2="12" />
      <polyline points="11 18 5 12 11 6" />
    </svg>
  )
}

function HotkeySetting({
  title,
  desc,
  value,
  defaultValue,
  platform,
  stateError,
  onApply,
}: HotkeySettingProps) {
  const [pending, setPending] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const effective = pending ?? value
  const dirty = pending !== null && pending !== value
  const applyDisabled = busy || !dirty || (pending !== null && pending === failed)

  const apply = async (accelerator: string): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await onApply(accelerator)
    setBusy(false)
    if (result.ok) {
      setPending(null)
      setFailed(null)
    } else {
      setError(result.error ?? '快捷键注册失败')
      setFailed(accelerator)
    }
  }

  return (
    <div className="setting-block">
      <div className="s-info hotkey-info">
        <div className="s-title">{title}</div>
        <div className="s-desc">{desc}</div>
      </div>
      <HotkeyRecorder
        value={effective}
        platform={platform}
        onPick={(next) => {
          setPending(next)
          setError(null)
          setFailed(null)
        }}
      />
      <p className="tip">
        默认 <b>{prettyAccelerator(defaultValue, platform)}</b>。单键或无修饰键的组合（F1–F12 除外）
        不被接受。
      </p>
      {error ? <p className="error">{error}</p> : null}
      {stateError && !error ? <p className="error">{stateError}</p> : null}
      <div className="row">
        <button
          type="button"
          className="primary"
          disabled={applyDisabled}
          onClick={() => void apply(effective)}
        >
          {busy ? '应用中…' : '应用'}
        </button>
        <button type="button" disabled={busy} onClick={() => setPending(null)}>
          取消
        </button>
        <button
          type="button"
          className="danger-outline"
          disabled={busy}
          onClick={() => void apply(defaultValue)}
        >
          恢复默认
        </button>
      </div>
    </div>
  )
}

function Switch({
  checked,
  onChange,
  label,
  disabled = false,
}: {
  checked: boolean
  onChange: (next: boolean) => void
  label: string
  disabled?: boolean
}) {
  return (
    <label className={`switch${disabled ? ' disabled' : ''}`}>
      <input
        type="checkbox"
        checked={checked}
        aria-label={label}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="slider" />
    </label>
  )
}

const ICON_CARDS: { theme: IconTheme; label: string }[] = [
  { theme: 'default', label: '默认线框' },
  { theme: 'deepseek', label: 'DeepSeek 大肥鱼' },
  { theme: 'chibi', label: '菲比丘比' },
  { theme: 'custom', label: '自定义图标' },
]

const CUSTOM_UPLOAD_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>'

function formatHistoryTime(value: number): string {
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
    date.getHours(),
  )}:${pad(date.getMinutes())}`
}

function formatClock(value: number): string {
  const date = new Date(value)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 设置页七态文案：检查中 / 已是最新 / 发现新版本 / 下载中 / 待重启 / 失败 / 未检查 */
function describeUpdate(update: UpdateStatus | null, progress: UpdateProgress | null): string {
  if (!update) return '未检查更新'
  if (!update.supported) return '便携版或开发版不支持在线更新，请手动下载新版本'
  const failure = update.error
    ? `上次检查更新失败：${update.error}${update.errorAt ? `（${formatHistoryTime(update.errorAt)}）` : ''}`
    : '未检查更新'
  switch (update.phase) {
    case 'checking':
      return '正在检查更新…'
    case 'latest': {
      const clock = update.checkedAt ? ` · ${formatClock(update.checkedAt)}` : ''
      return `当前已是最新版本 v${update.latestVersion ?? update.currentVersion}${clock}`
    }
    case 'available':
      return update.autoDownload
        ? `发现新版本 v${update.latestVersion}，即将后台下载…`
        : `发现新版本 v${update.latestVersion}`
    case 'downloading':
      return `正在下载 v${update.latestVersion} · ${Math.round(progress?.percent ?? 0)}%`
    case 'downloaded':
      return `v${update.latestVersion} 已下载，重启后完成安装`
    case 'error':
      return failure
    default:
      return failure
  }
}

export default function App() {
  const [state, setState] = useState<SnipState | null>(null)
  const [tab, setTab] = useState<Tab | null>(null)
  const [historyOpen, setHistoryOpen] = useState(false)
  const [history, setHistory] = useState<PinHistoryItem[] | null>(null)
  const [historyVersion, setHistoryVersion] = useState(0)
  const [toast, setToast] = useState<string | null>(null)
  const [update, setUpdate] = useState<UpdateStatus | null>(null)
  const [updateProgress, setUpdateProgress] = useState<UpdateProgress | null>(null)
  const [ocrLanguages, setOcrLanguages] = useState<OcrLanguageInfo[]>([])
  const [ocrLanguagesError, setOcrLanguagesError] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = useCallback((text: string) => {
    setToast(text)
    if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2000)
  }, [])

  useEffect(() => {
    let alive = true
    void window.snip.getState().then((next) => {
      if (alive) setState(next)
    })
    const offState = window.snip.onStateChanged((next) => setState(next))
    void window.snip.getUpdateStatus().then((next) => {
      if (alive) setUpdate(next)
    })
    const offUpdate = window.snip.onUpdateStatus((next) => {
      // 进入下载态时清空上一次的进度，退出下载态后不再展示进度条
      setUpdateProgress((prev) => (next.phase === 'downloading' ? (prev ?? null) : null))
      setUpdate(next)
    })
    const offProgress = window.snip.onUpdateProgress((next) => setUpdateProgress(next))
    const offSettings = window.snip.onOpenSettings(() => {
      setHistoryOpen(false)
      setTab('hotkeys')
    })
    window.snip.ready()
    return () => {
      alive = false
      offState()
      offUpdate()
      offProgress()
      offSettings()
      if (toastTimer.current !== null) window.clearTimeout(toastTimer.current)
    }
  }, [])

  useEffect(() => {
    if (!tab && !historyOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        setTab(null)
        setHistoryOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [tab, historyOpen])

  const loadHistory = useCallback(() => {
    void window.snip.listPinHistory().then(setHistory)
  }, [])

  useEffect(() => {
    const off = window.snip.onPinHistoryChanged(() => setHistoryVersion((value) => value + 1))
    return off
  }, [])

  // 打开历史页时读取；新建贴图或历史失效时同步刷新
  useEffect(() => {
    if (!historyOpen) return
    loadHistory()
  }, [historyOpen, historyVersion, loadHistory])

  // 打开设置时读取系统已装 OCR 语言；枚举失败如实显示原因
  useEffect(() => {
    if (tab !== 'general') return
    let alive = true
    void window.snip.listOcrLanguages().then((result) => {
      if (!alive) return
      setOcrLanguages(result.languages)
      setOcrLanguagesError(result.error ?? null)
    })
    return () => {
      alive = false
    }
  }, [tab])

  const platform = state?.platform ?? 'win32'
  const hotkey = state?.hotkey ?? DEFAULT_HOTKEY
  const pinHotkey = state?.pinHotkey ?? DEFAULT_PIN_HOTKEY
  const pinCount = state?.pinCount ?? 0
  const version = state?.version ?? '0.1.0'
  const updatePhase = update?.phase ?? 'idle'
  const checking = updatePhase === 'checking'
  const updateText = describeUpdate(update, updateProgress)
  const progressPercent = Math.max(0, Math.min(100, Math.round(updateProgress?.percent ?? 0)))
  const updateUnsupported = update?.supported === false

  const applyScreenshotHotkey = async (accelerator: string): Promise<SetHotkeyResult> => {
    const result = await window.snip.setHotkey(accelerator)
    if (result.ok) showToast('已保存')
    return result
  }

  const applyPinHotkey = async (accelerator: string): Promise<SetHotkeyResult> => {
    const result = await window.snip.setPinHotkey(accelerator)
    if (result.ok) showToast('已保存')
    else showToast(result.error ?? '贴图快捷键注册失败')
    return result
  }

  const applyTheme = async (theme: IconTheme): Promise<void> => {
    const result = await window.snip.setIconTheme(theme)
    if (result.ok) showToast('已保存')
    else showToast(result.error ?? '切换图标失败')
  }

  const applyHistoryLimit = async (limit: HistoryLimit): Promise<void> => {
    const result = await window.snip.setHistoryLimit(limit)
    if (result.ok) {
      showToast(`已切换为 ${limit} 条`)
      loadHistory()
    } else {
      showToast(result.error ?? '切换失败')
    }
  }

  const applyOcrLanguage = async (tag: string): Promise<void> => {
    const result = await window.snip.setOcrLanguage(tag)
    if (result.ok) showToast(tag ? '已切换 OCR 识别语言' : '已恢复系统默认')
    else showToast(result.error ?? '切换 OCR 语言失败')
  }

  const removeHistoryItem = async (id: string): Promise<void> => {
    setHistory(await window.snip.deletePinHistory(id))
    showToast('已删除')
  }

  const clearHistory = async (): Promise<void> => {
    if (!window.confirm('清空全部截图历史？此操作不可恢复。')) return
    setHistory(await window.snip.clearPinHistory())
    showToast('已清空')
  }

  const repinHistoryItem = async (id: string): Promise<void> => {
    const result = await window.snip.pinFromHistory(id)
    showToast(result.ok ? '已贴出' : (result.error ?? '贴出失败'))
  }

  const copyHistoryItem = async (id: string): Promise<void> => {
    const result = await window.snip.copyFromHistory(id)
    showToast(result.ok ? '已复制' : (result.error ?? '复制失败'))
  }

  const saveHistoryItem = async (id: string): Promise<void> => {
    const result = await window.snip.saveFromHistory(id)
    if (result.ok) showToast('已保存')
    else if (result.error !== '已取消') showToast(result.error ?? '另存失败')
  }

  return (
    <div className="app-window">
      <header className="titlebar">
        <div
          className="brand"
          data-tip="本地 OCR · 零联网：截图、识别都在本机完成，不发起任何网络请求。"
        >
          <span className="brand-mark" aria-hidden="true">
            <BrandMark />
          </span>
          <div className="title">
            snip-ocr <span className="title-version">v{version}</span>
          </div>
        </div>
        <span className={`status-chip${state?.hotkeyError || state?.pinHotkeyError ? ' error' : ''}`}>
          <span className="status-dot" />
          {state?.hotkeyError || state?.pinHotkeyError ? '快捷键冲突' : '就绪'}
        </span>
        <div className="titlebar-actions">
          <button
            type="button"
            className="icon-btn"
            aria-label="设置"
            title="设置"
            onClick={() => {
              setHistoryOpen(false)
              setTab('hotkeys')
            }}
          >
            <SettingsIcon />
          </button>
          <div className="dots">
            <button
              type="button"
              className="dot dot-yellow"
              aria-label="最小化"
              title="最小化"
              onClick={() => window.snip.windowAction('minimize')}
            >
              <MinimizeIcon />
            </button>
            <button
              type="button"
              className="dot dot-red"
              aria-label="关闭主窗口"
              data-tip="关闭窗口后仍在托盘运行，快捷键随时可用；需要完全退出请用托盘菜单。"
              onClick={() => window.snip.windowAction('close')}
            >
              <CloseIcon />
            </button>
          </div>
        </div>
      </header>

      {state?.hotkeyError || state?.pinHotkeyError ? (
        <div className="banners">
          {state?.hotkeyError ? (
            <section className="banner" role="alert">
              <span className="banner-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 3 2.5 20h19z" />
                  <line x1="12" y1="9" x2="12" y2="14" />
                  <line x1="12" y1="17" x2="12" y2="17.5" />
                </svg>
              </span>
              <div className="banner-copy">
                <div className="banner-title">
                  截图快捷键 <b>{prettyAccelerator(hotkey, platform)}</b> 被其他程序占用
                </div>
                <div className="banner-desc">当前无法用快捷键截图，点「立即截图」仍可用。</div>
              </div>
              <button type="button" className="banner-action" onClick={() => setTab('hotkeys')}>
                换个快捷键
              </button>
            </section>
          ) : null}
          {state?.pinHotkeyError ? (
            <section className="banner" role="alert">
              <span className="banner-mark" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 3 2.5 20h19z" />
                  <line x1="12" y1="9" x2="12" y2="14" />
                  <line x1="12" y1="17" x2="12" y2="17.5" />
                </svg>
              </span>
              <div className="banner-copy">
                <div className="banner-title">
                  贴图快捷键 <b>{prettyAccelerator(pinHotkey, platform)}</b> 被其他程序占用
                </div>
                <div className="banner-desc">贴最近一张暂时不可用，可在截图历史里手动贴出。</div>
              </div>
              <button type="button" className="banner-action" onClick={() => setTab('hotkeys')}>
                换个快捷键
              </button>
            </section>
          ) : null}
        </div>
      ) : null}

      <main className={`app-body${tab || historyOpen ? ' settings-mode' : ''}`}>
        {historyOpen ? (
          <section className="settings-page" aria-label="截图历史">
            <header className="settings-head">
              <button
                type="button"
                className="x-btn"
                aria-label="关闭截图历史"
                title="返回首页"
                onClick={() => setHistoryOpen(false)}
              >
                <BackIcon />
              </button>
              <h2>截图历史</h2>
              <span className="settings-version">
                {history?.length ?? 0} 条 · 上限 {state?.historyLimit ?? 10} 条
              </span>
            </header>
            <div className="panes">
              <div className="history-bar">
                <span className="history-note">按创建时间倒序；点击缩略图重新贴出，复制/另存不新增记录</span>
                <label className="history-limit">
                  保留
                  <select
                    value={state?.historyLimit ?? 10}
                    onChange={(event) => void applyHistoryLimit(Number(event.target.value) as HistoryLimit)}
                  >
                    {HISTORY_LIMITS.map((limit) => (
                      <option key={limit} value={limit}>
                        {limit}
                      </option>
                    ))}
                  </select>
                  条
                </label>
                <button
                  type="button"
                  className="ghost-btn danger"
                  disabled={!history?.length}
                  onClick={() => void clearHistory()}
                >
                  清空全部
                </button>
              </div>
              {history === null ? (
                <p className="history-empty">正在读取截图历史…</p>
              ) : history.length === 0 ? (
                <p className="history-empty">还没有截图历史。复制、另存、贴图或长图完成后会自动记录。</p>
              ) : (
                <ul className="history-list">
                  {history.map((item) => (
                    <li key={item.id} className="history-item">
                      <button
                        type="button"
                        className="history-open"
                        title="重新贴出这张截图"
                        onClick={() => void repinHistoryItem(item.id)}
                      >
                        <span className="history-thumb">
                          <img src={item.thumbUrl} alt="" draggable={false} />
                        </span>
                        <span className="history-meta">
                          <span className="history-time">{formatHistoryTime(item.createdAt)}</span>
                          <span className="history-size">
                            {HISTORY_SOURCE_LABELS[item.source]} · {item.imageWidth} × {item.imageHeight} px
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        className="history-act"
                        title="复制这张截图"
                        onClick={() => void copyHistoryItem(item.id)}
                      >
                        复制
                      </button>
                      <button
                        type="button"
                        className="history-act"
                        title="另存为"
                        onClick={() => void saveHistoryItem(item.id)}
                      >
                        另存
                      </button>
                      <button
                        type="button"
                        className="history-del"
                        aria-label="删除这条截图历史"
                        title="删除"
                        onClick={() => void removeHistoryItem(item.id)}
                      >
                        ×
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        ) : tab ? (
          <section className="settings-page" aria-label="设置">
            <header className="settings-head">
              <button
                type="button"
                className="x-btn"
                aria-label="关闭设置"
                title="返回首页"
                onClick={() => setTab(null)}
              >
                <BackIcon />
              </button>
              <h2>设置</h2>
              <span className="settings-version">v{version}</span>
            </header>
            <div className="settings-body">
              <nav className="tabs" aria-label="设置分类">
                <button
                  type="button"
                  className={`tab${tab === 'hotkeys' ? ' active' : ''}`}
                  onClick={() => setTab('hotkeys')}
                >
                  快捷键
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'general' ? ' active' : ''}`}
                  onClick={() => setTab('general')}
                >
                  通用设置
                </button>
                <button
                  type="button"
                  className={`tab${tab === 'icons' ? ' active' : ''}`}
                  onClick={() => setTab('icons')}
                >
                  图标定制
                </button>
              </nav>
              <div className="panes">
                {tab === 'hotkeys' ? (
                  <div className="pane active">
                    <HotkeySetting
                      title="截图快捷键"
                      desc="按下组合键立即开始截图"
                      value={hotkey}
                      defaultValue={DEFAULT_HOTKEY}
                      platform={platform}
                      stateError={state?.hotkeyError ?? null}
                      onApply={applyScreenshotHotkey}
                    />
                    <HotkeySetting
                      title="贴图快捷键"
                      desc="快速贴出最近一次截图"
                      value={pinHotkey}
                      defaultValue={DEFAULT_PIN_HOTKEY}
                      platform={platform}
                      stateError={state?.pinHotkeyError ?? null}
                      onApply={applyPinHotkey}
                    />
                  </div>
                ) : null}

                {tab === 'general' ? (
                  <div className="pane active">
                    <div className="setting-row">
                      <div className="s-info">
                        <div className="s-title">OCR 识别语言</div>
                        <div className="s-desc">
                          {ocrLanguagesError
                            ? `无法读取系统语言包：${ocrLanguagesError}`
                            : ocrLanguages.length === 0
                              ? '系统未安装可用的 OCR 语言包'
                              : '从系统已安装的 OCR 语言中选择；未选择时按系统默认（中文优先）'}
                        </div>
                      </div>
                      <select
                        className="setting-select"
                        aria-label="OCR 识别语言"
                        value={state?.ocrLanguage ?? ''}
                        disabled={ocrLanguages.length === 0}
                        onChange={(event) => void applyOcrLanguage(event.target.value)}
                      >
                        <option value="">系统默认（中文优先）</option>
                        {ocrLanguages.map((language) => (
                          <option key={language.tag} value={language.tag}>
                            {language.displayName}（{language.tag}）
                          </option>
                        ))}
                      </select>
                    </div>
                    <div className="setting-row">
                      <div className="s-info">
                        <div className="s-title">开机自启动</div>
                        <div className="s-desc">
                          {state?.autostartSupported === false
                            ? '仅安装版支持开机自启'
                            : '系统启动时自动运行 snip-ocr（隐藏主窗）'}
                        </div>
                      </div>
                      <Switch
                        label="开机自启动"
                        checked={state?.autostart ?? false}
                        disabled={state?.autostartSupported === false}
                        onChange={(next) => {
                          void window.snip.setAutostart(next).then((result) => {
                            if (result.ok) showToast('已保存')
                            else showToast(result.error ?? '设置开机自启失败')
                          })
                        }}
                      />
                    </div>
                    <div className="update-section" data-state={updatePhase}>
                      <div className="update-summary">
                        <div className="update-info">
                          <div className="update-version">snip-ocr v{version}</div>
                          <div
                            className={updatePhase === 'error' ? 'update-status update-status--error' : 'update-status'}
                          >
                            {updateText}
                          </div>
                        </div>
                        {updateUnsupported ? (
                          <button type="button" className="update-btn" disabled>
                            检查更新
                          </button>
                        ) : updatePhase === 'downloading' ? (
                          <button
                            type="button"
                            className="update-btn"
                            onClick={() => {
                              void window.snip.cancelUpdate()
                            }}
                          >
                            取消下载
                          </button>
                        ) : updatePhase === 'downloaded' ? (
                          <button
                            type="button"
                            className="update-btn primary"
                            onClick={() => {
                              void window.snip.installUpdate().then((result) => {
                                if (!result.ok) showToast(result.error ?? '安装更新失败')
                              })
                            }}
                          >
                            立即重启安装
                          </button>
                        ) : updatePhase === 'available' ? (
                          <button
                            type="button"
                            className="update-btn primary"
                            onClick={() => {
                              setUpdateProgress(null)
                              void window.snip.downloadUpdate()
                            }}
                          >
                            下载更新
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="update-btn"
                            disabled={checking}
                            onClick={() => {
                              void window.snip.checkUpdate()
                            }}
                          >
                            {checking ? '检查中…' : '检查更新'}
                          </button>
                        )}
                      </div>
                      {updatePhase === 'downloading' ? (
                        <div
                          className="update-progress"
                          role="progressbar"
                          aria-label="更新下载进度"
                          aria-valuemin={0}
                          aria-valuemax={100}
                          aria-valuenow={progressPercent}
                        >
                          <div className="update-progress-bar" style={{ width: `${progressPercent}%` }} />
                        </div>
                      ) : null}
                      {update?.notes &&
                      (updatePhase === 'available' ||
                        updatePhase === 'downloading' ||
                        updatePhase === 'downloaded') ? (
                        <div className="update-notes">{update.notes}</div>
                      ) : null}
                      <div className="update-switches">
                        <div className="setting-row">
                          <div className="s-info">
                            <div className="s-title">自动检查更新</div>
                            <div className="s-desc">
                              {updateUnsupported
                                ? '便携版不支持在线更新，请手动下载新版本'
                                : '启动后自动检查，之后每 24 小时检查一次'}
                            </div>
                          </div>
                          <Switch
                            label="自动检查更新"
                            checked={update?.autoCheck ?? true}
                            disabled={updateUnsupported}
                            onChange={(next) => {
                              void window.snip.setUpdateOptions({ autoCheck: next })
                            }}
                          />
                        </div>
                        <div className="setting-row">
                          <div className="s-info">
                            <div className="s-title">自动下载更新包</div>
                            <div className="s-desc">发现新版本后后台下载，安装与重启仍需你确认</div>
                          </div>
                          <Switch
                            label="自动下载更新包"
                            checked={update?.autoDownload ?? true}
                            disabled={updateUnsupported}
                            onChange={(next) => {
                              void window.snip.setUpdateOptions({ autoDownload: next })
                            }}
                          />
                        </div>
                      </div>
                    </div>
                    <div className="setting-tail">
                      <button
                        type="button"
                        className="text-btn danger"
                        onClick={() => window.snip.quit()}
                      >
                        退出 snip-ocr
                      </button>
                    </div>
                  </div>
                ) : null}

                {tab === 'icons' ? (
                  <div className="pane active">
                    <div className="section-title">工具栏预览</div>
                    <div className="toolbar-preview">
                      {(Object.keys(TOOL_LABELS) as ToolKey[]).map((tool) => (
                        <span key={tool} className="preview-tool">
                          <span
                            className="preview-icon"
                            dangerouslySetInnerHTML={{
                              __html: toolIconFor(
                                state?.iconTheme ?? 'default',
                                tool,
                                state?.customIconUrl ?? null,
                              ),
                            }}
                          />
                          <span>{TOOL_LABELS[tool]}</span>
                        </span>
                      ))}
                    </div>

                    <div className="section-title">预设图标风格</div>
                    <div className="icon-grid">
                      {ICON_CARDS.map((card) => {
                        const html =
                          card.theme === 'custom' && !state?.customIconUrl
                            ? CUSTOM_UPLOAD_ICON
                            : toolIconFor(card.theme, 'ocr', state?.customIconUrl ?? null)
                        return (
                          <button
                            key={card.theme}
                            type="button"
                            className={`icon-card${state?.iconTheme === card.theme ? ' active' : ''}`}
                            onClick={() => {
                              if (card.theme === 'custom') {
                                void window.snip.pickCustomIcon().then((result) => {
                                  if (result.ok) showToast('已保存')
                                  else if (result.error !== '未选择图标') {
                                    showToast(result.error ?? '自定义图标失败')
                                  }
                                })
                                return
                              }
                              void applyTheme(card.theme)
                            }}
                          >
                            <span className="preview-box" dangerouslySetInnerHTML={{ __html: html }} />
                            <span>{card.label}</span>
                          </button>
                        )
                      })}
                    </div>
                    <p className="tip">图标会应用到截图工具栏。自定义图标支持 PNG/JPG/WebP，最大 5MB。</p>
                    <div className="row">
                      <button type="button" className="ghost-btn" onClick={() => void applyTheme('default')}>
                        恢复默认图标
                      </button>
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </section>
        ) : (
          <section className="home-view">
            <div className="capture-plate">
              <span className="plate-corner tl" aria-hidden="true" />
              <span className="plate-corner tr" aria-hidden="true" />
              <span className="plate-corner bl" aria-hidden="true" />
              <span className="plate-corner br" aria-hidden="true" />
              <div className="plate-center">
                <h1>准备好截张图了吗？</h1>
                <p className="sub">框选即用 · 本地文字识别 · 不联网</p>

                <div className="action-cluster">
                  <button
                    type="button"
                    className="capture-btn"
                    onClick={() => window.snip.startCapture()}
                  >
                    <CaptureIcon />
                    <span>立即截图</span>
                    <span className="hk">{prettyAccelerator(hotkey, platform)}</span>
                  </button>

                  <div className="right-stack">
                    <div className="secondary home-actions">
                      <button
                        type="button"
                        className="ghost-btn"
                        disabled={!state?.hasHistory}
                        title={state?.hasHistory ? '贴出截图历史里最新的一张' : '还没有截图记录，先截一张'}
                        onClick={() => window.snip.pinLast()}
                      >
                        贴最近一张 <span className="hk">{prettyAccelerator(pinHotkey, platform)}</span>
                      </button>
                      <button
                        type="button"
                        className="ghost-btn"
                        onClick={() => setHistoryOpen(true)}
                      >
                        截图历史
                      </button>
                    </div>

                    {pinCount > 0 ? (
                      <div className="home-status">
                        <span className="status-dot" />
                        <span>
                          当前贴图 <b>{pinCount}</b> 张
                        </span>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => window.snip.togglePinList()}
                        >
                          贴图列表
                        </button>
                        <button
                          type="button"
                          className="link-btn"
                          onClick={() => window.snip.closeAllPins()}
                        >
                          关闭全部
                        </button>
                      </div>
                    ) : (
                      <div className="home-status empty">
                        <span className="status-dot muted" />
                        <span>暂无贴图 · 截图时点「贴图」，图片会悬浮在屏幕上</span>
                      </div>
                    )}
                  </div>
                </div>

                {state?.hasHistory ? null : (
                  <p className="empty-hint">
                    还没有截图记录 — 按 <kbd>{prettyAccelerator(hotkey, platform)}</kbd> 截一张，完成后会自动出现在这里
                  </p>
                )}
              </div>
              <span className="plate-ruler" aria-hidden="true" />
            </div>
          </section>
        )}
      </main>

      <div className="foot-zone">
        <footer className="app-foot" tabIndex={0} aria-label="键盘速查">
          <span className="mono">
            {prettyAccelerator(hotkey, platform)} 截图 · 确定 复制 ·{' '}
            {prettyAccelerator(pinHotkey, platform)} 贴图 · Esc 取消
          </span>
        </footer>
      </div>

      {toast ? (
        <div className="toast" role="status">
          {toast}
        </div>
      ) : null}
    </div>
  )
}
