import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react'
import type {
  AppSettings,
  BookMeta,
  Bookmark,
  BookProgress,
  DisguiseStyle,
  ThemeName,
  TypographySettings
} from '../../../core/model'
import { splitParagraphs } from '../../../core/paragraphs'
import { chapterWindow } from '../reader/chapterWindow'
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
import { useChapterTexts } from '../reader/useChapterTexts'
import {
  chapterForPercent,
  charsBefore,
  nearestIndexByTop,
  percentAt,
  percentForChapter,
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
  loading?: boolean
  error?: string
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
function WindowResizeHandles({ onResizeSession }: { onResizeSession: (active: boolean) => void }) {
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
    onResizeSession(false)
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
            onResizeSession(true)
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

const ReaderBody = memo(function ReaderBody({
  chapters,
  resizing,
  onRetryChapter
}: {
  chapters: ChapterView[]
  resizing: boolean
  onRetryChapter: (index: number) => void
}) {
  const articleRef = useRef<HTMLElement | null>(null)

  // Reflowing every paragraph of a long book on each pointer move while the
  // window is dragged made the app freeze. Pin the text width for the drag,
  // then release it once so the book reflows exactly once.
  useLayoutEffect(() => {
    const article = articleRef.current
    if (!article) return
    if (resizing) {
      article.style.width = `${article.clientWidth}px`
    } else {
      article.style.removeProperty('width')
    }
    return () => {
      article.style.removeProperty('width')
    }
  }, [resizing])

  return (
    <article className="reader-page" ref={articleRef}>
      {chapters.map((chapter) => (
        <section
          key={chapter.meta.index}
          className={`reader-chapter ${chapter.meta.level}`}
          data-chapter-section={chapter.meta.index}
        >
          <h2 className="chapter-title">{chapter.meta.title}</h2>
          {chapter.paragraphs.length > 0 ? (
            chapter.paragraphs.map((text, paragraphIndex) => (
              <p
                key={paragraphIndex}
                className="reader-paragraph"
                data-chapter-index={chapter.meta.index}
                data-paragraph-index={paragraphIndex}
              >
                {text}
              </p>
            ))
          ) : chapter.loading ? (
            <p className="chapter-placeholder">正在加载本章…</p>
          ) : chapter.error ? (
            <p className="chapter-placeholder error">
              本章加载失败：{chapter.error}
              <button className="ghost" onClick={() => onRetryChapter(chapter.meta.index)}>
                重试
              </button>
            </p>
          ) : (
            <p className="chapter-placeholder">本章暂无内容</p>
          )}
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
  const [resizing, setResizing] = useState(false)
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
  // A jump into a lazy network chapter keeps its requested paragraph here
  // until the chapter (and every rendered chapter above it) has loaded.
  const pendingTargetRef = useRef<{ chapterIndex: number; paragraphIndex: number } | null>(null)
  // Set by wheel and keyboard scrolling so handleScroll can tell a real user
  // scroll from the browser clamping scrollTop while placeholders load.
  const userScrollRef = useRef(false)
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
    pendingTargetRef.current = null
    userScrollRef.current = false
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

  const checkedRef = useRef<string | null>(null)
  useEffect(() => {
    if (!book || book.meta.format !== 'network' || !settings.network.autoCheckOnOpen) return
    if (checkedRef.current === book.meta.id) return
    const last = book.meta.network?.lastCheckAt
    if (last && Date.now() - new Date(last).getTime() < 30 * 60 * 1000) return
    checkedRef.current = book.meta.id
    void window.api
      .updateToc(bookId)
      .then(async (result) => {
        if (result.added === 0) return
        setNotice(`目录已更新，新增 ${result.added} 章`)
        const payload = await window.api.openBook(bookId)
        setBook(payload)
        setBookmarks(payload.bookmarks)
      })
      .catch(() => undefined)
  }, [book, bookId, settings.network.autoCheckOnOpen])

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

  // A drawer should not require the × button: clicking the book text (or the
  // progress bar) closes it. The toolbar is excluded so its buttons can switch
  // between drawers directly.
  useEffect(() => {
    if (drawer === null) return
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target instanceof Element ? event.target : null
      if (target?.closest('.reader-drawer, .reader-toolbar')) return
      setDrawer(null)
    }
    window.addEventListener('pointerdown', handlePointerDown)
    return () => window.removeEventListener('pointerdown', handlePointerDown)
  }, [drawer])

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

  const chapterCount = book?.meta.chapters.length ?? 0
  // Only a small window of chapters lives in the DOM: the previous, current
  // and next one. A whole book in flow means every resize or font change
  // reflows tens of thousands of paragraphs, which freezes long books.
  const windowRange = useMemo(
    () => chapterWindow(chapterCount, current.chapterIndex),
    [chapterCount, current.chapterIndex]
  )
  const windowStartRef = useRef(windowRange.start)
  useLayoutEffect(() => {
    windowStartRef.current = windowRange.start
  }, [windowRange.start])
  const pendingAnchorRef = useRef<{ index: number; top: number } | null>(null)

  // Network books keep only metadata in memory: the chapter around the
  // reading position is fetched on demand and cached by the main process.
  const restoreChapterIndex = useMemo(() => {
    if (!book || book.contentMode !== 'lazy' || !book.progress) return -1
    return resolveChapterIndex(book.meta, book.progress.chapterKey, book.progress.chapterIndex)
  }, [book])
  const desiredIndexes = useMemo(() => {
    if (!book || book.contentMode !== 'lazy') return []
    const indexes = paged
      ? [current.chapterIndex]
      : Array.from(
          { length: windowRange.end - windowRange.start },
          (_, offset) => windowRange.start + offset
        )
    if (restoreChapterIndex >= 0 && !indexes.includes(restoreChapterIndex)) {
      indexes.push(restoreChapterIndex)
    }
    return indexes
  }, [book, paged, current.chapterIndex, windowRange.start, windowRange.end, restoreChapterIndex])
  const { texts, states, retry } = useChapterTexts(book, desiredIndexes)

  const chapters = useMemo<ChapterView[]>(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => {
      const raw =
        book.contentMode === 'lazy' ? (texts[index] ?? '') : (book.chapters[index] ?? '')
      const state = states[index]
      // A lazy chapter without text and without an error has simply not been
      // requested yet: show it as loading instead of "本章暂无内容".
      const loading =
        state?.loading ??
        (book.contentMode === 'lazy' && texts[index] === undefined && !state?.error)
      return {
        meta,
        paragraphs: splitParagraphs(raw),
        ...(loading ? { loading: true } : {}),
        ...(state?.error ? { error: state.error } : {})
      }
    })
  }, [book, texts, states])

  const paragraphs = useMemo(() => chapters.map((chapter) => chapter.paragraphs), [chapters])

  // Sliding the window by one chapter removes content above the viewport.
  // Move scrollTop by that amount so the text on screen stays where it is.
  useLayoutEffect(() => {
    const pending = pendingAnchorRef.current
    pendingAnchorRef.current = null
    const scroller = scrollRef.current
    if (!pending || !scroller || paged) return
    const section = scroller.querySelector<HTMLElement>(
      `[data-chapter-section="${pending.index}"]`
    )
    if (!section) return
    const scrollerRect = scroller.getBoundingClientRect()
    const top = section.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop
    const delta = top - pending.top
    if (Math.abs(delta) > 0.5) scroller.scrollTop = Math.max(0, scroller.scrollTop + delta)
  }, [windowRange.start, paged])

  const visibleChapters = useMemo(() => {
    if (!chapters.length) return []
    // Paged mode lays out one chapter at a time; a whole book in columns
    // would force the browser to measure every glyph before the first page.
    if (paged) {
      const chapter = chapters[current.chapterIndex]
      return chapter ? [chapter] : []
    }
    return chapters.slice(windowRange.start, windowRange.end)
  }, [chapters, current.chapterIndex, paged, windowRange.start, windowRange.end])

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

  /** Local books have real character counts; network books count chapters. */
  const percentFor = useCallback(
    (chapterIndex: number, paragraphIndex: number): number => {
      if (!book) return 0
      if (book.contentMode === 'lazy') {
        return percentForChapter(book.meta.chapters.length, chapterIndex)
      }
      return percentAt(book.meta, chapterIndex, paragraphIndex, paragraphs)
    },
    [book, paragraphs]
  )

  const scrollToPosition = useCallback((chapterIndex: number, paragraphIndex: number): void => {
    const attempt = (tries: number): void => {
      const scroller = scrollRef.current
      if (!scroller) return
      const section = scroller.querySelector<HTMLElement>(
        `[data-chapter-section="${chapterIndex}"]`
      )
      if (!section) {
        // The rendered window re-centres on the target first; retry until its
        // section is in the DOM.
        if (tries < 8) window.requestAnimationFrame(() => attempt(tries + 1))
        return
      }
      // Aim at the section first, then align the paragraph once the chapter
      // has been rendered around the new scroll position (a chapter skipped
      // by `content-visibility` only reports its placeholder box).
      const scrollerRect = scroller.getBoundingClientRect()
      const offset = section.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop
      scroller.scrollTop = Math.max(0, offset)
      const applied = scroller.scrollTop
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          if (Math.abs(scroller.scrollTop - applied) > 1) return
          const paragraph = scroller.querySelector<HTMLElement>(
            `[data-chapter-index="${chapterIndex}"][data-paragraph-index="${paragraphIndex}"]`
          )
          const target = paragraph ?? section
          // Matches the scroll-margin-top on paragraphs and chapter titles.
          const margin = paragraph ? 64 : 0
          const drift =
            target.getBoundingClientRect().top - scroller.getBoundingClientRect().top - margin
          if (Math.abs(drift) > 1) {
            scroller.scrollTop = Math.max(0, scroller.scrollTop + drift)
          }
        })
      })
    }
    attempt(0)
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

  /**
   * Applies a jump once its chapter (and, in scroll mode, the chapters above
   * it) are in place. Paged mode may have to render the target chapter first,
   * so it retries across a few frames.
   */
  const applyJump = useCallback(
    (chapterIndex: number, paragraphIndex: number): void => {
      pendingTargetRef.current = null
      if (!pagedRef.current) {
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
    [applyPagedAnchor, scrollToPosition]
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
    const percent = percentFor(position.chapterIndex, position.paragraphIndex)
    const next = { ...position, percent }
    anchorRef.current = position
    setCurrent(next)
    scheduleSave(next)
  }, [book, currentPosition, percentFor, scheduleSave])

  /** Flips one page, crossing into the neighbouring chapter at the ends. */
  const turnPage = useCallback(
    (delta: number): void => {
      // A page turn is user navigation: drop any jump still waiting to land,
      // otherwise it would fire later when the user returns to that chapter.
      pendingTargetRef.current = null
      userScrollRef.current = false
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
          percent: percentFor(chapterIndex, 0)
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
          percent: percentFor(chapterIndex, paragraphIndex)
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
    [book, current.chapterIndex, paragraphs, percentFor, scheduleSave, syncPagedFromView]
  )
  // Wheel and keyboard listeners stay mounted across renders; they read the
  // latest page-turn callback through this ref.
  const turnPageRef = useRef(turnPage)
  turnPageRef.current = turnPage

  /**
   * Jumps to a paragraph in whichever mode is active. A lazy network chapter
   * has no paragraphs until its text arrives, so the requested paragraph is
   * kept as a pending target and applied after the chapter around it loads
   * instead of being clamped against the empty placeholder.
   */
  const goToPosition = useCallback(
    (rawChapterIndex: number, rawParagraphIndex: number): void => {
      if (!book) return
      const chapterIndex = Math.min(
        Math.max(rawChapterIndex, 0),
        book.meta.chapters.length - 1
      )
      const available = paragraphs[chapterIndex]?.length ?? 0
      const paragraphIndex =
        book.contentMode === 'lazy' && available === 0
          ? Math.max(rawParagraphIndex, 0)
          : Math.min(Math.max(rawParagraphIndex, 0), Math.max(0, available - 1))
      const percent = percentFor(chapterIndex, paragraphIndex)
      const next = { chapterIndex, paragraphIndex, percent }
      anchorRef.current = { chapterIndex, paragraphIndex }
      setCurrent(next)
      scheduleSave(next)
      if (book.contentMode === 'lazy') {
        pendingTargetRef.current = { chapterIndex, paragraphIndex }
        userScrollRef.current = false
        // The settle effect only fires when a chapter state changes, so a
        // jump whose chapters are all loaded already is applied right away.
        const targetStart = chapterWindow(book.meta.chapters.length, chapterIndex).start
        const settled = (index: number): boolean =>
          texts[index] !== undefined || Boolean(states[index]?.error)
        let ready = settled(chapterIndex)
        if (ready && !paged) {
          for (let index = targetStart; index < chapterIndex; index++) {
            if (!settled(index)) {
              ready = false
              break
            }
          }
        }
        if (ready) applyJump(chapterIndex, paragraphIndex)
        return
      }
      applyJump(chapterIndex, paragraphIndex)
    },
    [applyJump, book, paged, paragraphs, percentFor, scheduleSave, states, texts]
  )

  const handleScroll = useCallback((): void => {
    // A pointer, touch, wheel or keyboard gesture marks the scroll events it
    // produces as user input. Scrolls with no gesture behind them are the
    // browser clamping scrollTop while placeholders load; they must neither
    // cancel a pending jump nor rewrite the position being jumped to. The
    // intent is consumed by the first scroll event so it cannot leak into
    // later programmatic scrolls.
    const userIntent = userScrollRef.current
    userScrollRef.current = false
    if (pendingTargetRef.current) {
      if (!userIntent) return
      pendingTargetRef.current = null
    }
    if (rafRef.current !== 0) return
    rafRef.current = window.requestAnimationFrame(() => {
      rafRef.current = 0
      if (!book) return
      const position = currentPosition()
      if (!position) return
      const percent = percentFor(position.chapterIndex, position.paragraphIndex)
      const next = { ...position, percent }
      // Crossing a chapter boundary slides the rendered window. Remember where
      // a chapter that stays in the DOM sits, so the effect after the re-render
      // can keep it under the reader's eyes.
      const nextStart = pagedRef.current
        ? windowStartRef.current
        : chapterWindow(book.meta.chapters.length, position.chapterIndex).start
      if (nextStart !== windowStartRef.current) {
        const scroller = scrollRef.current
        // Anchor on the first chapter present both before and after the slide:
        // the new window's start when moving forward, the current start when
        // moving backward (the chapter being prepended is not in the DOM yet).
        const anchorIndex = Math.max(nextStart, windowStartRef.current)
        const section = scroller?.querySelector<HTMLElement>(
          `[data-chapter-section="${anchorIndex}"]`
        )
        if (scroller && section) {
          const scrollerRect = scroller.getBoundingClientRect()
          pendingAnchorRef.current = {
            index: anchorIndex,
            top: section.getBoundingClientRect().top - scrollerRect.top + scroller.scrollTop
          }
        }
      }
      anchorRef.current = position
      setCurrent(next)
      scheduleSave(next)
    })
  }, [book, currentPosition, percentFor, scheduleSave])

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

  const restoreReady =
    !book ||
    book.contentMode !== 'lazy' ||
    restoreChapterIndex < 0 ||
    texts[restoreChapterIndex] !== undefined ||
    Boolean(states[restoreChapterIndex]?.error)

  useEffect(() => {
    if (!book || chapters.length === 0 || restoredRef.current || !restoreReady) return
    restoredRef.current = true
    const saved = book.progress
    const chapterIndex = saved
      ? resolveChapterIndex(book.meta, saved.chapterKey, saved.chapterIndex)
      : 0
    const paragraphIndex = saved?.paragraphIndex ?? 0
    const percent = percentFor(chapterIndex, paragraphIndex)
    const next = { chapterIndex, paragraphIndex, percent }
    anchorRef.current = { chapterIndex, paragraphIndex }
    setCurrent(next)
    scheduleSave(next)
    if (book.contentMode === 'lazy') {
      // The target text is already here; the settle effect below waits for
      // the chapters above it before scrolling.
      pendingTargetRef.current = { chapterIndex, paragraphIndex }
      userScrollRef.current = false
      return
    }
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => {
        if (pagedRef.current) goToPosition(chapterIndex, paragraphIndex)
        else scrollToPosition(chapterIndex, paragraphIndex)
      })
    })
  }, [
    book,
    chapters.length,
    percentFor,
    restoreReady,
    scheduleSave,
    scrollToPosition,
    goToPosition
  ])

  // A jump into a lazy network chapter waits until the target text has
  // arrived and every rendered chapter above it has settled: a placeholder
  // that grows later would drag the target out of view.
  useEffect(() => {
    const target = pendingTargetRef.current
    if (!target) return
    const { chapterIndex, paragraphIndex } = target
    if (windowRange.start !== chapterWindow(chapterCount, chapterIndex).start) return
    const settled = (index: number): boolean =>
      texts[index] !== undefined || Boolean(states[index]?.error)
    if (!settled(chapterIndex)) return
    if (!paged) {
      for (let index = windowRange.start; index < chapterIndex; index++) {
        if (!settled(index)) return
      }
    }
    applyJump(chapterIndex, paragraphIndex)
  }, [texts, states, paged, windowRange.start, chapterCount, applyJump])

  // A page is recomputed whenever the chapter, the mode, the typography or
  // the loaded text changes. The anchor paragraph keeps the reading spot
  // across the reflow, and a lazy chapter that just replaced its placeholder
  // gets re-measured into real pages. Runs before paint so the new chapter
  // never flashes its first page.
  useLayoutEffect(() => {
    if (!paged || !book) return
    applyPagedAnchor(anchorRef.current)
  }, [paged, book, current.chapterIndex, settings.typography, paragraphs, applyPagedAnchor])

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
        // A consumed wheel is user navigation; clear the target even when
        // this notch moves zero lines (no scroll event will follow).
        pendingTargetRef.current = null
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
      // A consumed wheel is user navigation; clear the target even when this
      // notch moves zero pixels (no scroll event will follow).
      pendingTargetRef.current = null
      scroller.scrollTop += event.deltaY * WHEEL_DISTANCE_SCALE
    }

    target.addEventListener('wheel', handleWheel, { passive: false })
    return () => target.removeEventListener('wheel', handleWheel)
  }, [book, style, paged])

  // Pointer and touch gestures (scrollbar drag, touch scrolling, selection
  // auto-scroll) move the view without a wheel event. Mark them as user
  // intent so handleScroll accepts the scrolls they produce while a jump is
  // pending instead of mistaking them for the browser's scrollTop clamp.
  useEffect(() => {
    const scroller = scrollRef.current
    if (!scroller) return
    const start = (): void => {
      userScrollRef.current = true
    }
    const end = (): void => {
      userScrollRef.current = false
    }
    scroller.addEventListener('pointerdown', start)
    scroller.addEventListener('touchstart', start, { passive: true })
    scroller.addEventListener('pointerup', end)
    scroller.addEventListener('pointercancel', end)
    scroller.addEventListener('touchend', end, { passive: true })
    scroller.addEventListener('touchcancel', end, { passive: true })
    return () => {
      scroller.removeEventListener('pointerdown', start)
      scroller.removeEventListener('touchstart', start)
      scroller.removeEventListener('pointerup', end)
      scroller.removeEventListener('pointercancel', end)
      scroller.removeEventListener('touchend', end)
      scroller.removeEventListener('touchcancel', end)
    }
  }, [book, style, paged])

  const seek = (percent: number): void => {
    if (!book) return
    if (book.contentMode === 'lazy') {
      goToPosition(chapterForPercent(book.meta.chapters.length, percent), 0)
      return
    }
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
      userScrollRef.current = true
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

  // 网络书没有真实字数：按每章约 3000 字估算剩余时间。
  const remainingMinutes =
    book.contentMode === 'lazy'
      ? Math.max(0, Math.ceil(((book.meta.chapters.length - current.chapterIndex) * 3000) / 400))
      : Math.max(
          0,
          Math.ceil(
            (totalChars(book.meta) -
              charsBefore(book.meta, current.chapterIndex, current.paragraphIndex, paragraphs)) /
              400
          )
        )

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

      {(style === 'transparent' || style === 'code') && <WindowResizeHandles onResizeSession={setResizing} />}

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
              <ReaderBody chapters={visibleChapters} resizing={resizing} onRetryChapter={retry} />
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
          <ReaderBody chapters={visibleChapters} resizing={resizing} onRetryChapter={retry} />
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
