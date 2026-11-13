/** 更新失败的用户向文案：界面只显示一句原因 + 一条下一步，原始错误留在日志与状态里 */
export interface UpdateErrorText {
  reason: string
  hint: string
}

interface ErrorRule {
  test: RegExp
  reason: string
  hint: string
}

// 顺序敏感：先匹配具体网络/发布页错误，最后才是兜底
const RULES: ErrorRule[] = [
  {
    test: /latest\.yml/i,
    reason: '发布页缺少 latest.yml 清单',
    hint: '多为 Release 尚未上传完成，稍后重试',
  },
  {
    test: /enotfound|getaddrinfo|dns/i,
    reason: '无法解析更新服务器地址',
    hint: '检查网络连接，或更换 DNS 后重试',
  },
  {
    test: /etimedout|timed out|timeout/i,
    reason: '连接更新服务器超时',
    hint: '确认网络可用；使用代理时请确认代理已开启后重试',
  },
  {
    test: /econnreset|connection was reset|socket hang up|econnaborted/i,
    reason: '与更新服务器的连接被重置',
    hint: '关闭或切换代理、VPN 后重试；网络不稳定时稍后再试',
  },
  {
    test: /cert|tls|ssl|unable to verify|self[- ]signed/i,
    reason: 'HTTPS 证书校验失败',
    hint: '检查系统时间是否准确；代理软件可能替换了证书，关闭后重试',
  },
  {
    test: /404|not found|no published versions|no releases?/i,
    reason: '未找到可用的发布版本',
    hint: '确认仓库已有对应 Release，稍后重试',
  },
  {
    test: /sha512|checksum|integrity/i,
    reason: '下载的安装包校验失败',
    hint: '删除已下载的临时文件后重新检查更新',
  },
  {
    test: /eacces|eperm|permission denied|access is denied/i,
    reason: '没有写入权限',
    hint: '换一个可写目录，或重新安装后再试',
  },
  {
    test: /app-update\.yml|code signature|not signed/i,
    reason: '更新配置缺失或签名校验未通过',
    hint: '请从发布页手动下载并安装最新版本',
  },
]

/** 把原始错误归一到用户能看懂的一句话；未命中规则时截断原文兜底 */
export function classifyUpdateError(raw: string | null | undefined): UpdateErrorText {
  const text = (raw ?? '').trim()
  if (!text) return { reason: '未知错误', hint: '可稍后重试；若反复失败请把日志反馈给开发者' }
  for (const rule of RULES) {
    if (rule.test.test(text)) return { reason: rule.reason, hint: rule.hint }
  }
  const compact = text.replace(/\s+/g, ' ')
  return {
    reason: compact.length > 100 ? `${compact.slice(0, 100)}…` : compact,
    hint: '可稍后重试；若反复失败请把日志反馈给开发者',
  }
}
