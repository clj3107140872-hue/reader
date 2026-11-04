import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { DISGUISE_OPTIONS, FONT_SIZE_MAX, FONT_SIZE_MIN } from '../../../shared/settings'
import type { SettingsPatch } from '../../../shared/settings'
import BookmarksPanel from '../components/BookmarksPanel'
import ProgressBar from '../components/ProgressBar'
import SearchPanel from '../components/SearchPanel'
import SettingsPanel from '../components/SettingsPanel'
import TocDrawer from '../components/TocDrawer'
import {
  CODE_COMMENT_DEFAULT,
  CODE_COMMENT_MAX,
  CODE_COMMENT_MIN,
  CODE_ROW_HEIGHT,
  codeLayout
} from '../reader/codeLayout'
import { wheelLineStep } from '../reader/codeWheel'
import {
  pageCountFor,
  pageIndexForOffset,
  scrollLeftForPage,
  wheelPageStep
} from '../reader/pagination'
import { isNewResizePoint } from '../reader/resizeDrag'
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

/**
 * Nearest paragraph inside a chapter section, measured against the probe
 * point. Pages are columns laid side by side, so paragraphs from other
 * columns of the same chapter must not win just because their top is closer.
 */
function positionInSection(
  section: HTMLElement,
  x: number,
  y: number
): { chapterIndex: number; paragraphIndex: number } {
  const chapterIndex = Number(section.dataset.chapterSection)
  const paragraphElements = Array.from(
    section.querySelectorAll<HTMLElement>('[data-paragraph-index]')
  )
  if (paragraphElements.length === 0) return { chapterIndex, paragraphIndex: 0 }
  const inColumn = paragraphElements.filter((element) => {
    const rect = element.getBoundingClientRect()
    return x >= rect.left - 1 && x <= rect.right + 1
  })
  const pool = inColumn.length > 0 ? inColumn : paragraphElements
  const tops = pool.map((element) => element.getBoundingClientRect().top)
  const paragraph = pool[nearestIndexByTop(tops, y)]
  return { chapterIndex, paragraphIndex: Number(paragraph.dataset.paragraphIndex) }
}

interface PagedMetrics {
  /** Width of one page column. */
  width: number
  /** Gap between two columns. */
  gap: number
  /** Distance from one page to the next. */
  step: number
  count: number
}

/** Measures the column layout of the chapter currently on screen. */
function measurePaged(scroller: HTMLElement): PagedMetrics | null {
  const page = scroller.querySelector<HTMLElement>('.reader-page')
  if (!page) return null
  const width = page.clientWidth
  if (!(width > 0)) return null
  const gap = Number.parseFloat(getComputedStyle(page).columnGap) || 0
  // Columns overflow the page box; the last section's right edge is the end
  // of the last column even when the browser's scrollWidth ignores it.
  const last = page.lastElementChild as HTMLElement | null
  const pageLeft = page.getBoundingClientRect().left
  const contentRight = last ? last.getBoundingClientRect().right - pageLeft : 0
  const total = Math.max(page.scrollWidth, contentRight)
  return { width, gap, step: width + gap, count: pageCountFor(total, width, gap) }
}

const DISGUISE_TITLES: Record<Exclude<DisguiseStyle, 'none'>, string> = {
  notepad: '工作文档.txt - 记事本',
  transparent: '工作文档.txt - 记事本',
  code: 'codenovel.js - Visual Studio Code'
}

const NOTEPAD_MENUS = ['文件', '编辑', '格式', '查看', '帮助'] as const

const RESIZE_EDGES: WindowResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']
const CODE_LINES_KEY = 'reader.codeCommentLines'

function readCommentLines(): number {
  try {
    const raw = window.localStorage.getItem(CODE_LINES_KEY)
    const parsed = raw === null ? Number.NaN : Number(raw)
    if (!Number.isFinite(parsed)) return CODE_COMMENT_DEFAULT
    return Math.min(CODE_COMMENT_MAX, Math.max(CODE_COMMENT_MIN, Math.round(parsed)))
  } catch {
    return CODE_COMMENT_DEFAULT
  }
}

interface ResizeDrag {
  pointerId: number
  /** Last position already forwarded to the main process. */
  lastX: number
  lastY: number
  /** Latest position waiting for the next animation frame. */
  nextX: number
  nextY: number
  frame: number | null
}

