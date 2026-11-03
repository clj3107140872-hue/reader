import { app, BrowserWindow, dialog, ipcMain, Menu, screen } from 'electron'
import type { MessageBoxOptions, OpenDialogOptions, WebContents } from 'electron'
import { join } from 'node:path'
import type { AppSettings, BookProgress } from '../core/model'
import type { CleaningConfig, NewBookmark, StartupNotice } from '../shared/api'
import type { SettingsPatch } from '../shared/settings'
import { BackupService } from './services/backup'
import { CleaningService } from './services/cleaning'
import { ImportService } from './services/import'
import { formatFileSize, ImportQueue } from './services/importQueue'
import { LibraryService } from './services/library'
import { Logger } from './services/logger'
import { MergeService } from './services/merge'
import { resolveDataDir } from './services/paths'
import { ReaderService } from './services/reader'
import { ReprocessService } from './services/reprocess'
import { SearchService } from './services/search'
import { BookRepository } from './storage/book'
import { LibraryRepository } from './storage/library'
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
const importer = new ImportService(library, books, () => cleaning.currentRunConfig())
const reader = new ReaderService(library, books)
const search = new SearchService(books)
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

function createWindow(windowState: AppSettings['window']): void {
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
  const win = new BrowserWindow({
    width: clamped.width,
    height: clamped.height,
    x: ACCEPTANCE ? -20000 : clamped.x,
    y: ACCEPTANCE ? -20000 : clamped.y,
    show: !ACCEPTANCE,
    skipTaskbar: ACCEPTANCE,
    focusable: !ACCEPTANCE,
    minWidth: 800,
    minHeight: 600,
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

  if (ACCEPTANCE) {
    win.webContents.setFrameRate(30)
  } else if (clamped.maximized) {
    win.maximize()
  }
  if (!ACCEPTANCE) {
    win.on('close', () => {
      const bounds = win.getNormalBounds()
      settingsRepo.updateSync({ window: { ...bounds, maximized: win.isMaximized() } })
    })
  }
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (hasSingleInstanceLock) {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })

  app.whenReady().then(async () => {
    const repair = await library.repair()
    startupNotice = { libraryRestored: repair.restored }
    if (repair.restored) logger.info('library.json restored from backup')
    logger.info(
      `app start version=${app.getVersion()} packaged=${app.isPackaged} data=${dataDir}`
    )
    const settings = await settingsRepo.read()

    ipcMain.handle('app:ping', () => 'pong')
    ipcMain.handle('app:startup-notice', () => startupNotice)
    ipcMain.handle('settings:get', () => settingsRepo.read())
    ipcMain.handle('settings:update', (_event, patch: SettingsPatch) => settingsRepo.update(patch))
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
    ipcMain.handle('library:list', () => library.list())
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
        filters: [{ name: '文本文件', extensions: ['txt'] }]
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
    ipcMain.handle('library:remove', (_event, id: string) => libraryService.remove(id))
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
    // dialog. Packaged builds do not register this handler.
    if (!app.isPackaged) {
      ipcMain.handle('debug:import', (event, paths: string[]) => {
        const safePaths = Array.isArray(paths)
          ? paths.filter((path) => typeof path === 'string')
          : []
        return importQueue.importFiles(safePaths, (payload) =>
          sendImportProgress(event.sender, payload)
        )
      })
    }

    // Renderer-owned shortcuts (F11, Ctrl+-) must not be shadowed by Electron's
    // default menu accelerators, and the default Reload/DevTools entries stay out.
    Menu.setApplicationMenu(null)
    createWindow(settings.window)
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      void settingsRepo.read().then((settings) => createWindow(settings.window))
    }
  })
}
