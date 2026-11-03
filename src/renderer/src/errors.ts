const KNOWN_MESSAGES = [
  '无效的书籍编号',
  '无效的备份编号',
  '找不到这本书，可能已被删除',
  '找不到要合并到的书，可能已被删除',
  '找不到要合并的书，可能已被删除',
  '找不到这个备份，可能已被删除',
  '备份数据不完整，无法恢复',
  '合并前的源书已存在，无法恢复',
  '不能把一本书合并到它自己',
  '没有识别到至少 3 个章节标题',
  '重新清洗后没有可阅读的正文',
  '清洗规则格式不正确',
  '规则名称不能为空',
  '规则名称过长',
  '规则内容不能为空',
  '规则内容过长',
  '正则无效',
  '规则类型不正确',
  '规则数量过多',
  '规则编号重复',
  '自定义规则编号与内置规则冲突',
  '无效的章节编号'
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
  if (message.includes('书籍数据缺失')) return '书籍数据缺失'
  return KNOWN_MESSAGES.some((known) => message.includes(known))
    ? message
    : '操作失败，请稍后重试'
}
