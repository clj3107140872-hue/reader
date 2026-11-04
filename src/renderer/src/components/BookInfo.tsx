import type { LibraryEntry } from '../../../core/model'

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

export default function BookInfo({
  entry,
  compact = false
}: {
  entry: LibraryEntry
  compact?: boolean
}) {
  const progress = entry.lastReadAt
    ? `${entry.progressPercent}% · 最近 ${formatTime(entry.lastReadAt)}`
    : '未阅读'
  const files = entry.sourceFileNames ?? [entry.sourceFileName]
  const fileText =
    compact && files.length > 3
      ? `${files.slice(0, 3).join('、')} 等 ${files.length} 个文件`
      : files.join('、')
  const epub = entry.format === 'epub'
  return (
    <dl className="info-list">
      <dt>书名</dt>
      <dd>{entry.title}</dd>
      {entry.author && (
        <>
          <dt>作者</dt>
          <dd>{entry.author}</dd>
        </>
      )}
      <dt>源文件</dt>
      <dd>{fileText}</dd>
      <dt>格式</dt>
      <dd>{epub ? 'EPUB' : 'TXT'}</dd>
      <dt>章节</dt>
      <dd>{entry.chapterCount} 章</dd>
      {!epub && (
        <>
          <dt>编码</dt>
          <dd>{entry.encoding}</dd>
        </>
      )}
      <dt>阅读</dt>
      <dd>{progress}</dd>
      <dt>清洗</dt>
      <dd>
        广告 {entry.stats.adLinesRemoved} 行 · 重复段 {entry.stats.duplicateParagraphsMerged} 处
      </dd>
      {entry.stats.suspectedDuplicateChapters > 0 && (
        <>
          <dt>提示</dt>
          <dd>疑似重复章节 {entry.stats.suspectedDuplicateChapters}</dd>
        </>
      )}
      <dt>导入</dt>
      <dd>{formatTime(entry.importedAt)}</dd>
    </dl>
  )
}
