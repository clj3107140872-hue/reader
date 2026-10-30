import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { basename, join } from 'node:path'
import type { AppSettings, BookProgress } from '../core/model'
import type { ImportSummary, NewBookmark } from '../shared/api'
import type { SettingsPatch } from '../shared/settings'
import { ImportService } from './services/import'
import { resolveDataDir } from './services/paths'
import { ReaderService } from './services/reader'
import { BookRepository } from './storage/book'
import { LibraryRepository } from './storage/library'
import { SettingsRepository } from './storage/settings'

// Development only: expose the Chrome DevTools Protocol so automated checks
// can drive the window. Packaged builds never enable it.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('remote-debugging-port', '9222')
}

const dataDir = resolveDataDir()
const library = new LibraryRepository(dataDir)
const books = new BookRepository(dataDir)
const importer = new ImportService(library, books)
const settingsRepo = new SettingsRepository(dataDir)
const reader = new ReaderService(library, books)

async function importFiles(files: string[], win: BrowserWindow | null): Promise<ImportSummary> {
  let imported = 0
  const duplicates: string[] = []
  const suspects: { id: string; title: string; overlap: number }[] = []
  const errors: string[] = []
  const warnings = new Set<string>()

  for (const file of files) {
    try {
      const outcome = await importer.importFile(file)
      if ('duplicate' in outcome) {
        duplicates.push(outcome.title)
        continue
      }
      imported += 1
      suspects.push(...outcome.suspects)
      for (const warning of outcome.warnings) {
        warnings.add(`${basename(file)}：${warning}`)
      }
      win?.webContents.send('import:progress', { fileName: basename(file), stage: 'done' })
    } catch (error) {
      errors.push(`${basename(file)}: ${(error as Error).message}`)
    }
  }

  return { imported, duplicates, suspects, errors, warnings: [...warnings] }
}

function createWindow(windowState: AppSettings['window']): void {
  // Development only: automated acceptance runs must not take focus, appear
  // on the desktop or leave a taskbar entry while they drive the UI.
  const acceptance = !app.isPackaged && process.env.READER_ACCEPTANCE === '1'
  const win = new BrowserWindow({
    width: windowState.width,
    height: windowState.height,
    x: acceptance ? -20000 : windowState.x,
    y: acceptance ? -20000 : windowState.y,
    show: !acceptance,
    skipTaskbar: acceptance,
    focusable: !acceptance,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      offscreen: acceptance,
      backgroundThrottling: !acceptance
    }
  })
  if (acceptance) {
    win.webContents.setFrameRate(30)
  } else if (windowState.maximized) {
    win.maximize()
  }
  if (!acceptance) {
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

app.whenReady().then(async () => {
  const settings = await settingsRepo.read()

  ipcMain.handle('app:ping', () => 'pong')
  ipcMain.handle('settings:get', () => settingsRepo.read())
  ipcMain.handle('settings:update', (_event, patch: SettingsPatch) => settingsRepo.update(patch))
  ipcMain.handle('window:toggle-fullscreen', (event) => {
    const win = BrowserWindow.fromWebContents(event.sender)
    if (!win) return false
    const next = !win.isFullScreen()
    win.setFullScreen(next)
    return next
  })
  ipcMain.handle('library:list', () => library.list())
  ipcMain.handle('library:choose-import', async () => {
    const win = BrowserWindow.getFocusedWindow()
    const options: OpenDialogOptions = {
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: '文本文件', extensions: ['txt'] }]
    }
    const selection = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)

    if (selection.canceled || selection.filePaths.length === 0) {
      return { imported: 0, duplicates: [], suspects: [], errors: [], warnings: [] }
    }

    return importFiles(selection.filePaths, win)
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

  // Development only: lets automation import files without driving the native
  // dialog. Packaged builds do not register this handler.
  if (!app.isPackaged) {
    ipcMain.handle('debug:import', (_event, paths: string[]) => {
      const safePaths = Array.isArray(paths) ? paths.filter((path) => typeof path === 'string') : []
      return importFiles(safePaths, BrowserWindow.getFocusedWindow())
    })
  }

  createWindow(settings.window)
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) void settingsRepo.read().then((s) => createWindow(s.window))
})
