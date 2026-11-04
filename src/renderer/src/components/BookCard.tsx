import { useRef } from 'react'
import type { LibraryEntry } from '../../../core/model'
import { useBookCover } from '../hooks/useBookCover'

interface BookCardProps {
  entry: LibraryEntry
  onOpen: () => void
  onMenu: (entry: LibraryEntry, x: number, y: number) => void
  onHoverStart: (entry: LibraryEntry, rect: DOMRect) => void
  onHoverEnd: () => void
  selectable?: boolean
  selected?: boolean
  onToggle?: () => void
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function BookCard({
  entry,
  onOpen,
  onMenu,
  onHoverStart,
  onHoverEnd,
  selectable = false,
  selected = false,
  onToggle
}: BookCardProps) {
  const cardRef = useRef<HTMLElement>(null)
  const cover = useBookCover(entry.hasCover ? entry.id : null)

  const hoverStart = (): void => {
    if (selectable) return
    const rect = cardRef.current?.getBoundingClientRect()
    if (rect) onHoverStart(entry, rect)
  }

  return (
    <article
      ref={cardRef}
      className={`card${selectable ? ' selectable' : ''}${selected ? ' selected' : ''}`}
      onMouseEnter={hoverStart}
      onMouseLeave={onHoverEnd}
      onFocus={hoverStart}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onHoverEnd()
      }}
      onContextMenu={(event) => {
        event.preventDefault()
        if (selectable) return
        onMenu(entry, event.clientX, event.clientY)
      }}
    >
      {selectable && (
        <span className="card-check" aria-hidden="true">
          {selected ? '✓' : ''}
        </span>
      )}
      <button
        className="card-open"
        onClick={selectable ? onToggle : onOpen}
        aria-pressed={selectable ? selected : undefined}
      >
        <div className="cover">
          {cover ? <img src={cover} alt="" /> : coverInitial(entry.title)}
        </div>
        <div className="meta">
          <div className="title" title={selectable ? entry.title : undefined}>
            {entry.title}
          </div>
          <div className="sub">
            {entry.format === 'epub' ? 'EPUB' : 'TXT'} · {entry.chapterCount} 章
            {entry.format === 'epub' ? '' : ` · ${entry.encoding}`}
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
      {!selectable && (
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
      )}
    </article>
  )
}
