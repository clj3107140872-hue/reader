import type { LibraryEntry } from '../../../core/model'

export default function NetworkBookBadge({
  entry,
  sourceMissing = false,
  progress
}: {
  entry: LibraryEntry
  sourceMissing?: boolean
  progress?: { done: number; total: number }
}) {
  if (entry.format !== 'network') return null
  const cached = progress ? progress.done : (entry.networkCache?.cached ?? 0)
  const total = progress ? progress.total : (entry.networkCache?.total ?? 0)
  const source = sourceMissing ? '书源已删除' : entry.sourceName || '未知书源'
  const state = progress
    ? '下载中'
    : entry.downloadState === 'complete'
      ? '已下载全本'
      : entry.downloadState === 'partial'
        ? '未下载完'
        : '未下载'
  return (
    <span className={`network-badge ${sourceMissing ? 'missing' : ''}`}>
      <span className="network-badge-source">网络 · {source}</span>
      {total > 0 && (
        <span className="network-badge-cache">
          {cached}/{total}
        </span>
      )}
      <span className="network-badge-state">{state}</span>
    </span>
  )
}
