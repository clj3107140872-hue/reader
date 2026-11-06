import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { DownloadDone, DownloadProgress } from '../core/booksource/model'
import type {
  BackdropTone,
  NetworkSearchDone,
  NetworkSearchPayload,
  NetworkSearchSourceEvent,
  ReaderApi,
  SearchProgress
} from '../shared/api'
import { INVOKE_CHANNELS } from './channels'

const api: ReaderApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  bookCover: (id) => ipcRenderer.invoke('book:cover', id),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  chooseAndImport: () => ipcRenderer.invoke('library:choose-import'),
  importPaths: (paths) => ipcRenderer.invoke('library:import-paths', paths),
  pathForFile: (file) => webUtils.getPathForFile(file as File),
  debugImport: (paths) => ipcRenderer.invoke('debug:import', paths),
  debugBossToggle: () => ipcRenderer.invoke('debug:boss-toggle'),
  debugSetBackdrop: (dark) => ipcRenderer.invoke('debug:backdrop', dark),
  debugWindowState: () => ipcRenderer.invoke('debug:window-state'),
  setViewState: (bookId) => ipcRenderer.invoke('app:view-state', bookId),
  onFlushRequest: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on('app:flush-request', listener)
    return () => {
      ipcRenderer.removeListener('app:flush-request', listener)
    }
  },
  notifyFlushed: () => {
    ipcRenderer.send('app:flush-done')
  },
  windowResizeStart: (edge, screenX, screenY) => {
    ipcRenderer.send('window:resize-start', { edge, screenX, screenY })
  },
  windowResizeMove: (screenX, screenY) => {
    ipcRenderer.send('window:resize-move', { screenX, screenY })
  },
  windowResizeEnd: () => {
    ipcRenderer.send('window:resize-end')
  },
  onBackdropTone: (callback) => {
    const listener = (_event: unknown, payload: BackdropTone): void => callback(payload)
    ipcRenderer.on('slacking:backdrop', listener)
    return () => {
      ipcRenderer.removeListener('slacking:backdrop', listener)
    }
  },
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
  toggleFullscreen: () => ipcRenderer.invoke('window:toggle-fullscreen'),
  sourceList: () => ipcRenderer.invoke(INVOKE_CHANNELS.sourceList),
  importSources: (request) => ipcRenderer.invoke(INVOKE_CHANNELS.importSources, request),
  setSourceFlags: (id, flags) => ipcRenderer.invoke(INVOKE_CHANNELS.setSourceFlags, id, flags),
  sourceRaw: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.sourceRaw, id),
  deleteSource: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.deleteSource, id),
  searchNetwork: (request) => ipcRenderer.invoke(INVOKE_CHANNELS.searchNetwork, request),
  cancelNetworkSearch: (requestId) =>
    ipcRenderer.invoke(INVOKE_CHANNELS.cancelNetworkSearch, requestId),
  addNetworkBook: (input) => ipcRenderer.invoke(INVOKE_CHANNELS.addNetworkBook, input),
  updateToc: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.updateToc, id),
  downloadAll: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.downloadAll, id),
  cancelDownload: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.cancelDownload, id),
  readNetworkChapter: (id, index) =>
    ipcRenderer.invoke(INVOKE_CHANNELS.readNetworkChapter, id, index),
  convertToLocal: (id) => ipcRenderer.invoke(INVOKE_CHANNELS.convertToLocal, id),
  onNetworkSearchSource: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchSourceEvent): void => callback(payload)
    ipcRenderer.on('network:search-source', listener)
    return () => ipcRenderer.removeListener('network:search-source', listener)
  },
  onNetworkSearchResults: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchPayload): void => callback(payload)
    ipcRenderer.on('network:search-results', listener)
    return () => ipcRenderer.removeListener('network:search-results', listener)
  },
  onNetworkSearchDone: (callback) => {
    const listener = (_e: unknown, payload: NetworkSearchDone): void => callback(payload)
    ipcRenderer.on('network:search-done', listener)
    return () => ipcRenderer.removeListener('network:search-done', listener)
  },
  onNetworkSearchError: (callback) => {
    const listener = (_e: unknown, payload: { requestId: string; message: string }): void =>
      callback(payload)
    ipcRenderer.on('network:search-error', listener)
    return () => ipcRenderer.removeListener('network:search-error', listener)
  },
  onDownloadProgress: (callback) => {
    const listener = (_e: unknown, payload: DownloadProgress): void => callback(payload)
    ipcRenderer.on('network:download-progress', listener)
    return () => ipcRenderer.removeListener('network:download-progress', listener)
  },
  onDownloadDone: (callback) => {
    const listener = (_e: unknown, payload: DownloadDone): void => callback(payload)
    ipcRenderer.on('network:download-done', listener)
    return () => ipcRenderer.removeListener('network:download-done', listener)
  },
  onBookTocUpdated: (callback) => {
    const listener = (_e: unknown, payload: { id: string; added: number; total: number }): void =>
      callback(payload)
    ipcRenderer.on('network:toc-updated', listener)
    return () => ipcRenderer.removeListener('network:toc-updated', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
