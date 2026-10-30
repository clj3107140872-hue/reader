import { contextBridge, ipcRenderer } from 'electron'
import type { ReaderApi, SearchProgress } from '../shared/api'

const api: ReaderApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  removeBook: (id) => ipcRenderer.invoke('library:remove', id),
  chooseAndImport: () => ipcRenderer.invoke('library:choose-import'),
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
  mergeBooks: (targetId, sourceId) => ipcRenderer.invoke('import:resolve', targetId, sourceId),
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
