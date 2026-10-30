import type { Bookmark, ChapterMeta } from '../../../core/model'

interface BookmarksPanelProps {
  bookmarks: Bookmark[]
  chapters: ChapterMeta[]
  onJump: (chapterIndex: number, paragraphIndex: number) => void
  onDelete: (bookmarkId: string) => void
  onClose: () => void
}

export default function BookmarksPanel({
  bookmarks,
  chapters,
  onJump,
  onDelete,
  onClose
}: BookmarksPanelProps) {
  return (
    <aside className="reader-drawer right bookmarks-panel">
      <header className="drawer-header">
        <h2>书签</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭书签">
          ×
        </button>
      </header>

      {bookmarks.length === 0 ? (
        <p className="bookmarks-empty">还没有书签。阅读时按 Ctrl+B 记住当前段落。</p>
      ) : (
        <ul className="bookmark-list">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id} className="bookmark-item">
              <button
                className="bookmark-main"
                onClick={() => {
                  onJump(bookmark.chapterIndex, bookmark.paragraphIndex)
                  onClose()
                }}
              >
                <span className="bookmark-chapter">
                  {chapters[bookmark.chapterIndex]?.title ?? '未知章节'}
                </span>
                <span className="bookmark-excerpt">{bookmark.excerpt || '（空段落）'}</span>
              </button>
              <button
                className="bookmark-delete"
                aria-label="删除书签"
                onClick={() => onDelete(bookmark.id)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  )
}
