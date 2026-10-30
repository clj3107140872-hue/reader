import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties } from 'react'
import type { AppSettings, BookMeta, Bookmark, BookProgress } from '../../../core/model'
import type { OpenBookPayload } from '../../../shared/api'
import type { SettingsPatch } from '../../../shared/settings'
import BookmarksPanel from '../components/BookmarksPanel'
import ProgressBar from '../components/ProgressBar'
import SearchPanel from '../components/SearchPanel'
import SettingsPanel from '../components/SettingsPanel'
import TocDrawer from '../components/TocDrawer'
import {
  chapterIndexForPercent,
  charsBefore,
  percentAt,
  resolveChapterIndex,
  totalChars
} from '../reader/position'

interface ReaderProps {
  bookId: string
  settings: AppSettings
  onSettingsChange: (patch: SettingsPatch) => void
  onBack: () => void
}

interface ChapterView {
  meta: BookMeta['chapters'][number]
  paragraphs: string[]
}

interface CurrentPosition {
  chapterIndex: number
  paragraphIndex: number
  percent: number
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

const ReaderBody = memo(function ReaderBody({ chapters }: { chapters: ChapterView[] }) {
  return (
    <article className="reader-page">
      {chapters.map((chapter, chapterIndex) => (
        <section
          key={chapter.meta.index}
          className={`reader-chapter ${chapter.meta.level}`}
          data-chapter-section={chapterIndex}
        >
          <h2 className="chapter-title">{chapter.meta.title}</h2>
          {chapter.paragraphs.map((text, paragraphIndex) => (
            <p
              key={paragraphIndex}
              className="reader-paragraph"
              data-chapter-index={chapterIndex}
              data-paragraph-index={paragraphIndex}
            >
              {text}
            </p>
          ))}
        </section>
      ))}
    </article>
  )
})

export default function Reader({ bookId, settings, onSettingsChange, onBack }: ReaderProps) {
  const [book, setBook] = useState<OpenBookPayload | null>(null)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<'toc' | 'search' | 'bookmarks' | 'settings' | null>(null)
  const [current, setCurrent] = useState<CurrentPosition>({ chapterIndex: 0, paragraphIndex: 0, percent: 0 })
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [notice, setNotice] = useState('')
  const scrollRef = useRef<HTMLElement | null>(null)
  const restoredRef = useRef(false)
  const rafRef = useRef(0)
  const pendingRef = useRef<BookProgress | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    setBook(null)
    setError('')
    restoredRef.current = false
    window.api
      .openBook(bookId)
      .then((payload) => {
        if (alive) {
          setBook(payload)
          setBookmarks(payload.bookmarks)
        }
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [bookId])

  useEffect(() => {
    if (!notice) return
    const timer = window.setTimeout(() => setNotice(''), 1600)
    return () => window.clearTimeout(timer)
  }, [notice])

  const chapters = useMemo<ChapterView[]>(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => ({
      meta,
      paragraphs: splitParagraphs(book.chapters[index] ?? '')
    }))
  }, [book])

  const paragraphs = useMemo(() => chapters.map((chapter) => chapter.paragraphs), [chapters])

