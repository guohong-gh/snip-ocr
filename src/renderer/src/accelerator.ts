const MODIFIER_KEYS = new Set(['Control', 'Alt', 'Shift', 'Meta', 'OS'])

const NAMED_KEYS: Record<string, string> = {
  Escape: 'Esc',
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Delete: 'Delete',
  Insert: 'Insert',
  Tab: 'Tab',
  Backspace: 'Backspace',
  Enter: 'Return',
}

const FUNCTION_KEY = /^F([1-9]|1[0-2])$/i

function baseToken(key: string): string | null {
  const named = NAMED_KEYS[key]
  if (named) return named
  if (FUNCTION_KEY.test(key)) return key.toUpperCase()
  if (key.length === 1) return key.toUpperCase()
  return null
}

/** 把一次 keydown 组装成 Electron accelerator；只按修饰键时返回 null（继续等待） */
export function toAccelerator(event: KeyboardEvent): string | null {
  if (MODIFIER_KEYS.has(event.key)) return null
  const base = baseToken(event.key)
  if (!base) return null
  const mods = [
    event.ctrlKey ? 'Ctrl' : null,
    event.altKey ? 'Alt' : null,
    event.metaKey ? 'Super' : null,
    event.shiftKey ? 'Shift' : null,
  ].filter((mod): mod is string => mod !== null)
  // 功能键允许单独使用，其余必须有修饰键，避免劫持日常输入
  if (mods.length === 0 && !FUNCTION_KEY.test(base)) return null
  return [...mods, base].join('+')
}

/** 面向用户的展示名 */
export function prettyAccelerator(accelerator: string, platform: string): string {
  return accelerator
    .split('+')
    .map((part) => (part === 'Super' ? (platform === 'darwin' ? 'Cmd' : 'Win') : part))
    .join(' + ')
}
