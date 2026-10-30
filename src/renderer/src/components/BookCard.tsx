import type { LibraryEntry } from '../../../core/model'

interface BookCardProps {
  entry: LibraryEntry
  onOpen: () => void
  onMenu: (entry: LibraryEntry, x: number, y: number) => void
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function BookCard({ entry, onOpen, onMenu }: BookCardProps) {
  return (
    <article
      className="card"
      onContextMenu={(event) => {
        event.preventDefault()
        onMenu(entry, event.clientX, event.clientY)
      }}
    >
      <button className="card-open" onClick={onOpen}>
        <div className="cover">{coverInitial(entry.title)}</div>
        <div className="meta">
          <div className="title" title={entry.title}>
            {entry.title}
          </div>
          <div className="sub">
            {entry.chapterCount} 章 · {entry.encoding}
          </div>
          <div className="sub">
            进度 {entry.progressPercent}% · 广告 {entry.stats.adLinesRemoved} 行 · 重复段{' '}
            {entry.stats.duplicateParagraphsMerged}
          </div>
          {entry.stats.suspectedDuplicateChapters > 0 && (
            <div className="sub warn">疑似重复章节 {entry.stats.suspectedDuplicateChapters}</div>
          )}
        </div>
      </button>
      <button
        className="card-more"
        aria-label={`管理《${entry.title}》`}
        onClick={(event) => {
          event.stopPropagation()
          const rect = event.currentTarget.getBoundingClientRect()
          onMenu(entry, rect.right, rect.bottom)
        }}
      >
        ⋯
      </button>
    </article>
  )
}
