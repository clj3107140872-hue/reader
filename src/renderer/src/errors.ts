const KNOWN_MESSAGES = [
  '无效的书籍编号',
  '找不到',
  '不能把一本书合并到它自己',
  '书籍数据缺失',
  '没有识别到至少 3 个章节标题',
  '重新清洗后没有可阅读的正文'
]

/**
 * Strip Electron's IPC wrapper and show only messages the app itself wrote.
 * Raw filesystem errors are replaced so users never see ENOENT/EACCES codes.
 */
export function errorText(reason: unknown): string {
  const message = (reason instanceof Error ? reason.message : String(reason)).replace(
    /^Error invoking remote method '[^']+': (?:Error: )?/,
    ''
  )
  return KNOWN_MESSAGES.some((known) => message.includes(known))
    ? message
    : '操作失败，请稍后重试'
}
