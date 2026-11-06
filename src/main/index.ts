import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  globalShortcut,
  ipcMain,
  Menu,
  screen
} from 'electron'
import type { MessageBoxOptions, OpenDialogOptions, Rectangle, WebContents } from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, BookProgress } from '../core/model'
import type { SupportedEncoding } from '../shared/encodings'
import type {
  AddNetworkBookInput,
  CleaningConfig,
  NetworkSearchRequest,
  NewBookmark,
  SourceImportRequest,
  StartupNotice
} from '../shared/api'
import type { SettingsPatch } from '../shared/settings'
import { disguiseWindowKind } from '../shared/settings'
import { isDarkBitmap } from './services/backdrop'
import { BackupService } from './services/backup'
import { CleaningService } from './services/cleaning'
import { ImportService } from './services/import'
import { formatFileSize, ImportQueue } from './services/importQueue'
import { LibraryService } from './services/library'
import { Logger } from './services/logger'
import { MergeService } from './services/merge'
import { NetworkBookService } from './services/network/bookService'
import { HttpClient } from './services/network/httpClient'
import { NetworkSearchService } from './services/network/searchService'
import { SourceReader } from './services/network/sourceReader'
import { SourceService } from './services/network/sourceService'
import { SourceStore } from './services/network/sourceStore'
import { resolveDataDir } from './services/paths'
import { ReaderService } from './services/reader'
import { ReprocessService } from './services/reprocess'
import { SearchService } from './services/search'
import { resizeBounds, sameBounds } from './services/windowResize'
import type { WindowResizeEdge } from './services/windowResize'
import { BookRepository } from './storage/book'
import { LibraryRepository } from './storage/library'
import { NetworkBookRepository } from './storage/networkBook'
import { RuleRepository } from './storage/rules'
import { SettingsRepository } from './storage/settings'
import { clampWindowState } from './windowBounds'

// Development only: expose the Chrome DevTools Protocol so automated checks
// can drive the window. Packaged builds never enable it.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

// Automated acceptance runs use an offscreen window and must never touch the
// user's desktop or the real window state. The mode is also honored by a
// packaged build so the portable exe can be smoke-tested without a window.
const ACCEPTANCE = process.env.READER_ACCEPTANCE === '1'
let acceptanceFullscreen = false

const dataDir = resolveDataDir()
// Keep Chromium's cache and local storage beside the books so copying the
// portable folder migrates everything, and acceptance runs leave %APPDATA%
// untouched. Must happen before the single-instance lock reads userData.
if (app.isPackaged || process.env.PORTABLE_EXECUTABLE_DIR) {
  app.setPath('userData', join(dataDir, 'userData'))
}
const logger = new Logger(dataDir)

// A second launch should bring the existing window forward instead of opening
// a second reader over the same data directory. Acceptance runs bypass the
// lock so they can coexist with a normally running app.
const hasSingleInstanceLock = ACCEPTANCE || app.requestSingleInstanceLock()
if (!hasSingleInstanceLock) app.quit()

process.on('uncaughtException', (error) => {
  logger.error('uncaughtException', error)
  if (!ACCEPTANCE) {
    dialog.showErrorBox(
      '出错了',
      '应用遇到问题，已记录日志到 data/logs/app.log。请重启后重试。'
    )
  }
  app.quit()
})
process.on('unhandledRejection', (reason) => {
  logger.error('unhandledRejection', reason)
})

