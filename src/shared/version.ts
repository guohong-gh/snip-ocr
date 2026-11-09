/** 语义化版本比较：只覆盖本项目需要的 x.y.z[-pre] 形式，非法输入返回 null */

interface ParsedVersion {
  major: number
  minor: number
  patch: number
  pre: string[]
}

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/

function parseVersion(input: string): ParsedVersion | null {
  const matched = VERSION_PATTERN.exec(input.trim())
  if (!matched) return null
  const pre = matched[4] ? matched[4].split('.') : []
  if (pre.some((part) => part.length === 0)) return null
  return {
    major: Number(matched[1]),
    minor: Number(matched[2]),
    patch: Number(matched[3]),
    pre,
  }
}

function comparePre(a: string[], b: string[]): number {
  // 正式版排在同版本号的预发布版之后
  if (a.length === 0 && b.length === 0) return 0
  if (a.length === 0) return 1
  if (b.length === 0) return -1
  const length = Math.min(a.length, b.length)
  for (let i = 0; i < length; i += 1) {
    const left = a[i]
    const right = b[i]
    const leftNumeric = /^\d+$/.test(left)
    const rightNumeric = /^\d+$/.test(right)
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right)
      if (diff !== 0) return diff < 0 ? -1 : 1
    } else if (leftNumeric !== rightNumeric) {
      // 数字标识符优先级低于字母标识符（semver 2.0）
      return leftNumeric ? -1 : 1
    } else if (left !== right) {
      return left < right ? -1 : 1
    }
  }
  if (a.length === b.length) return 0
  return a.length < b.length ? -1 : 1
}

/**
 * 比较两个版本号：a > b 返回 1，a < b 返回 -1，相等返回 0；
 * 任一版本号不合法返回 null。
 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a)
  const right = parseVersion(b)
  if (!left || !right) return null
  for (const key of ['major', 'minor', 'patch'] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1
  }
  return comparePre(left.pre, right.pre)
}
