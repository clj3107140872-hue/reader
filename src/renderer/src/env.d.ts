import type { ReaderApi } from '../../shared/api'

declare global {
  interface Window {
    api: ReaderApi
  }
}

export {}