  const flush = useCallback((): void => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current)
      timerRef.current = null
    }
    const pending = pendingRef.current
    pendingRef.current = null
    if (pending) void window.api.saveProgress(bookId, pending).catch(() => undefined)
  }, [bookId])

  const scheduleSave = useCallback(
    (position: CurrentPosition): void => {
      if (!book) return
      pendingRef.current = {
        chapterKey: book.meta.chapters[position.chapterIndex]?.titleHash ?? '',
        chapterIndex: position.chapterIndex,
        paragraphIndex: position.paragraphIndex,
        percent: position.percent,
        updatedAt: new Date().toISOString()
      }
      if (timerRef.current !== null) window.clearTimeout(timerRef.current)
      timerRef.current = window.setTimeout(flush, 500)
    },
    [book, flush]
  )

  const scrollToPosition = useCallback((chapterIndex: number, paragraphIndex: number): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    const paragraph = scroller.querySelector<HTMLElement>(
      `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
    )
    if (paragraph) {
      paragraph.scrollIntoView({ block: 'start' })
      return
    }
    const section = scroller.querySelector<HTMLElement>(`[data-chapter-section="${chapterIndex}"]`)
    section?.scrollIntoView({ block: 'start' })
  }, [])

  const currentPosition = useCallback((): { chapterIndex: number; paragraphIndex: number } | null => {
    const scroller = scrollRef.current
    if (!scroller) return null
    const rect = scroller.getBoundingClientRect()
    const x = rect.left + rect.width / 2
    const y = rect.top + 88

    for (const element of document.elementsFromPoint(x, y)) {
      const paragraph = element.closest<HTMLElement>('[data-paragraph-index]')
      if (paragraph) {
        return {
          chapterIndex: Number(paragraph.dataset.chapterIndex),
          paragraphIndex: Number(paragraph.dataset.paragraphIndex)
        }
      }
      const section = element.closest<HTMLElement>('[data-chapter-section]')
      if (section) {
        return { chapterIndex: Number(section.dataset.chapterSection), paragraphIndex: 0 }
      }
    }

    const sections = scroller.querySelectorAll<HTMLElement>('[data-chapter-section]')
    let nearest = 0
    sections.forEach((section, index) => {
      if (section.getBoundingClientRect().top <= y) nearest = index
    })
    return { chapterIndex: nearest, paragraphIndex: 0 }
  }, [])

  const handleScroll = useCallback((): void => {
    if (rafRef.current !== 0) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      if (!book) return
      const position = currentPosition()
      if (!position) return
      const percent = percentAt(book.meta, position.chapterIndex, position.paragraphIndex, paragraphs)
      const next = { ...position, percent }
      setCurrent(next)
      scheduleSave(next)
    })
  }, [book, currentPosition, paragraphs, scheduleSave])

  useEffect(() => {
    if (!book || chapters.length === 0 || restoredRef.current) return
    restoredRef.current = true
    const saved = book.progress
    const chapterIndex = saved
      ? resolveChapterIndex(book.meta, saved.chapterKey, saved.chapterIndex)
      : 0
    const paragraphIndex = saved?.paragraphIndex ?? 0
    const percent = percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
    const next = { chapterIndex, paragraphIndex, percent }
    setCurrent(next)
    scheduleSave(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => scrollToPosition(chapterIndex, paragraphIndex))
    })
  }, [book, chapters.length, paragraphs, scheduleSave, scrollToPosition])

  useEffect(() => {
    return () => flush()
  }, [flush])

  const seek = (percent: number): void => {
    if (!book) return
    const chapterIndex = chapterIndexForPercent(book.meta, percent)
    const next = { chapterIndex, paragraphIndex: 0, percent }
    setCurrent(next)
    scheduleSave(next)
    scrollToPosition(chapterIndex, 0)
  }

  const jumpToChapter = useCallback(
    (chapterIndex: number): void => {
      if (!book) return
      const index = Math.min(Math.max(chapterIndex, 0), book.meta.chapters.length - 1)
      const position = { chapterIndex: index, paragraphIndex: 0, percent: 0 }
      const percent = percentAt(book.meta, index, 0, paragraphs)
      const next = { ...position, percent }
      setCurrent(next)
      scheduleSave(next)
      scrollToPosition(index, 0)
      setDrawer(null)
    },
    [book, paragraphs, scheduleSave, scrollToPosition]
  )

  const jumpToPosition = useCallback(
    (chapterIndex: number, paragraphIndex: number): void => {
      if (!book) return
      const index = Math.min(Math.max(chapterIndex, 0), book.meta.chapters.length - 1)
      const percent = percentAt(book.meta, index, paragraphIndex, paragraphs)
      const next = { chapterIndex: index, paragraphIndex, percent }
      setCurrent(next)
      scheduleSave(next)
      scrollToPosition(index, paragraphIndex)
      const target = scrollRef.current?.querySelector<HTMLElement>(
        `[data-chapter-index="${index}"][data-paragraph-index="${paragraphIndex}"]`
      )
      if (target) {
        target.classList.add('search-flash')
        window.setTimeout(() => target.classList.remove('search-flash'), 2000)
      }
    },
    [book, paragraphs, scheduleSave, scrollToPosition]
  )

  const toggleBookmark = useCallback((): void => {
    if (!book) return
    const chapterIndex = current.chapterIndex
    const paragraphIndex = current.paragraphIndex
    const chapter = book.meta.chapters[chapterIndex]
    if (!chapter) return
    const existing = bookmarks.find(
      (bookmark) =>
        bookmark.chapterKey === chapter.titleHash && bookmark.paragraphIndex === paragraphIndex
    )

    if (existing) {
      void window.api
        .removeBookmark(bookId, existing.id)
        .then((next) => {
          setBookmarks(next)
          setNotice('已取消书签')
        })
        .catch((reason: unknown) => setNotice(`操作失败：${String(reason)}`))
      return
    }

    const element = scrollRef.current?.querySelector<HTMLElement>(
      `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
    )
    const excerpt = (element?.textContent ?? '').trim().slice(0, 60)
    void window.api
      .addBookmark(bookId, {
        chapterKey: chapter.titleHash,
        chapterIndex,
        paragraphIndex,
        excerpt
      })
      .then((next) => {
        setBookmarks(next)
        setNotice('已添加书签')
      })
      .catch((reason: unknown) => setNotice(`操作失败：${String(reason)}`))
  }, [book, bookId, bookmarks, current])

  const deleteBookmark = useCallback(
    (bookmarkId: string): void => {
      void window.api
        .removeBookmark(bookId, bookmarkId)
        .then(setBookmarks)
        .catch((reason: unknown) => setNotice(`删除失败：${String(reason)}`))
    },
    [bookId]
  )

  const readerStyle = {
    '--reader-font-family': settings.typography.fontFamily,
    '--reader-font-size': `${settings.typography.fontSize}px`,
    '--reader-line-height': String(settings.typography.lineHeight),
    '--reader-paragraph-spacing': `${settings.typography.paragraphSpacing}em`,
    '--reader-page-padding': `${settings.typography.pagePadding}px`,
    '--reader-max-width':
      settings.typography.maxContentWidth === null ? 'none' : `${settings.typography.maxContentWidth}px`
  } as CSSProperties

  if (error) {
    return (
      <div className="reader-error">
        <p>这本书打不开了：{error}</p>
        <button onClick={onBack}>返回书架</button>
      </div>
    )
  }

  if (!book) {
    return <p className="loading">正在打开…</p>
  }

  const total = totalChars(book.meta)
  const read = charsBefore(book.meta, current.chapterIndex, current.paragraphIndex, paragraphs)
  const remainingMinutes = Math.max(0, Math.ceil((total - read) / 400))

  return (
    <div className="reader" data-theme={settings.theme} style={readerStyle}>
      <header className="reader-toolbar">
        <button className="ghost" onClick={onBack}>
          ← 书架
        </button>
        <span className="reader-title" title={book.meta.title}>
          {book.meta.title}
        </span>
        <span className="toolbar-spacer" />
        <button className="ghost" onClick={() => setDrawer('toc')}>
          目录
        </button>
        <button className="ghost" onClick={() => setDrawer('search')}>
          搜索
        </button>
        <button className="ghost" onClick={() => setDrawer('bookmarks')}>
          书签{bookmarks.length > 0 ? ` ${bookmarks.length}` : ''}
        </button>
        <button className="ghost" onClick={() => setDrawer('settings')}>
          排版
        </button>
      </header>

      <main className="reader-scroll" ref={scrollRef} onScroll={handleScroll}>
        <ReaderBody chapters={chapters} />
      </main>

      <ProgressBar
        percent={current.percent}
        chapterIndex={current.chapterIndex}
        chapterCount={book.meta.chapters.length}
        remainingMinutes={remainingMinutes}
        onSeek={seek}
      />

      {drawer === 'toc' && (
        <TocDrawer
          chapters={book.meta.chapters}
          currentIndex={current.chapterIndex}
          onSelect={jumpToChapter}
          onClose={() => setDrawer(null)}
        />
      )}

      {drawer === 'search' && (
        <SearchPanel
          bookId={bookId}
          chapters={book.meta.chapters}
          onJump={jumpToPosition}
          onClose={() => setDrawer(null)}
        />
      )}

      {drawer === 'settings' && (
        <SettingsPanel
          settings={settings}
          onChange={onSettingsChange}
          onClose={() => setDrawer(null)}
        />
      )}

      {drawer === 'bookmarks' && (
        <BookmarksPanel
          bookmarks={bookmarks}
          chapters={book.meta.chapters}
          onJump={jumpToPosition}
          onDelete={deleteBookmark}
          onClose={() => setDrawer(null)}
        />
      )}

      {notice && <div className="reader-notice">{notice}</div>}
    </div>
  )
}