/**
 * Invisible edge strips that resize frameless disguise windows over IPC.
 * Moves are deduplicated and coalesced into one IPC call per frame: a window
 * resizing under the pointer can re-send a move at the same screen point, and
 * forwarding it would make every resize schedule the next one until the app
 * locks up.
 */
function WindowResizeHandles() {
  const dragRef = useRef<ResizeDrag | null>(null)

  const sendPending = (drag: ResizeDrag): void => {
    drag.frame = null
    if (!isNewResizePoint({ x: drag.lastX, y: drag.lastY }, { x: drag.nextX, y: drag.nextY })) {
      return
    }
    drag.lastX = drag.nextX
    drag.lastY = drag.nextY
    window.api.windowResizeMove(drag.nextX, drag.nextY)
  }

  const finish = (): void => {
    const drag = dragRef.current
    if (!drag) return
    if (drag.frame !== null) {
      window.cancelAnimationFrame(drag.frame)
      sendPending(drag)
    }
    dragRef.current = null
    window.api.windowResizeEnd()
  }

  return (
    <>
      {RESIZE_EDGES.map((edge) => (
        <div
          key={edge}
          className={`window-resize window-resize-${edge}`}
          onPointerDown={(event) => {
            event.preventDefault()
            event.currentTarget.setPointerCapture(event.pointerId)
            dragRef.current = {
              pointerId: event.pointerId,
              lastX: event.screenX,
              lastY: event.screenY,
              nextX: event.screenX,
              nextY: event.screenY,
              frame: null
            }
            window.api.windowResizeStart(edge, event.screenX, event.screenY)
          }}
          onPointerMove={(event) => {
            const drag = dragRef.current
            if (!drag || drag.pointerId !== event.pointerId) return
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
            if (
              !isNewResizePoint(
                { x: drag.lastX, y: drag.lastY },
                { x: event.screenX, y: event.screenY }
              )
            ) {
              return
            }
            drag.nextX = event.screenX
            drag.nextY = event.screenY
            if (drag.frame === null) {
              drag.frame = window.requestAnimationFrame(() => sendPending(drag))
            }
          }}
          onPointerUp={(event) => {
            if (event.currentTarget.hasPointerCapture(event.pointerId)) {
              event.currentTarget.releasePointerCapture(event.pointerId)
            }
            finish()
          }}
          onPointerCancel={finish}
          onLostPointerCapture={finish}
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

/**
 * A long, believable source file. The editor shows the slice that fits above
 * and below the comment block, so the line numbers read as one continuous file
 * no matter how tall the window is.
 */
const CODE_FILE: string[] = (() => {
  const lines = [
    '// reader.js — 工作文档解析',
    "import { promises as fs } from 'node:fs'",
    "import { createHash } from 'node:crypto'",
    "import { join, extname, basename } from 'node:path'",
    '',
    'const CACHE_LIMIT = 64',
    "const DEFAULT_ENCODING = 'utf8'",
    'const PAGE_WINDOW = 240',
    '',
    'export async function loadDocument(file, options = {}) {',
    '  const buffer = await fs.readFile(file)',
    "  const encoding = options.encoding ?? detectEncoding(buffer)",
    '  const text = buffer.toString(encoding)',
    '  return { file, encoding, text, size: buffer.byteLength }',
    '}',
    '',
    'export function detectEncoding(buffer) {',
    "  if (buffer[0] === 0xef && buffer[1] === 0xbb) return 'utf8'",
    "  if (buffer[0] === 0xff && buffer[1] === 0xfe) return 'utf16le'",
    "  return buffer.includes(0x00) ? 'utf16le' : DEFAULT_ENCODING",
    '}',
    ''
  ]
  const names = [
    'normalizeLine',
    'splitChapters',
    'parseTitle',
    'stripAds',
    'hashTitle',
    'mergeParagraphs',
    'measurePages',
    'buildIndex',
    'resolveRule',
    'applyCleaning'
  ]
  names.forEach((name, index) => {
    const id = index + 1
    lines.push(
      `export function ${name}${id}(input, options = {}) {`,
      "  const source = String(input ?? '')",
      `  const limit = options.limit ?? ${id * 12}`,
      '  const rows = source.split(/\\r?\\n/).slice(0, limit)',
      '  const result = rows.map((line, position) => ({',
      '    position,',
      '    text: line.trim(),',
      `    key: createHash('sha1').update(line).digest('hex').slice(0, ${8 + (index % 5)})`,
      '  }))',
      '  return result.filter((item) => item.text.length > 0)',
      '}',
      ''
    )
  })
  lines.push(
    'export function readChapter(document, index, cache = new Map()) {',
    '  const key = `${document.file}:${index}`',
    '  if (cache.has(key)) return cache.get(key)',
    '  const chapter = splitChapters2(document.text)[index]',
    '  if (!chapter) return null',
    '  cache.set(key, { ...chapter, encoding: document.encoding })',
    '  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)',
    '  return chapter',
    '}',
    '',
    'export function buildWindow(document, position) {',
    '  const page = Math.floor(position / PAGE_WINDOW)',
    '  const offset = page * PAGE_WINDOW',
    '  return { page, offset, end: offset + PAGE_WINDOW }',
    '}',
    '',
    'export function formatProgress(read, total) {',
    '  const percent = total > 0 ? Math.min(100, (read / total) * 100) : 0',
    '  return `${percent.toFixed(2)}%`',
    '}',
    '',
    'export default {',
    '  loadDocument,',
    '  detectEncoding,',
    '  readChapter,',
    '  buildWindow,',
    '  formatProgress',
    '}'
  )
  return lines
})()

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
      {chapters.map((chapter) => (
        <section
          key={chapter.meta.index}
          className={`reader-chapter ${chapter.meta.level}`}
          data-chapter-section={chapter.meta.index}
        >
          <h2 className="chapter-title">{chapter.meta.title}</h2>
          {chapter.paragraphs.map((text, paragraphIndex) => (
            <p
              key={paragraphIndex}
              className="reader-paragraph"
              data-chapter-index={chapter.meta.index}
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
  const [commentLines, setCommentLines] = useState(readCommentLines)
  const [editorHeight, setEditorHeight] = useState(() => window.innerHeight)
  const [disguiseMenuOpen, setDisguiseMenuOpen] = useState(false)
  const [disguiseHint, setDisguiseHint] = useState('')
  const style = settings.slacking.disguise
  const disguised = style !== 'none'
  // The code disguise is an editor and keeps its line scrolling.
  const paged = settings.readingMode === 'paged' && style !== 'code'
  const [pageIndex, setPageIndex] = useState(0)
  const [pageCount, setPageCount] = useState(1)
  const pagedMetricsRef = useRef<PagedMetrics | null>(null)
  const anchorRef = useRef<{ chapterIndex: number; paragraphIndex: number }>({
    chapterIndex: 0,
    paragraphIndex: 0
  })
  const pagedRef = useRef(paged)
  pagedRef.current = paged
  const layout = codeLayout(editorHeight, commentLines)
  const scrollRef = useRef<HTMLElement | null>(null)
  const menuRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef<HTMLDivElement | null>(null)
  const lineDragRef = useRef<{
    edge: 'top' | 'bottom'
    startY: number
    startLines: number
  } | null>(null)
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

  useEffect(() => {
    if (!disguiseMenuOpen) return
    const handlePointerDown = (event: PointerEvent): void => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setDisguiseMenuOpen(false)
      }
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [disguiseMenuOpen])

  // The × is deliberately absent, so tell people how to get out every time a
  // disguise opens (including when a window is recreated for another style).
  useEffect(() => {
    if (!disguised) {
      setDisguiseHint('')
      return
    }
    setDisguiseHint('摸鱼模式：按 Esc 退出')
    const timer = window.setTimeout(() => setDisguiseHint(''), 4000)
    return () => window.clearTimeout(timer)
  }, [disguised, style])

  // The editor height decides how many whole code lines surround the comment
  // band; the band itself stays at the line count the user chose.
  useEffect(() => {
    if (style !== 'code') return
    const editor = editorRef.current
    if (!editor) return
    const measure = (): void => setEditorHeight(editor.getBoundingClientRect().height)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(editor)
    return () => observer.disconnect()
  }, [book, style])

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

  // The line count is a reader preference, kept beside the other renderer-only
  // state so switching disguise styles (and windows) preserves it.
  useEffect(() => {
    try {
      window.localStorage.setItem(CODE_LINES_KEY, String(commentLines))
    } catch {
      // Local storage may be unavailable; the count simply resets next time.
    }
  }, [commentLines])

  const startLineResize = (
    edge: 'top' | 'bottom',
    event: ReactPointerEvent<HTMLDivElement>
  ): void => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
    lineDragRef.current = { edge, startY: event.screenY, startLines: layout.lines }
  }

  const moveLineResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    const drag = lineDragRef.current
    if (!drag || !event.currentTarget.hasPointerCapture(event.pointerId)) return
    const delta = Math.round((event.screenY - drag.startY) / CODE_ROW_HEIGHT)
    const next = drag.edge === 'bottom' ? drag.startLines + delta : drag.startLines - delta
    setCommentLines(Math.min(layout.maxLines, Math.max(CODE_COMMENT_MIN, next)))
  }

  const endLineResize = (event: ReactPointerEvent<HTMLDivElement>): void => {
    lineDragRef.current = null
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

  // Paged mode lays out one chapter at a time; a whole book in columns would
  // force the browser to measure every glyph before the first page appears.
  const visibleChapters = useMemo(() => {
    if (!paged) return chapters
    const chapter = chapters[current.chapterIndex]
    return chapter ? [chapter] : []
  }, [chapters, current.chapterIndex, paged])

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
    const section = scroller.querySelector<HTMLElement>(`[data-chapter-section="${chapterIndex}"]`)
    const target = paragraph ?? section
    if (!target) return
    // Chapters at or above the target may still be sized by the
    // `content-visibility: auto` estimate, and the scroller clamps scrollTop
    // against that estimate. Lay them out for the jump; their remembered
    // sizes keep the position stable once the optimization resumes.
    const revealed: HTMLElement[] = []
    for (const chapter of Array.from(
      scroller.querySelectorAll<HTMLElement>('[data-chapter-section]')
    )) {
      if (Number(chapter.dataset.chapterSection) > chapterIndex) break
      if (getComputedStyle(chapter).contentVisibility !== 'auto') continue
      chapter.style.contentVisibility = 'visible'
      revealed.push(chapter)
    }
    // Matches the scroll-margin-top on paragraphs and chapter titles.
    const margin = paragraph ? 64 : 0
    // Reading the rect commits the layout this jump depends on.
    const scrollerRect = scroller.getBoundingClientRect()
    const offset = target.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop
    scroller.scrollTop = Math.max(0, offset - margin)
    const applied = scroller.scrollTop
    // Let the browser render the revealed chapters once, so their real sizes
    // replace the estimates before the content-visibility optimization
    // resumes. Then correct any residual drift, unless the reader has moved
    // on since.
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        for (const chapter of revealed) chapter.style.removeProperty('content-visibility')
        if (Math.abs(scroller.scrollTop - applied) > 1) return
        const drift =
          target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin
        if (Math.abs(drift) > 1) {
          scroller.scrollTop = Math.max(0, scroller.scrollTop + drift)
        }
      })
    })
  }, [])

  /**
   * Shows the page that contains a paragraph. Columns reflow on every size or
   * typography change, so the page is recomputed from the paragraph's layout
   * offset instead of being remembered as a number.
   */
  const applyPagedAnchor = useCallback(
    (anchor: { chapterIndex: number; paragraphIndex: number }): void => {
      const scroller = scrollRef.current
      if (!scroller) return
      const page = scroller.querySelector<HTMLElement>('.reader-page')
      if (!page) return
      const metrics = measurePaged(scroller)
      if (!metrics) return
      pagedMetricsRef.current = metrics
      setPageCount(metrics.count)
      const target =
        scroller.querySelector<HTMLElement>(
          `[data-chapter-index="${anchor.chapterIndex}"][data-paragraph-index="${anchor.paragraphIndex}"]`
        ) ?? scroller.querySelector<HTMLElement>(`[data-chapter-section="${anchor.chapterIndex}"]`)
      const offset = target ? target.getBoundingClientRect().left - page.getBoundingClientRect().left : 0
      const index = Math.min(
        metrics.count - 1,
        pageIndexForOffset(offset, metrics.width, metrics.gap)
      )
      scroller.scrollLeft = scrollLeftForPage(index, metrics.width, metrics.gap)
      setPageIndex(Math.max(0, index))
    },
    []
  )

  /** Chapter and paragraph at the top of the page currently on screen. */
  const currentPosition = useCallback(
    (probeY?: number): { chapterIndex: number; paragraphIndex: number } | null => {
      const scroller = scrollRef.current
      if (!scroller) return null
      const rect = scroller.getBoundingClientRect()
      const x = rect.left + rect.width / 2
      const y = rect.top + (probeY ?? Math.min(88, rect.height / 2))

      for (const element of document.elementsFromPoint(x, y)) {
        const paragraph = element.closest<HTMLElement>('[data-paragraph-index]')
        if (paragraph) {
          return {
            chapterIndex: Number(paragraph.dataset.chapterIndex),
            paragraphIndex: Number(paragraph.dataset.paragraphIndex)
          }
        }
        const section = element.closest<HTMLElement>('[data-chapter-section]')
        if (section) return positionInSection(section, x, y)
      }

      const sections = Array.from(scroller.querySelectorAll<HTMLElement>('[data-chapter-section]'))
      if (sections.length === 0) return { chapterIndex: 0, paragraphIndex: 0 }
      const tops = sections.map((section) => section.getBoundingClientRect().top)
      return positionInSection(sections[nearestIndexByTop(tops, y)], x, y)
    },
    []
  )

  /** Reads the page the user just landed on and records it as the anchor. */
  const syncPagedFromView = useCallback((): void => {
    if (!book) return
    const scroller = scrollRef.current
    const metrics = pagedMetricsRef.current
    if (!scroller || !metrics) return
    const index = Math.min(
      metrics.count - 1,
      Math.max(0, Math.round(scroller.scrollLeft / metrics.step))
    )
    setPageIndex(index)
    const position = currentPosition(Math.min(24, scroller.clientHeight / 4))
    if (!position) return
    const percent = percentAt(book.meta, position.chapterIndex, position.paragraphIndex, paragraphs)
    const next = { ...position, percent }
    anchorRef.current = position
    setCurrent(next)
    scheduleSave(next)
  }, [book, currentPosition, paragraphs, scheduleSave])

  /** Flips one page, crossing into the neighbouring chapter at the ends. */
  const turnPage = useCallback(
    (delta: number): void => {
      if (!book) return
      const scroller = scrollRef.current
      const metrics = pagedMetricsRef.current
      if (!scroller || !metrics) return
      const index = Math.min(
        metrics.count - 1,
        Math.max(0, Math.round(scroller.scrollLeft / metrics.step))
      )

      if (delta > 0 && index >= metrics.count - 1) {
        const chapterIndex = current.chapterIndex + 1
        if (chapterIndex >= book.meta.chapters.length) return
        const next = {
          chapterIndex,
          paragraphIndex: 0,
          percent: percentAt(book.meta, chapterIndex, 0, paragraphs)
        }
        anchorRef.current = { chapterIndex, paragraphIndex: 0 }
        pagedMetricsRef.current = null
        setCurrent(next)
        scheduleSave(next)
        return
      }

      if (delta < 0 && index <= 0) {
        const chapterIndex = current.chapterIndex - 1
        if (chapterIndex < 0) return
        const paragraphIndex = Math.max(0, (paragraphs[chapterIndex]?.length ?? 1) - 1)
        const next = {
          chapterIndex,
          paragraphIndex,
          percent: percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
        }
        anchorRef.current = { chapterIndex, paragraphIndex }
        pagedMetricsRef.current = null
        setCurrent(next)
        scheduleSave(next)
        return
      }

      const nextIndex = Math.min(metrics.count - 1, Math.max(0, index + delta))
      scroller.scrollLeft = scrollLeftForPage(nextIndex, metrics.width, metrics.gap)
      syncPagedFromView()
    },
    [book, current.chapterIndex, paragraphs, scheduleSave, syncPagedFromView]
  )
  // Wheel and keyboard listeners stay mounted across renders; they read the
  // latest page-turn callback through this ref.
  const turnPageRef = useRef(turnPage)
  turnPageRef.current = turnPage

  /**
   * Jumps to a paragraph in whichever mode is active. Paged mode may have to
   * render the target chapter first, so it retries across a few frames.
   */
  const goToPosition = useCallback(
    (rawChapterIndex: number, rawParagraphIndex: number): void => {
      if (!book) return
      const chapterIndex = Math.min(
        Math.max(rawChapterIndex, 0),
        book.meta.chapters.length - 1
      )
      const paragraphIndex = Math.min(
        Math.max(rawParagraphIndex, 0),
        Math.max(0, (paragraphs[chapterIndex]?.length ?? 1) - 1)
      )
      const percent = percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
      const next = { chapterIndex, paragraphIndex, percent }
      anchorRef.current = { chapterIndex, paragraphIndex }
      setCurrent(next)
      scheduleSave(next)
      if (!paged) {
        scrollToPosition(chapterIndex, paragraphIndex)
        return
      }
      let attempts = 0
      const apply = (): void => {
        if (!pagedRef.current) return
        const scroller = scrollRef.current
        const rendered = scroller?.querySelector(`[data-chapter-section="${chapterIndex}"]`)
        if (!rendered) {
          if (attempts++ < 8) window.requestAnimationFrame(apply)
          return
        }
        applyPagedAnchor({ chapterIndex, paragraphIndex })
      }
      window.requestAnimationFrame(apply)
    },
    [book, paged, paragraphs, applyPagedAnchor, scheduleSave, scrollToPosition]
  )

  const handleScroll = useCallback((): void => {
    if (rafRef.current !== 0) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      if (!book) return
      const position = currentPosition()
      if (!position) return
      const percent = percentAt(book.meta, position.chapterIndex, position.paragraphIndex, paragraphs)
      const next = { ...position, percent }
      anchorRef.current = position
      setCurrent(next)
      scheduleSave(next)
    })
  }, [book, currentPosition, paragraphs, scheduleSave])

  // A half-scrolled line would give the disguise away, so any scroll (including
  // drag-selection auto-scroll) is pulled back onto the editor's line grid.
  const handleCommentScroll = useCallback((): void => {
    const scroller = scrollRef.current
    if (scroller) {
      const snapped = Math.round(scroller.scrollTop / CODE_ROW_HEIGHT) * CODE_ROW_HEIGHT
      if (Math.abs(scroller.scrollTop - snapped) >= 0.5) {
        scroller.scrollTop = snapped
      }
    }
    handleScroll()
  }, [handleScroll])

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
    anchorRef.current = { chapterIndex, paragraphIndex }
    setCurrent(next)
    scheduleSave(next)
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (pagedRef.current) goToPosition(chapterIndex, paragraphIndex)
        else scrollToPosition(chapterIndex, paragraphIndex)
      })
    })
  }, [book, chapters.length, paragraphs, scheduleSave, scrollToPosition, goToPosition])

  // A page is recomputed whenever the chapter, the mode or the typography
  // changes. The anchor paragraph keeps the reading spot across the reflow.
  // Runs before paint so the new chapter never flashes its first page.
  useLayoutEffect(() => {
    if (!paged || !book) return
    applyPagedAnchor(anchorRef.current)
  }, [paged, book, current.chapterIndex, settings.typography, applyPagedAnchor])

  // Resizing changes how much text fits on a page, so move the view back to
  // the page that holds the anchor paragraph. The observer fires after layout,
  // which is exactly when the column layout can be measured.
  useEffect(() => {
    if (!paged) return
    const scroller = scrollRef.current
    if (!scroller) return
    const observer = new ResizeObserver(() => applyPagedAnchor(anchorRef.current))
    observer.observe(scroller)
    return () => observer.disconnect()
  }, [paged, book, applyPagedAnchor])

  // Leaving paged mode returns to the continuous layout; bring the reading
  // spot back into view instead of the top of the first rendered chapter.
  // A layout effect keeps this ahead of the scroll event the browser fires
  // while the four chapters replace the single paged one; that event would
  // otherwise rewrite the anchor before it is read.
  const previousPagedRef = useRef(paged)
  useLayoutEffect(() => {
    const wasPaged = previousPagedRef.current
    previousPagedRef.current = paged
    if (!wasPaged || paged || !book) return
    const anchor = anchorRef.current
    scrollToPosition(anchor.chapterIndex, anchor.paragraphIndex)
  }, [paged, book, scrollToPosition])

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
    // In code mode the wheel belongs to the whole fake editor, not just the
    // comment column, so scrolling over the code still moves the novel.
    const target = style === 'code' ? editorRef.current : scroller
    if (!scroller || !target) return

    if (paged) {
      // One wheel gesture turns one page. The cooldown stops trackpad inertia
      // from flipping several pages after the finger has stopped.
      let travel = 0
      let lastTurn = 0
      const handleWheel = (event: WheelEvent): void => {
        if (event.ctrlKey || event.shiftKey) return
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
        event.preventDefault()
        const now = performance.now()
        if (now - lastTurn < 300) return
        const step = wheelPageStep(event.deltaY, event.deltaMode, travel)
        travel = step.travel
        if (step.turn === 0) return
        lastTurn = now
        turnPageRef.current(step.turn)
      }

      target.addEventListener('wheel', handleWheel, { passive: false })
      return () => target.removeEventListener('wheel', handleWheel)
    }

    if (style === 'code') {
      // One wheel notch moves exactly one line; small trackpad deltas
      // accumulate. Always take the event so the browser never jumps a screen.
      let travel = 0
      const handleWheel = (event: WheelEvent): void => {
        if (event.ctrlKey || event.shiftKey) return
        if (Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return
        event.preventDefault()
        const step = wheelLineStep(event.deltaY, event.deltaMode, travel)
        travel = step.travel
        if (step.lines === 0) return
        scroller.scrollTop += step.lines * CODE_ROW_HEIGHT
      }

      target.addEventListener('wheel', handleWheel, { passive: false })
      return () => target.removeEventListener('wheel', handleWheel)
    }

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

    target.addEventListener('wheel', handleWheel, { passive: false })
    return () => target.removeEventListener('wheel', handleWheel)
  }, [book, style, paged])

  const seek = (percent: number): void => {
    if (!book) return
    const { chapterIndex, paragraphIndex } = positionForPercent(book.meta, percent, paragraphs)
    goToPosition(chapterIndex, paragraphIndex)
  }

  const jumpToChapter = useCallback(
    (chapterIndex: number): void => {
      goToPosition(chapterIndex, 0)
      setDrawer(null)
    },
    [goToPosition]
  )

  const jumpToPosition = useCallback(
    (chapterIndex: number, paragraphIndex: number): void => {
      goToPosition(chapterIndex, paragraphIndex)
      // Paged mode may still be rendering the target chapter; retry briefly
      // before giving up on the search highlight.
      const flash = (tries: number): void => {
        const target = scrollRef.current?.querySelector<HTMLElement>(
          `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
        )
        if (!target) {
          if (tries < 8) window.requestAnimationFrame(() => flash(tries + 1))
          return
        }
        target.classList.add('search-flash')
        window.setTimeout(() => target.classList.remove('search-flash'), 2000)
      }
      window.requestAnimationFrame(() => flash(0))
    },
    [goToPosition]
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

  const scrollByScreen = useCallback(
    (direction: number): void => {
      const scroller = scrollRef.current
      if (!scroller) return
      if (style === 'code') {
        // One screen is exactly the comment band, never a partial line.
        scroller.scrollTop += direction * layout.lines * CODE_ROW_HEIGHT
        return
      }
      scroller.scrollBy({ top: direction * scroller.clientHeight * 0.9, behavior: 'smooth' })
    },
    [layout.lines, style]
  )

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

      // Esc closes the style chooser before it closes anything else.
      if (event.key === 'Escape' && disguiseMenuOpen) {
        event.preventDefault()
        setDisguiseMenuOpen(false)
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
          if (paged) turnPageRef.current(-1)
          else if (style === 'code') scrollByScreen(-1)
          else jumpToChapter(current.chapterIndex - 1)
          break
        case 'ArrowRight':
          event.preventDefault()
          if (paged) turnPageRef.current(1)
          else if (style === 'code') scrollByScreen(1)
          else jumpToChapter(current.chapterIndex + 1)
          break
        case 'ArrowUp':
          if (paged) {
            event.preventDefault()
            turnPageRef.current(-1)
          }
          break
        case 'ArrowDown':
          if (paged) {
            event.preventDefault()
            turnPageRef.current(1)
          }
          break
        case ' ':
          event.preventDefault()
          if (paged) turnPageRef.current(event.shiftKey ? -1 : 1)
          else scrollByScreen(event.shiftKey ? -1 : 1)
          break
        case 'PageDown':
          event.preventDefault()
          if (paged) turnPageRef.current(1)
          else scrollByScreen(1)
          break
        case 'PageUp':
          event.preventDefault()
          if (paged) turnPageRef.current(-1)
          else scrollByScreen(-1)
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
    disguiseMenuOpen,
    disguised,
    drawer,
    jumpToChapter,
    onBack,
    paged,
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
          <div className="disguise-menu-wrap" ref={menuRef}>
            <button
              className="ghost slacking-entry"
              onClick={() => setDisguiseMenuOpen((open) => !open)}
              aria-haspopup="menu"
              aria-expanded={disguiseMenuOpen}
              title="选择摸鱼样式，按 Esc 退出"
            >
              摸鱼
            </button>
            {disguiseMenuOpen && (
              <div className="disguise-menu" role="menu">
                <span className="disguise-menu-title">选择摸鱼样式</span>
                {DISGUISE_OPTIONS.filter((option) => option.id !== 'none').map((option) => (
                  <button
                    key={option.id}
                    type="button"
                    role="menuitem"
                    data-style={option.id}
                    onClick={() => {
                      setDisguiseMenuOpen(false)
                      setDisguiseStyle(option.id)
                    }}
                  >
                    <span>{option.label}</span>
                    <small>{option.hint}</small>
                  </button>
                ))}
              </div>
            )}
          </div>
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

      {style === 'code' && <div className="code-drag-strip" />}

      {style === 'transparent' && <div className="transparent-drag-strip" />}

      {(style === 'transparent' || style === 'code') && <WindowResizeHandles />}

      {book.warnings.length > 0 && !warningHidden && !disguised && (
        <div className="reader-warning" role="status">
          <span>{book.warnings.join('；')}</span>
          <button className="ghost" onClick={() => setWarningHidden(true)}>
            知道了
          </button>
        </div>
      )}

      {style === 'code' ? (
        <div className="vscode-editor" ref={editorRef}>
          <CodeRows lines={CODE_FILE.slice(0, layout.topRows)} start={1} />
          <div
            className="vscode-comment-band"
            style={{ height: layout.lines * CODE_ROW_HEIGHT }}
          >
            <div className="vscode-comment-gutter" aria-hidden="true">
              {Array.from(
                { length: layout.lines },
                (_, index) => layout.topRows + index + 1
              ).map((line) => (
                <span key={line}>{line}</span>
              ))}
            </div>
            <main
              className="reader-scroll vscode-comment-scroll"
              ref={scrollRef}
              onScroll={handleCommentScroll}
            >
              <ReaderBody chapters={chapters} />
            </main>
            <div
              className="code-band-handle top"
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整正文行数"
              onPointerDown={(event) => startLineResize('top', event)}
              onPointerMove={moveLineResize}
              onPointerUp={endLineResize}
              onPointerCancel={endLineResize}
            />
            <div
              className="code-band-handle bottom"
              role="separator"
              aria-orientation="horizontal"
              aria-label="调整正文行数"
              onPointerDown={(event) => startLineResize('bottom', event)}
              onPointerMove={moveLineResize}
              onPointerUp={endLineResize}
              onPointerCancel={endLineResize}
            />
          </div>
          <CodeRows
            lines={CODE_FILE.slice(
              layout.topRows + layout.lines,
              layout.topRows + layout.lines + layout.bottomRows
            )}
            start={layout.topRows + layout.lines + 1}
          />
        </div>
      ) : (
        <main
          className={`reader-scroll${style === 'transparent' ? ' transparent-scroll' : ''}${paged ? ' paged' : ''}`}
          ref={scrollRef}
          onScroll={paged ? undefined : handleScroll}
          data-reading-mode={paged ? 'paged' : undefined}
        >
          <ReaderBody chapters={visibleChapters} />
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

      {style === 'none' && (
        <ProgressBar
          percent={current.percent}
          chapterIndex={current.chapterIndex}
          chapterCount={book.meta.chapters.length}
          remainingMinutes={remainingMinutes}
          page={paged ? { index: pageIndex, count: pageCount } : undefined}
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

      {(notice || disguiseHint) && (
        <div className={`reader-notice${disguiseHint && !notice ? ' disguise-hint' : ''}`}>
          {notice || disguiseHint}
        </div>
      )}
    </div>
  )
}
