import type { LibraryEntry } from '../../../core/model'

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

export default function BookInfo({ entry }: { entry: LibraryEntry }) {
  const progress = entry.lastReadAt
    ? `${entry.progressPercent}% · 最近 ${formatTime(entry.lastReadAt)}`
    : '未阅读'
  return (
    <dl className="info-list">
      <dt>书名</dt>
      <dd>{entry.title}</dd>
      <dt>源文件</dt>
      <dd>{(entry.sourceFileNames ?? [entry.sourceFileName]).join('、')}</dd>
      <dt>章节</dt>
      <dd>{entry.chapterCount} 章</dd>
      <dt>编码</dt>
      <dd>{entry.encoding}</dd>
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
