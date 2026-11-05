import { useLayoutEffect, useRef, useState } from 'react'
import type { ChapterMeta } from '../../../core/model'

interface TocDrawerProps {
  chapters: ChapterMeta[]
  currentIndex: number
  onSelect: (chapterIndex: number) => void
  onClose: () => void
}

export default function TocDrawer({ chapters, currentIndex, onSelect, onClose }: TocDrawerProps) {
  const [filter, setFilter] = useState('')
  const drawerRef = useRef<HTMLElement | null>(null)
  // Open the TOC around the chapter being read instead of at the first page,
  // so a long book does not require scrolling hundreds of rows every time.
  useLayoutEffect(() => {
    const drawer = drawerRef.current
    const item = drawer?.querySelector<HTMLElement>('.toc-item.current')
    if (!drawer || !item) return
    drawer.scrollTop = item.offsetTop - (drawer.clientHeight - item.offsetHeight) / 2
  }, [])
  const keyword = filter.trim().toLowerCase()
  const visible = chapters
    .map((chapter, index) => ({ chapter, index }))
    .filter(({ chapter }) => !keyword || chapter.title.toLowerCase().includes(keyword))

  return (
    <aside className="reader-drawer left toc-drawer" ref={drawerRef}>
      <header className="drawer-header">
        <h2>目录</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭目录">
          ×
        </button>
      </header>

      <div className="toc-filter">
        <input
          type="search"
          value={filter}
          placeholder="搜索章节标题"
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      <ol className="toc-list">
        {visible.map(({ chapter, index }) => (
          <li key={chapter.index}>
            <button
              className={`toc-item ${chapter.level} ${index === currentIndex ? 'current' : ''}`}
              onClick={() => onSelect(index)}
            >
              <span className="toc-title">{chapter.title}</span>
              {chapter.flags.suspectedDuplicate && <span className="toc-badge">重复?</span>}
            </button>
          </li>
        ))}
      </ol>

      {visible.length === 0 && <p className="toc-empty">没有匹配的章节</p>}
    </aside>
  )
}
