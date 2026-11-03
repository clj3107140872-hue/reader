import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AppSettings,
  BookMeta,
  Bookmark,
  BookProgress,
  DisguiseStyle,
  ThemeName
} from '../../../core/model'
import { splitParagraphs } from '../../../core/paragraphs'
import type { OpenBookPayload, WindowResizeEdge } from '../../../shared/api'
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../../shared/settings'
import type { SettingsPatch } from '../../../shared/settings'
import BookmarksPanel from '../components/BookmarksPanel'
import ProgressBar from '../components/ProgressBar'
import SearchPanel from '../components/SearchPanel'
import SettingsPanel from '../components/SettingsPanel'
import TocDrawer from '../components/TocDrawer'
import {
  charsBefore,
  nearestIndexByTop,
  percentAt,
  positionForPercent,
  resolveChapterIndex,
  totalChars
} from '../reader/position'

interface ReaderProps {
  bookId: string
  settings: AppSettings
  /** Effective palette after applying the day/night/system mode. */
  theme: ThemeName
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

/**
 * Chromium turns one wheel notch into 100px of scrolling. At the default
 * typography that is about three lines, so the reader scales it down to keep
 * a notch close to two lines.
 */
const WHEEL_DISTANCE_SCALE = 0.64

/** Nearest paragraph inside a chapter section, measured against the probe line. */
function positionInSection(
  section: HTMLElement,
  y: number
): { chapterIndex: number; paragraphIndex: number } {
  const chapterIndex = Number(section.dataset.chapterSection)
  const paragraphElements = Array.from(
    section.querySelectorAll<HTMLElement>('[data-paragraph-index]')
  )
  if (paragraphElements.length === 0) return { chapterIndex, paragraphIndex: 0 }
  const tops = paragraphElements.map((element) => element.getBoundingClientRect().top)
  const paragraph = paragraphElements[nearestIndexByTop(tops, y)]
  return { chapterIndex, paragraphIndex: Number(paragraph.dataset.paragraphIndex) }
}

const DISGUISE_TITLES: Record<Exclude<DisguiseStyle, 'none'>, string> = {
  notepad: '工作文档.txt - 记事本',
  transparent: '工作文档.txt - 记事本',
  code: 'codenovel.js - Visual Studio Code'
}

const NOTEPAD_MENUS = ['文件', '编辑', '格式', '查看', '帮助'] as const

const RESIZE_EDGES: WindowResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const CODE_COLUMN_KEY = 'reader.codeColumnWidth'
const CODE_COLUMN_MIN = 160
/** 58px gutter, 8px drag handle and the 8px gap before the window edge. */
const CODE_COLUMN_CHROME = 74

function readCodeColumnWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(CODE_COLUMN_KEY)
    const parsed = raw === null ? Number.NaN : Number(raw)
    return Number.isFinite(parsed) && parsed >= CODE_COLUMN_MIN ? Math.round(parsed) : null
  } catch {
    return null
  }
}

/** Invisible edge strips that resize frameless disguise windows over IPC. */
function WindowResizeHandles() {
  return (
    <>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`window-resize window-resize-${edge}`}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            window.api.windowResizeStart(edge, event.screenX, event.screenY)
          }}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            window.api.windowResizeMove(event.screenX, event.screenY)
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            window.api.windowResizeEnd()
          }}
          onPointerCancel={() => window.api.windowResizeEnd()}
        />
      ))}
    </>
  )
}

type CodeTokenKind = 'kw' | 'str' | 'fn' | 'comment' | 'num'

interface CodeToken {
  text: string
  kind?: CodeTokenKind
}

/** Colours keywords, strings, comments, numbers and calls like an editor. */
const CODE_TOKEN_PATTERN =
  /(\/\/.*$|'[^']*'|"[^"]*"|\b\d+\b|\b(?:import|from|const|new|export|function|return|true|false)\b|\b[A-Za-z_$][\w$]*(?=\())/g