const library = new LibraryRepository(dataDir)
const books = new BookRepository(dataDir)
const settingsRepo = new SettingsRepository(dataDir)
const rulesRepo = new RuleRepository(dataDir)
const cleaning = new CleaningService(settingsRepo, rulesRepo, library, books)
const networkBooks = new NetworkBookRepository(dataDir)
const networkHttp = new HttpClient()
const sourceStore = new SourceStore(dataDir)
const sourceService = new SourceService(sourceStore, networkHttp, library)
const sourceReader = new SourceReader(networkHttp)
const networkBookService = new NetworkBookService({
  root: dataDir,
  sources: sourceService,
  reader: sourceReader,
  networkBooks,
  books,
  library,
  cleaning: () => cleaning.currentRunConfig(),
  // 关闭联网后，加入书架/更新目录/下载/拉未缓存章节都在服务层被拒绝；
  // 已缓存章节仍然可读（readChapter 先查缓存再过这个门）。
  allowNetwork: () => settingsRepo.readSync().network.enabled
})
const networkSearch = new NetworkSearchService(sourceService, sourceStore, sourceReader, library)
const importer = new ImportService(library, books, () => cleaning.currentRunConfig())
const reader = new ReaderService(library, books, networkBooks)
const search = new SearchService(books, networkBooks)
const merger = new MergeService(library, books)
const libraryService = new LibraryService(library, books)
const reprocess = new ReprocessService(library, books, () => cleaning.currentRunConfig())
const backup = new BackupService(library, books)
let startupNotice: StartupNotice = { libraryRestored: false }
const importQueue = new ImportQueue(importer, {
  confirmLargeFile: async ({ fileName, size }) => {
    if (ACCEPTANCE) return true
    const win = BrowserWindow.getFocusedWindow()
    const options: MessageBoxOptions = {
      type: 'question',
      buttons: ['继续导入', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '导入较大的文件',
      message: `${fileName} 有 ${formatFileSize(size)}`,
      detail: '较大的文件解析需要一些时间，继续导入吗？'
    }
    const result = win
      ? await dialog.showMessageBox(win, options)
      : await dialog.showMessageBox(options)
    return result.response === 0
  }
})

function sendImportProgress(
  sender: WebContents,
  payload: { fileName: string; stage: string }
): void {
  if (!sender.isDestroyed()) sender.send('import:progress', payload)
}

type WindowKind = ReturnType<typeof disguiseWindowKind>

let mainWindow: BrowserWindow | null = null
let windowKind: WindowKind = 'normal'
let currentBookId: string | null = null
let registeredBossKey: string | null = null
let slackingSettings: AppSettings['slacking'] | null = null
let swapping = false
let flushResolver: (() => void) | null = null
let backdropTimer: NodeJS.Timeout | null = null
let backdropMoveTimer: NodeJS.Timeout | null = null
let backdropBusy = false
let backdropErrorLogged = false

/** The window kind the saved settings ask for, given what the renderer shows. */
function desiredWindowKind(settings: AppSettings, bookId: string | null): WindowKind {
  return disguiseWindowKind(settings.slacking.disguise, bookId !== null)
}

/** Disguise windows may shrink far below the reader's comfortable minimum. */
function minWindowSize(kind: WindowKind): { width: number; height: number } {
  if (kind === 'transparent') return { width: 120, height: 80 }
  // 300px leaves 12 comment lines plus a code line above and below.
  if (kind === 'code') return { width: 300, height: 300 }
  return { width: 800, height: 600 }
}

interface ResizeSession {
  win: BrowserWindow
  edge: WindowResizeEdge
  screenX: number
  screenY: number
  bounds: Rectangle
  min: { width: number; height: number }
  max: { width: number; height: number }
  /** Last bounds handed to setBounds; identical moves are dropped. */
  last: Rectangle | null
}

const RESIZE_EDGES: WindowResizeEdge[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']

function isResizeEdge(value: unknown): value is WindowResizeEdge {
  return typeof value === 'string' && RESIZE_EDGES.includes(value as WindowResizeEdge)
}

function isScreenPoint(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** The virtual desktop, used as a hard cap on runaway custom resizing. */
function desktopSize(): { width: number; height: number } {
  const displays = screen.getAllDisplays()
  if (displays.length === 0) return { width: 3840, height: 2160 }
  const left = Math.min(...displays.map((display) => display.bounds.x))
  const top = Math.min(...displays.map((display) => display.bounds.y))
  const right = Math.max(...displays.map((display) => display.bounds.x + display.bounds.width))
  const bottom = Math.max(...displays.map((display) => display.bounds.y + display.bounds.height))
  return { width: right - left, height: bottom - top }
}

let resizeSession: ResizeSession | null = null

function toggleBossKey(): void {
  const win = mainWindow
  if (!win || win.isDestroyed()) return
  if (slackingSettings?.bossKeyAction === 'minimize') {
    if (win.isMinimized()) {
      win.restore()
      win.show()
      win.focus()
    } else {
      win.minimize()
    }
    return
  }
  if (win.isVisible()) {
    win.hide()
  } else {
    win.show()
    win.focus()
  }
}

function registerBossKey(settings: AppSettings['slacking']): void {
  if (registeredBossKey) {
    globalShortcut.unregister(registeredBossKey)
    registeredBossKey = null
  }
  // Acceptance runs must never grab keys on the user's desktop.
  if (ACCEPTANCE || !settings.bossKey) return
  try {
    if (globalShortcut.register(settings.bossKey, toggleBossKey)) {
      registeredBossKey = settings.bossKey
    } else {
      logger.info(`boss key registration failed: ${settings.bossKey}`)
    }
  } catch (error) {
    logger.info(`boss key registration error: ${String(error)}`)
  }
}

function stopBackdropSampling(): void {
  if (backdropTimer) {
    clearInterval(backdropTimer)
    backdropTimer = null
  }
  if (backdropMoveTimer) {
    clearTimeout(backdropMoveTimer)
    backdropMoveTimer = null
  }
}

/** Re-measures after the window settles, so dragging does not capture every frame. */
function scheduleBackdropSample(): void {
  if (ACCEPTANCE || windowKind !== 'transparent') return
  if (backdropMoveTimer) clearTimeout(backdropMoveTimer)
  backdropMoveTimer = setTimeout(() => {
    backdropMoveTimer = null
    void sampleBackdrop()
  }, 250)
}

function updateBackdropSampling(): void {
  stopBackdropSampling()
  if (ACCEPTANCE || windowKind !== 'transparent') return
  backdropErrorLogged = false
  void sampleBackdrop()
  backdropTimer = setInterval(() => void sampleBackdrop(), 2000)
  backdropTimer.unref()
}

/**
 * Reads the desktop behind a transparent window and tells the renderer which
 * text colour to use. Only a small thumbnail is captured, and only while the
 * transparent disguise is active.
 */
async function sampleBackdrop(): Promise<void> {
  const win = mainWindow
  if (
    ACCEPTANCE ||
    backdropBusy ||
    windowKind !== 'transparent' ||
    !win ||
    win.isDestroyed() ||
    win.webContents.isDestroyed() ||
    !win.isVisible()
  ) {
    return
  }
  backdropBusy = true
  try {
    const bounds = win.getBounds()
    const display = screen.getDisplayMatching(bounds)
    const displayBounds = display.bounds
    if (displayBounds.width <= 0 || displayBounds.height <= 0) return
    const thumbWidth = 320
    const thumbHeight = Math.max(
      1,
      Math.round((thumbWidth * displayBounds.height) / displayBounds.width)
    )
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: thumbWidth, height: thumbHeight }
    })
    const source =
      sources.find((candidate) => candidate.display_id === String(display.id)) ?? sources[0]
    if (!source || source.thumbnail.isEmpty()) return
    const thumb = source.thumbnail.getSize()
    if (thumb.width <= 0 || thumb.height <= 0) return
    const scaleX = thumb.width / displayBounds.width
    const scaleY = thumb.height / displayBounds.height
    const x = Math.max(
      0,
      Math.min(thumb.width - 1, Math.round((bounds.x - displayBounds.x) * scaleX))
    )
    const y = Math.max(
      0,
      Math.min(thumb.height - 1, Math.round((bounds.y - displayBounds.y) * scaleY))
    )
    const width = Math.max(1, Math.min(thumb.width - x, Math.round(bounds.width * scaleX)))
    const height = Math.max(1, Math.min(thumb.height - y, Math.round(bounds.height * scaleY)))
    const cropped = source.thumbnail.crop({ x, y, width, height })
    const dark = isDarkBitmap(cropped.toBitmap())
    if (mainWindow !== win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send('slacking:backdrop', { dark })
  } catch (error) {
    if (!backdropErrorLogged) {
      backdropErrorLogged = true
      logger.info(`backdrop sample failed: ${String(error)}`)
    }
  } finally {
    backdropBusy = false
  }
}

function applySlackingSettings(settings: AppSettings['slacking']): void {
  slackingSettings = settings
  const win = mainWindow
  if (win && !win.isDestroyed()) {
    win.setOpacity(settings.opacity)
    win.setAlwaysOnTop(settings.alwaysOnTop)
  }
  registerBossKey(settings)
  updateBackdropSampling()
}

/** Asks the old renderer to persist its reading position before the swap. */
function requestFlush(win: BrowserWindow): Promise<void> {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return Promise.resolve()
  return new Promise((resolve) => {
    let settled = false
    const finish = (): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (flushResolver === finish) flushResolver = null
      resolve()
    }
    const timer = setTimeout(finish, 600)
    flushResolver = finish
    win.webContents.send('app:flush-request')
  })
}

