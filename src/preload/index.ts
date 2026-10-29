import { contextBridge, ipcRenderer } from 'electron'
import type { ReaderApi } from '../shared/api'

const api: ReaderApi = {
  ping: () => ipcRenderer.invoke('app:ping'),
  libraryList: () => ipcRenderer.invoke('library:list'),
  chooseAndImport: () => ipcRenderer.invoke('library:choose-import'),
  onImportProgress: (callback) => {
    const listener = (_event: unknown, payload: { fileName: string; stage: string }): void => {
      callback(payload)
    }
    ipcRenderer.on('import:progress', listener)
    return () => {
      ipcRenderer.removeListener('import:progress', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
