import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { ReaderApi, SearchProgress } from '../shared/api'

const api: ReaderApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  chooseAndImport: () => ipcRenderer.invoke('library:choose-import'),
  importPaths: (paths) => ipcRenderer.invoke('library:import-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file as File),
  debugImport: (paths) => ipcRenderer.invoke('debug:import', paths),
  onImportProgress: (callback) => {
    const listener = (_event: unknown, payload: { fileName: string; stage: string }): void => {
      callback(payload)
    }
    ipcRenderer.on('import:progress', listener)
    return () => {
      ipcRenderer.removeListener('import:progress', listener)
    }
  },
  openBook: (id) => ipcRenderer.invoke('book:open', id),
  saveProgress: (id, progress) => ipcRenderer.invoke('progress:save', id, progress),
  addBookmark: (id, bookmark) => ipcRenderer.invoke('bookmark:add', id, bookmark),
  removeBookmark: (id, bookmarkId) => ipcRenderer.invoke('bookmark:remove', id, bookmarkId),
  findMerges: (ids) => ipcRenderer.invoke('library:find-merges', ids),
  mergeBooks: (targetId, sourceId) => ipcRenderer.invoke('import:resolve', targetId, sourceId),
  listBackups: (id) => ipcRenderer.invoke('backup:list', id),
  restoreBackup: (id, name) => ipcRenderer.invoke('backup:restore', id, name),
  getStartupNotice: () => ipcRenderer.invoke('app:startup-notice'),
  recleanBook: (id) => ipcRenderer.invoke('book:reclean', id),
  resplitBook: (id) => ipcRenderer.invoke('book:resplit', id),
  chapterLines: (id) => ipcRenderer.invoke('book:chapter-lines', id),
  applyChapterStarts: (id, starts) => ipcRenderer.invoke('book:apply-chapter-starts', id, starts),
  previewEncoding: (id, encoding) => ipcRenderer.invoke('book:encoding-preview', id, encoding),
  applyEncoding: (id, encoding) => ipcRenderer.invoke('book:apply-encoding', id, encoding),
  attachOriginal: (id) => ipcRenderer.invoke('book:attach-original', id),
  getCleaningConfig: () => ipcRenderer.invoke('cleaning:get-config'),
  saveCleaningConfig: (config) => ipcRenderer.invoke('cleaning:save-config', config),
  previewCleaning: (bookId, config) => ipcRenderer.invoke('cleaning:preview', bookId, config),
  cleaningChapterDiff: (bookId, chapterIndex, config) =>
    ipcRenderer.invoke('cleaning:chapter-diff', bookId, chapterIndex, config),
  searchBook: (id, query, token) => ipcRenderer.invoke('book:search', id, query, token),
  cancelSearch: (token) => ipcRenderer.invoke('search:cancel', token),
  onSearchProgress: (callback) => {
    const listener = (_event: unknown, payload: SearchProgress): void => {
      callback(payload)
    }
    ipcRenderer.on('search:progress', listener)
    return () => {
      ipcRenderer.removeListener('search:progress', listener)
    }
  },
  getSettings: () => ipcRenderer.invoke('settings:get'),
  updateSettings: (patch) => ipcRenderer.invoke('settings:update', patch),
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen')
}

contextBridge.exposeInMainWorld('api', api)