/**
 * Replaces the window because `transparent` and `frame` can only be set in the
 * constructor. The new window is created hidden, opens the same book, and
 * destroys the old one once it has painted, so the swap never shows a blank
 * frame.
 */
async function swapWindow(
  settings: AppSettings,
  bookId: string | null,
  flush: boolean
): Promise<void> {
  if (swapping) return
  const old = mainWindow
  if (!old || old.isDestroyed()) {
    createWindow(settings, bookId)
    return
  }
  swapping = true
  try {
    const oldKind = windowKind
    const bounds = old.getNormalBounds()
    // A transparent window cannot be maximized; keep the flag from the normal
    // window so the reader comes back maximized when the disguise ends.
    const maximized = oldKind === 'transparent' ? settings.window.maximized : old.isMaximized()
    const nextSettings = ACCEPTANCE
      ? settings
      : await settingsRepo.update({ window: { ...bounds, maximized } })
    if (flush) await requestFlush(old)
    createWindow(nextSettings, bookId, () => {
      if (!old.isDestroyed()) old.destroy()
    })
    // If the new renderer never paints, do not strand the old window forever.
    setTimeout(() => {
      if (!old.isDestroyed()) old.destroy()
    }, 5000).unref()
  } finally {
    swapping = false
  }
}

function createWindow(
  settings: AppSettings,
  bookId: string | null = null,
  onReady?: () => void
): BrowserWindow {
  const windowState = settings.window
  const primary = screen.getPrimaryDisplay()
  const clamped = ACCEPTANCE
    ? windowState
    : clampWindowState(windowState, [
        primary.workArea,
        ...screen
          .getAllDisplays()
          .filter((display) => display.id !== primary.id)
          .map((display) => display.workArea)
      ])
  const kind = desiredWindowKind(settings, bookId)
  // The library always keeps a normal frame; the disguise only applies while a
  // book is open.
  const disguise = bookId ? settings.slacking.disguise : 'none'
  const win = new BrowserWindow({
    width: clamped.width,
    height: clamped.height,
    x: ACCEPTANCE ? -20000 : clamped.x,
    y: ACCEPTANCE ? -20000 : clamped.y,
    show: false,
    skipTaskbar: ACCEPTANCE,
    focusable: !ACCEPTANCE,
    frame: kind === 'normal',
    transparent: kind === 'transparent',
    resizable: kind !== 'transparent',
    hasShadow: kind !== 'transparent',
    backgroundColor:
      kind === 'transparent' ? '#00000000' : kind === 'code' ? '#121314' : '#f5f3ee',
    opacity: settings.slacking.opacity,
    alwaysOnTop: settings.slacking.alwaysOnTop,
    ...(app.isPackaged ? {} : { icon: join(__dirname, '../../build/icon.png') }),
    minWidth: minWindowSize(kind).width,
    minHeight: minWindowSize(kind).height,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: ACCEPTANCE,
      backgroundThrottling: !ACCEPTANCE
    }
  })

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    logger.info(`blocked navigation: ${url}`)
  })
  win.webContents.on('render-process-gone', (_event, details) => {
    logger.error('render-process-gone', JSON.stringify(details))
  })

  let ready = false
  const announceReady = (): void => {
    if (ready) return
    ready = true
    onReady?.()
  }
  win.once('ready-to-show', () => {
    if (!ACCEPTANCE) win.show()
    announceReady()
  })
  // Offscreen acceptance windows still paint, but did-finish-load is the
  // reliable signal for the harness to find the new page.
  if (ACCEPTANCE) win.webContents.once('did-finish-load', announceReady)

  if (ACCEPTANCE) {
    win.webContents.setFrameRate(30)
  } else if (clamped.maximized && kind !== 'transparent') {
    win.maximize()
  }
  if (!ACCEPTANCE) {
    win.on('close', () => {
      if (kind === 'transparent') {
        settingsRepo.updateSync({
          window: { ...win.getBounds(), maximized: settings.window.maximized }
        })
        return
      }
      settingsRepo.updateSync({
        window: { ...win.getNormalBounds(), maximized: win.isMaximized() }
      })
    })
  }
  win.on('move', scheduleBackdropSample)
  win.on('resize', scheduleBackdropSample)
  win.on('show', scheduleBackdropSample)
  mainWindow = win
  windowKind = kind
  win.on('closed', () => {
    if (resizeSession?.win === win) resizeSession = null
    if (mainWindow !== win) return
    mainWindow = null
    stopBackdropSampling()
  })
  applySlackingSettings(settings.slacking)

  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL)
    if (bookId) {
      url.searchParams.set('bookId', bookId)
      url.searchParams.set('style', disguise)
      // The reading mode rides along so a swapped window paints the same layout
      // immediately instead of scrolling for a frame before the settings load.
      url.searchParams.set('mode', settings.readingMode)
    }
    void win.loadURL(url.toString())
  } else {
    void win.loadFile(
      join(__dirname, '../renderer/index.html'),
      bookId ? { query: { bookId, style: disguise, mode: settings.readingMode } } : undefined
    )
  }
  return win
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const win = mainWindow ?? BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(async () => {
    const repair = await library.repair()
    startupNotice = { libraryRestored: repair.restored }
    if (repair.restored) logger.info('library.json restored from backup')
    const sourcesRestored = await sourceService.repair()
    if (sourcesRestored) logger.info('sources.json restored from backup')
    logger.info(
      `app start version=${app.getVersion()} packaged=${app.isPackaged} data=${dataDir}`
    )
    const settings = await settingsRepo.read()

    ipcMain.handle('app:ping', () => 'pong')
    ipcMain.handle('app:startup-notice', () => startupNotice)
    ipcMain.handle('settings:get', () => settingsRepo.read())
    ipcMain.handle('settings:update', async (event, patch: SettingsPatch) => {
      const saved = await settingsRepo.update(patch)
      // Only window-level slacking settings need to be pushed to Electron; a
      // font-size drag should not re-register the boss key on every tick.
      if (patch?.slacking) {
        const desired = desiredWindowKind(saved, currentBookId)
        if (BrowserWindow.fromWebContents(event.sender) === mainWindow && desired !== windowKind) {
          await swapWindow(saved, currentBookId, currentBookId !== null)
        } else {
          applySlackingSettings(saved.slacking)
        }
      }
      return saved
    })
    // Told by the old renderer after it has persisted its reading position,
    // right before a disguise window swap destroys it.
    ipcMain.on('app:flush-done', (event) => {
      if (event.sender === mainWindow?.webContents) flushResolver?.()
    })
    ipcMain.handle('app:view-state', async (event, bookId: unknown) => {
      if (BrowserWindow.fromWebContents(event.sender) !== mainWindow) return
      const nextBookId = typeof bookId === 'string' && bookId.length > 0 ? bookId : null
      const previousBookId = currentBookId
      currentBookId = nextBookId
      const saved = await settingsRepo.read()
      // Another view change landed while settings were loading; that one owns
      // the next swap.
      if (currentBookId !== nextBookId) return
      const desired = desiredWindowKind(saved, nextBookId)
      if (desired !== windowKind) {
        // Closing the book also leaves the reader, and that unmount already
        // flushes; only a style change needs the handshake.
        await swapWindow(saved, nextBookId, previousBookId !== null && nextBookId !== null)
      }
    })
    ipcMain.handle('window:toggle-fullscreen', (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      if (!win) return false
      // Development only: an offscreen acceptance window must never be pulled
      // onto the user's screen, so report a virtual toggle instead.
      if (ACCEPTANCE) {
        acceptanceFullscreen = !acceptanceFullscreen
        return acceptanceFullscreen
      }
      const next = !win.isFullScreen()
      win.setFullScreen(next)
      return next
    })
    // Frameless disguise windows (especially transparent ones) do not get a
    // reliable native resize border, so the renderer's edge handles drive
    // setBounds themselves.
    ipcMain.on(
      'window:resize-start',
      (event, payload: { edge?: unknown; screenX?: unknown; screenY?: unknown }) => {
        const win = BrowserWindow.fromWebContents(event.sender)
        const edge = payload?.edge
        if (!win || win !== mainWindow || !isResizeEdge(edge)) return
        if (!isScreenPoint(payload?.screenX) || !isScreenPoint(payload?.screenY)) return
        resizeSession = {
          win,
          edge,
          screenX: payload.screenX,
          screenY: payload.screenY,
          bounds: win.getBounds(),
          min: minWindowSize(windowKind),
          max: desktopSize(),
          last: null
        }
      }
    )
    ipcMain.on(
      'window:resize-move',
      (event, payload: { screenX?: unknown; screenY?: unknown }) => {
        const session = resizeSession
        if (
          !session ||
          session.win.isDestroyed() ||
          BrowserWindow.fromWebContents(event.sender) !== session.win ||
          !isScreenPoint(payload?.screenX) ||
          !isScreenPoint(payload?.screenY)
        ) {
          return
        }
        const next = resizeBounds(
          session.bounds,
          session.edge,
          payload.screenX - session.screenX,
          payload.screenY - session.screenY,
          session.min,
          session.max
        )
        // Dropping identical bounds breaks the feedback loop where resizing
        // the window re-sends a pointer move and schedules another resize.
        if (session.last && sameBounds(session.last, next)) return
        session.last = next
        session.win.setBounds(next)
      }
    )
    ipcMain.on('window:resize-end', (event) => {
      if (resizeSession && BrowserWindow.fromWebContents(event.sender) === resizeSession.win) {
        resizeSession = null
      }
    })
    ipcMain.handle('library:list', () => library.list())
    // 关闭联网后，需要访问网络的入口在进程内拒绝；缓存阅读和本地导入不受影响。
    const assertNetworkEnabled = (): void => {
      if (!settingsRepo.readSync().network.enabled) {
        throw new Error('已关闭联网功能，请到设置里打开后再搜索/更新/下载')
      }
    }
    ipcMain.handle('source:list', () => sourceService.list())
    ipcMain.handle('source:import', async (event, request: SourceImportRequest) => {
      if (request.kind === 'json') {
        const result = await sourceService.importJson(request.json, request.dryRun)
        await networkBookService.relinkSources()
        return result
      }
      if (request.kind === 'url') {
        assertNetworkEnabled()
        const result = await sourceService.importUrl(request.url)
        await networkBookService.relinkSources()
        return result
      }
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: '书源 JSON', extensions: ['json', 'txt'] }]
      }
      const selection = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length === 0) {
        return { added: 0, updated: 0, rejected: [], warnings: ['已取消'] }
      }
      const text = await readFile(selection.filePaths[0], 'utf8')
      const result = await sourceService.importJson(text, request.dryRun)
      await networkBookService.relinkSources()
      return result
    })
    ipcMain.handle('source:flags', async (_event, id: unknown, flags: unknown) => {
      if (typeof id !== 'string' || !flags || typeof flags !== 'object') {
        throw new Error('无效的书源参数')
      }
      const result = await sourceService.setFlags(
        id,
        flags as { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
      )
      if ((flags as { enabled?: unknown }).enabled === false) {
        await networkBookService.cancelSourceTasks(id, 'source-disabled')
        networkSearch.cancelSource(id)
      }
      return result
    })
    ipcMain.handle('source:raw', (_event, id: unknown) =>
      typeof id === 'string' ? sourceService.raw(id) : Promise.reject(new Error('无效的书源编号'))
    )
    ipcMain.handle('source:delete', async (_event, id: unknown) => {
      if (typeof id !== 'string') throw new Error('无效的书源编号')
      await networkBookService.cancelSourceTasks(id, 'source-deleted')
      networkSearch.cancelSource(id)
      await sourceService.remove(id)
    })
    ipcMain.handle('network:search', (event, request: NetworkSearchRequest) => {
      assertNetworkEnabled()
      const win = BrowserWindow.fromWebContents(event.sender)
      const send = (channel: string, payload: unknown): void => {
        if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
      }
      return networkSearch
        .search(request, {
          source: (payload) => send('network:search-source', payload),
          results: (payload) =>
            send('network:search-results', {
              requestId: request.requestId,
              ...payload,
              scope: request.scope
            })
        })
        .then((done) => {
          send('network:search-done', done)
          return done
        })
        .catch((reason) => {
          send('network:search-error', {
            requestId: request.requestId,
            message: reason instanceof Error ? reason.message : '搜索失败'
          })
          throw reason
        })
    })
    ipcMain.handle('network:search-cancel', (_event, requestId: string) => {
      networkSearch.cancel(requestId)
    })
    ipcMain.handle('network:add-book', (_event, input: AddNetworkBookInput) =>
      networkBookService.add(input)
    )
    ipcMain.handle('network:update-toc', (event, id: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return networkBookService.updateToc(id).then((result) => {
        if (win && !win.isDestroyed()) {
          win.webContents.send('network:toc-updated', {
            id,
            added: result.added,
            total: result.total
          })
        }
        return result
      })
    })
    ipcMain.handle('network:download-all', (event, id: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return networkBookService
        .downloadAll(id, (payload) => {
          if (win && !win.isDestroyed()) win.webContents.send('network:download-progress', payload)
        })
        .then((result) => {
          if (win && !win.isDestroyed()) win.webContents.send('network:download-done', result)
          return result
        })
    })
    ipcMain.handle('network:download-cancel', (_event, id: string) => {
      networkBookService.cancelDownload(id)
    })
    ipcMain.handle('network:read-chapter', (_event, id: string, index: number) =>
      networkBookService.readChapter(id, index)
    )
    ipcMain.handle('network:convert', (_event, id: string) =>
      networkBookService.convertToLocal(id)
    )
    ipcMain.handle('book:cover', async (_event, id: unknown) => {
      if (typeof id !== 'string') return null
      const cover = await books.readCover(id)
      return cover ? `data:${cover.mime};base64,${cover.data.toString('base64')}` : null
    })
    ipcMain.handle('library:find-merges', (_event, ids: unknown) => {
      const safeIds = Array.isArray(ids)
        ? ids.filter((id): id is string => typeof id === 'string')
        : []
      return libraryService.findMerges(safeIds)
    })
    ipcMain.handle('library:choose-import', async (event) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: '书籍文件', extensions: ['txt', 'epub'] }]
      }
      const selection = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)

      if (selection.canceled || selection.filePaths.length === 0) {
        return {
          imported: 0,
          importedBooks: [],
          duplicates: [],
          suspects: [],
          errors: [],
          warnings: [],
          canceled: true
        }
      }

      return importQueue.importFiles(selection.filePaths, (payload) =>
        sendImportProgress(event.sender, payload)
      )
    })
    ipcMain.handle('library:import-paths', (event, paths: unknown) => {
      const safePaths = Array.isArray(paths)
        ? paths.filter((path): path is string => typeof path === 'string')
        : []
      return importQueue.importFiles(safePaths, (payload) =>
        sendImportProgress(event.sender, payload)
      )
    })
    ipcMain.handle('book:open', (_event, id: string) => reader.open(id))
    ipcMain.handle('progress:save', (_event, id: string, progress: BookProgress) =>
      reader.saveProgress(id, progress)
    )
    ipcMain.handle('bookmark:add', (_event, id: string, bookmark: NewBookmark) =>
      reader.addBookmark(id, bookmark)
    )
    ipcMain.handle('bookmark:remove', (_event, id: string, bookmarkId: string) =>
      reader.removeBookmark(id, bookmarkId)
    )
    ipcMain.handle('import:resolve', (_event, targetId: string, sourceId: string) =>
      merger.merge(targetId, sourceId)
    )
    ipcMain.handle('library:remove', async (_event, id: string) => {
      networkBookService.cancelBookTasks(id)
      await libraryService.remove(id)
    })
    ipcMain.handle('backup:list', (_event, id: unknown) =>
      typeof id === 'string' ? backup.list(id) : Promise.reject(new Error('无效的书籍编号'))
    )
    ipcMain.handle('backup:restore', (_event, id: unknown, name: unknown) =>
      typeof id === 'string' && typeof name === 'string'
        ? backup.restore(id, name)
        : Promise.reject(new Error('无效的备份编号'))
    )
    ipcMain.handle('book:reclean', (_event, id: string) => reprocess.reclean(id))
    ipcMain.handle('book:resplit', (_event, id: string) => reprocess.resplit(id))
    ipcMain.handle('book:chapter-lines', (_event, id: string) => reprocess.chapterLines(id))
    ipcMain.handle('book:apply-chapter-starts', (_event, id: string, starts: number[]) =>
      reprocess.applyChapterStarts(id, starts)
    )
    ipcMain.handle('book:encoding-preview', (_event, id: string, encoding: SupportedEncoding) =>
      reprocess.encodingPreview(id, encoding)
    )
    ipcMain.handle('book:apply-encoding', (_event, id: string, encoding: SupportedEncoding) =>
      reprocess.applyEncoding(id, encoding)
    )
    ipcMain.handle('book:attach-original', async (event, id: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      const options: OpenDialogOptions = {
        properties: ['openFile'],
        filters: [{ name: '文本文件', extensions: ['txt'] }]
      }
      const selection = win
        ? await dialog.showOpenDialog(win, options)
        : await dialog.showOpenDialog(options)
      if (selection.canceled || selection.filePaths.length === 0) return null
      return reprocess.attachOriginal(id, selection.filePaths[0])
    })
    ipcMain.handle('cleaning:get-config', () => cleaning.getConfig())
    ipcMain.handle('cleaning:save-config', (_event, config: CleaningConfig) =>
      cleaning.saveConfig(config)
    )
    ipcMain.handle('cleaning:preview', (_event, bookId: string, config?: CleaningConfig) =>
      cleaning.preview(bookId, config)
    )
    ipcMain.handle(
      'cleaning:chapter-diff',
      (_event, bookId: string, chapterIndex: number, config?: CleaningConfig) =>
        cleaning.chapterDiff(bookId, chapterIndex, config)
    )
    ipcMain.handle('book:search', (event, id: string, query: string, token: string) => {
      const win = BrowserWindow.fromWebContents(event.sender)
      return search.search(id, query, token, (payload) => {
        if (win && !win.isDestroyed()) win.webContents.send('search:progress', payload)
      })
    })
    ipcMain.handle('search:cancel', (_event, token: string) => {
      search.cancel(token)
    })

    // Development only: lets automation import files without driving the native
    // dialog, and exercise the boss key without registering a real shortcut.
    // Packaged builds do not register these handlers.
    if (!app.isPackaged) {
      ipcMain.handle('debug:import', (event, paths: string[]) => {
        const safePaths = Array.isArray(paths)
          ? paths.filter((path) => typeof path === 'string')
          : []
        return importQueue.importFiles(safePaths, (payload) =>
          sendImportProgress(event.sender, payload)
        )
      })
      ipcMain.handle('debug:boss-toggle', () => {
        toggleBossKey()
      })
      ipcMain.handle('debug:window-state', () => {
        const win = mainWindow
        if (!win || win.isDestroyed()) return null
        return {
          visible: win.isVisible(),
          minimised: win.isMinimized(),
          opacity: win.getOpacity(),
          alwaysOnTop: win.isAlwaysOnTop(),
          bossKey: registeredBossKey,
          disguise: slackingSettings?.disguise ?? 'none',
          windowKind,
          resizable: win.isResizable(),
          bounds: win.getBounds()
        }
      })
      ipcMain.handle('debug:backdrop', (_event, dark: unknown) => {
        mainWindow?.webContents.send('slacking:backdrop', { dark: dark === true })
      })
    }

    // Renderer-owned shortcuts (F11, Ctrl+-) must not be shadowed by Electron's
    // default menu accelerators, and the default Reload/DevTools entries stay out.
    Menu.setApplicationMenu(null)
    createWindow(settings)
  })

  app.on('will-quit', () => {
    stopBackdropSampling()
    globalShortcut.unregisterAll()
    void sourceStore.flush()
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void settingsRepo.read().then((settings) => createWindow(settings))
    }
  })
}