function highlightCode(line: string): CodeToken[] {
  const tokens: CodeToken[] = []
  let lastIndex = 0
  for (const match of line.matchAll(CODE_TOKEN_PATTERN)) {
    const index = match.index ?? 0
    if (index > lastIndex) tokens.push({ text: line.slice(lastIndex, index) })
    const text = match[0]
    let kind: CodeTokenKind
    if (text.startsWith('//')) kind = 'comment'
    else if (/^['"]/.test(text)) kind = 'str'
    else if (/^\d/.test(text)) kind = 'num'
    else if (/^(import|from|const|new|export|function|return|true|false)$/.test(text)) kind = 'kw'
    else kind = 'fn'
    tokens.push({ text, kind })
    lastIndex = index + text.length
  }
  if (lastIndex < line.length) tokens.push({ text: line.slice(lastIndex) })
  return tokens
}

/** Decorative code that stays put above and below the scrolling comments. */
const CODE_TOP = [
  "import { Novel } from './novel'",
  '',
  'const chapter = new Novel({',
  "  title: '工作文档',",
  "  mode: 'reading',",
  '  autoSave: true',
  '})',
  ''
]

const CODE_BOTTOM = [
  '',
  'export function readChapter() {',
  '  return chapter.next()',
  '}',
  '',
  '// TODO: keep reading'
]

/** The bottom block pretends the file has scrolled much further down. */
const CODE_BOTTOM_START = 412

const COMMENT_LINE_NUMBERS = Array.from({ length: 80 }, (_, index) => 9 + index)

interface CodeRowsProps {
  lines: string[]
  start: number
}

function CodeRows({ lines, start }: CodeRowsProps) {
  return (
    <div className="vscode-code" aria-hidden="true">
      {lines.map((line, index) => (
        <div className="vscode-code-row" key={index}>
          <span className="vscode-line-number">{start + index}</span>
          <span className="vscode-code-text">
            {line.length === 0
              ? ' '
              : highlightCode(line).map((token, tokenIndex) => (
                  <span
                    key={tokenIndex}
                    className={token.kind ? `tok-${token.kind}` : undefined}
                  >
                    {token.text}
                  </span>
                ))}
          </span>
        </div>
      ))}
    </div>
  )
}

interface NotepadMenubarProps {
  fileMenuOpen: boolean
  onToggleFileMenu: () => void
  onCloseFileMenu: () => void
  onExitDisguise: () => void
}

/** Fake Notepad menu bar; the items are decorative except 文件 → 退出. */
function NotepadMenubar({
  fileMenuOpen,
  onToggleFileMenu,
  onCloseFileMenu,
  onExitDisguise
}: NotepadMenubarProps) {
  return (
    <nav className="notepad-menubar" onMouseLeave={onCloseFileMenu}>
      <div className="notepad-menu-wrap">
        <button
          className={`notepad-menu ${fileMenuOpen ? 'open' : ''}`}
          onClick={onToggleFileMenu}
        >
          文件
        </button>
        {fileMenuOpen && (
          <div className="notepad-dropdown" role="menu">
            <button className="notepad-item" disabled>
              新建<span>Ctrl+N</span>
            </button>
            <button className="notepad-item" disabled>
              打开…<span>Ctrl+O</span>
            </button>
            <button className="notepad-item" disabled>
              保存<span>Ctrl+S</span>
            </button>
            <button className="notepad-item" disabled>
              另存为…<span>Ctrl+Shift+S</span>
            </button>
            <div className="notepad-separator" />
            <button className="notepad-item" onClick={onExitDisguise}>
              退出<span>Esc</span>
            </button>
          </div>
        )}
      </div>
      {NOTEPAD_MENUS.slice(1).map((label) => (
        <button key={label} className="notepad-menu" onClick={onCloseFileMenu}>
          {label}
        </button>
      ))}
    </nav>
  )
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

export default function Reader({
  bookId,
  settings,
  theme,
  onSettingsChange,
  onBack
}: ReaderProps) {
  const [book, setBook] = useState<OpenBookPayload | null>(null)
  const [error, setError] = useState('')
  const [drawer, setDrawer] = useState<'toc' | 'search' | 'bookmarks' | 'settings' | null>(null)
  const [current, setCurrent] = useState<CurrentPosition>({ chapterIndex: 0, paragraphIndex: 0, percent: 0 })
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([])
  const [notice, setNotice] = useState('')
  const [warningHidden, setWarningHidden] = useState(false)
  const [fileMenuOpen, setFileMenuOpen] = useState(false)
  const [backdropDark, setBackdropDark] = useState(false)
  const [codeColumnWidth, setCodeColumnWidth] = useState<number | null>(readCodeColumnWidth)
  const style = settings.slacking.disguise
  const disguised = style !== 'none'
  const scrollRef = useRef<HTMLElement | null>(null)
  const bandRef = useRef<HTMLDivElement | null>(null)
  const columnDragRef = useRef<{ startX: number; startWidth: number } | null>(null)
  const restoredRef = useRef(false)
  const rafRef = useRef(0)
  const pendingRef = useRef<BookProgress | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    let alive = true
    setBook(null)
    setError('')
    setWarningHidden(false)
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

  // A drawer on top of a disguise would break the illusion.
  useEffect(() => {
    if (disguised) setDrawer(null)
  }, [disguised])

  // Disguised reads rename the OS window too, otherwise the taskbar gives it away.
  const disguiseTitle = style === 'none' ? null : DISGUISE_TITLES[style]
  useEffect(() => {
    if (!disguiseTitle) return
    const previous = document.title
    document.title = disguiseTitle
    return () => {
      document.title = previous
    }
  }, [disguiseTitle])

  // The transparent window samples the desktop behind it and reports whether
  // the text needs to be light or dark.
  useEffect(() => {
    return window.api.onBackdropTone((payload) => setBackdropDark(payload.dark))
  }, [])

  const setDisguiseStyle = useCallback(
    (next: DisguiseStyle): void => {
      setFileMenuOpen(false)
      onSettingsChange({ slacking: { disguise: next } })
    },
    [onSettingsChange]
  )

  // Remembering the comment column width keeps the code disguise stable when
  // the window is recreated for another style.
  useEffect(() => {
    if (codeColumnWidth === null) return
    try {
      window.localStorage.setItem(CODE_COLUMN_KEY, String(codeColumnWidth))
    } catch {
      // Local storage may be unavailable; the width simply resets next time.
    }
  }, [codeColumnWidth])

  const startColumnResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const scroll = scrollRef.current
    if (!scroll) return
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    columnDragRef.current = {
      startX: event.screenX,
      startWidth: scroll.getBoundingClientRect().width
    }
  }

  const moveColumnResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = columnDragRef.current
    const band = bandRef.current
    if (!drag || !band || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const available = Math.max(CODE_COLUMN_MIN, band.clientWidth - CODE_COLUMN_CHROME)
    const next = Math.round(
      Math.min(
        available,
        Math.max(CODE_COLUMN_MIN, drag.startWidth + event.screenX - drag.startX)
      )
    )
    setCodeColumnWidth(next)
  }

  const endColumnResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    columnDragRef.current = null
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId)
    }
  }

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

  // The main process recreates the window when the disguise changes the frame.
  // Persist first, then acknowledge, so the book reopens at the same spot.
  useEffect(() => {
    return window.api.onFlushRequest(() => {
      flush()
      window.api.notifyFlushed()
    })
  }, [flush])

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
    const y = rect.top + Math.min(88, rect.height / 2)

    for (const element of document.elementsFromPoint(x, y)) {
      const paragraph = element.closest<HTMLElement>('[data-paragraph-index]')
      if (paragraph) {
        return {
          chapterIndex: Number(paragraph.dataset.chapterIndex),
          paragraphIndex: Number(paragraph.dataset.paragraphIndex)
        }
      }
      const section = element.closest<HTMLElement>('[data-chapter-section]')
      if (section) return positionInSection(section, y)
    }

    const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[data-chapter-section]'))
    if (sections.length === 0) return { chapterIndex: 0, paragraphIndex: 0 }
    const tops = sections.map((section) => section.getBoundingClientRect().top)
    return positionInSection(sections[nearestIndexByTop(tops, y)], y)
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

  useEffect(() => {
    return () => {
      if (rafRef.current !== 0) {
        window.cancelAnimationFrame(rafRef.current)
        rafRef.current = 0
      }
    }
  }, [])

  useEffect(() => {
    const handleBeforeUnload = (): void => flush()
    window.addEventListener('beforeunload', handleBeforeUnload)
    return () => window.removeEventListener('beforeunload', handleBeforeUnload)
  }, [flush])

  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return

    // Native wheel scrolling animates the full 100px notch, which blurs the
    // text while it moves. Scroll a shorter distance and land on it at once
    // so every step stays sharp.
    const handleWheel = (event: WheelEvent): void => {
      if (event.ctrlKey || event.shiftKey) return
      if (event.deltaMode !== WheelEvent.DOM_DELTA_PIXEL) return
      if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
      event.preventDefault()
      scroller.scrollTop += event.deltaY * WHEEL_DISTANCE_SCALE
    }

    scroller.addEventListener('wheel', handleWheel, { passive: false })
    return () => scroller.removeEventListener('wheel', handleWheel)
  }, [book])

  const seek = (percent: number): void => {
    if (!book) return
    const { chapterIndex, paragraphIndex } = positionForPercent(book.meta, percent, paragraphs)
    const applied = percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
    const next = { chapterIndex, paragraphIndex, percent: applied }
    setCurrent(next)
    scheduleSave(next)
    scrollToPosition(chapterIndex, paragraphIndex)
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
        .catch((reason: unknown) => {
          console.error('取消书签失败', reason)
          setNotice('取消书签失败，请稍后重试')
        })
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
      .catch((reason: unknown) => {
        console.error('添加书签失败', reason)
        setNotice('添加书签失败，请稍后重试')
      })
  }, [book, bookId, bookmarks, current])

  const deleteBookmark = useCallback(
    (bookmarkId: string): void => {
      void window.api
        .removeBookmark(bookId, bookmarkId)
        .then(setBookmarks)
        .catch((reason: unknown) => {
          console.error('删除书签失败', reason)
          setNotice('删除书签失败，请稍后重试')
        })
    },
    [bookId]
  )

  const scrollByScreen = useCallback((direction: number): void => {
    const scroller = scrollRef.current
    if (!scroller) return
    scroller.scrollBy({ top: direction * scroller.clientHeight * 0.9, behavior: 'smooth' })
  }, [])

  const changeFontSize = useCallback(
    (delta: number): void => {
      const fontSize = Math.min(
        FONT_SIZE_MAX,
        Math.max(FONT_SIZE_MIN, settings.typography.fontSize + delta)
      )
      onSettingsChange({ typography: { fontSize } })
    },
    [onSettingsChange, settings.typography.fontSize]
  )

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'F11') {
        event.preventDefault()
        void window.api.toggleFullscreen()
        return
      }

      const target = event.target as HTMLElement | null
      const editing =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)

      if (editing) {
        if (event.key === 'Escape') {
          setDrawer(null)
          target.blur()
        }
        return
      }

      // Reader shortcuts would expose the disguise; only paging keys stay.
      if ((event.ctrlKey || event.metaKey) && disguised) return

      if (event.ctrlKey || event.metaKey) {
        switch (event.key) {
          case 'f':
            event.preventDefault()
            setDrawer('search')
            return
          case 'b':
            event.preventDefault()
            if (!event.repeat) toggleBookmark()
            return
          case '=':
          case '+':
            event.preventDefault()
            changeFontSize(1)
            return
          case '-':
            event.preventDefault()
            changeFontSize(-1)
            return
          default:
            return
        }
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        if (drawer) setDrawer(null)
        else if (style !== 'none') setDisguiseStyle('none')
        else onBack()
        return
      }

      if (drawer !== null) return

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault()
          jumpToChapter(current.chapterIndex - 1)
          break
        case 'ArrowRight':
          event.preventDefault()
          jumpToChapter(current.chapterIndex + 1)
          break
        case ' ':
          event.preventDefault()
          scrollByScreen(event.shiftKey ? -1 : 1)
          break
        case 'PageDown':
          event.preventDefault()
          scrollByScreen(1)
          break
        case 'PageUp':
          event.preventDefault()
          scrollByScreen(-1)
          break
        default:
          break
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [
    changeFontSize,
    current.chapterIndex,
    disguised,
    drawer,
    jumpToChapter,
    onBack,
    scrollByScreen,
    setDisguiseStyle,
    style,
    toggleBookmark
  ])

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
    <div
      className="reader"
      data-theme={theme}
      data-slacking={disguised ? style : undefined}
      data-backdrop={backdropDark ? 'dark' : 'light'}
      style={readerStyle}
    >
      {style === 'none' && (
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
            设置
          </button>
          <button
            className="ghost slacking-entry"
            onClick={() => setDisguiseStyle('notepad')}
            title="伪装成记事本，按 Esc 退出；其它样式在设置里选"
          >
            摸鱼
          </button>
        </header>
      )}

      {style === 'notepad' && (
        <NotepadMenubar
          fileMenuOpen={fileMenuOpen}
          onToggleFileMenu={() => setFileMenuOpen((open) => !open)}
          onCloseFileMenu={() => setFileMenuOpen(false)}
          onExitDisguise={() => setDisguiseStyle('none')}
        />
      )}

      {style === 'code' && (
        <div className="vscode-tabbar">
          <div className="vscode-tab">codenovel.js</div>
          <div className="vscode-tabbar-fill" />
        </div>
      )}

      {style === 'transparent' && <div className="transparent-drag-strip" />}

      {(style === 'transparent' || style === 'code') && <WindowResizeHandles />}

      {(style === 'transparent' || style === 'code') && (
        <button
          className="disguise-exit"
          onClick={() => setDisguiseStyle('none')}
          title="退出伪装（Esc）"
          aria-label="退出伪装"
        >
          ×
        </button>
      )}

      {book.warnings.length > 0 && !warningHidden && !disguised && (
        <div className="reader-warning" role="status">
          <span>{book.warnings.join('；')}</span>
          <button className="ghost" onClick={() => setWarningHidden(true)}>
            知道了
          </button>
        </div>
      )}

      {style === 'code' ? (
        <div className="vscode-editor">
          <CodeRows lines={CODE_TOP} start={1} />
          <div className="vscode-comment-band" ref={bandRef}>
            <div className="vscode-comment-gutter" aria-hidden="true">
              {COMMENT_LINE_NUMBERS.map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
            <main
              className="reader-scroll vscode-comment-scroll"
              ref={scrollRef}
              onScroll={handleScroll}
              style={
                codeColumnWidth === null
                  ? undefined
                  : { flex: `0 0 ${codeColumnWidth}px`, width: codeColumnWidth }
              }
            >
              <ReaderBody chapters={chapters} />
            </main>
            <div
              className="vscode-column-resizer"
              role="separator"
              aria-orientation="vertical"
              onPointerDown={startColumnResize}
              onPointerMove={moveColumnResize}
              onPointerUp={endColumnResize}
              onPointerCancel={endColumnResize}
            />
            <div className="vscode-comment-filler" aria-hidden="true" />
          </div>
          <CodeRows lines={CODE_BOTTOM} start={CODE_BOTTOM_START} />
        </div>
      ) : (
        <main
          className={style === 'transparent' ? 'reader-scroll transparent-scroll' : 'reader-scroll'}
          ref={scrollRef}
          onScroll={handleScroll}
        >
          <ReaderBody chapters={chapters} />
        </main>
      )}

      {style === 'notepad' && (
        <footer className="notepad-statusbar">
          <span className="notepad-status-start">
            第 {current.paragraphIndex + 1} 行，第 1 列
          </span>
          <span>100%</span>
          <span>Windows (CRLF)</span>
          <span>UTF-8</span>
        </footer>
      )}

      {style === 'code' && (
        <footer className="vscode-statusbar">
          <span>main</span>
          <span>0 ⚠ 0 ✖</span>
          <span className="vscode-status-spacer" />
          <span>Ln {current.paragraphIndex + 1}, Col 1</span>
          <span>UTF-8</span>
          <span>JavaScript</span>
        </footer>
      )}

      {style === 'none' && (
        <ProgressBar
          percent={current.percent}
          chapterIndex={current.chapterIndex}
          chapterCount={book.meta.chapters.length}
          remainingMinutes={remainingMinutes}
          onSeek={seek}
        />
      )}

      {style === 'none' && (
        <>
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
              resolvedTheme={theme}
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
        </>
      )}

      {notice && <div className="reader-notice">{notice}</div>}
    </div>
  )
}
