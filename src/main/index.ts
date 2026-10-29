import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import type { OpenDialogOptions } from 'electron'
import { basename, join } from 'node:path'
import { ImportService } from './services/import'
import { resolveDataDir } from './services/paths'
import { BookRepository } from './storage/book'
import { LibraryRepository } from './storage/library'

const dataDir = resolveDataDir()
const library = new LibraryRepository(dataDir)
const books = new BookRepository(dataDir)
const importer = new ImportService(library, books)

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  if (process.env.ELECTRON_RENDERER_URL) {
    void win.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle('app:ping', () => 'pong')
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

    let imported = 0
    const duplicates: string[] = []
    const suspects: { id: string; title: string; overlap: number }[] = []
    const errors: string[] = []
    const warnings = new Set<string>()

    for (const file of selection.filePaths) {
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
  })

  createWindow()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow()
})
