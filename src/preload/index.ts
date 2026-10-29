import { contextBridge } from 'electron'
import type { ReaderApi } from '../shared/api'

const api: Partial<ReaderApi> = {}

contextBridge.exposeInMainWorld('api', api)
