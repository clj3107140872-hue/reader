import type { ChapterLevel } from '../model'

export type SourceCompatLevel = 'full' | 'partial'

export interface SourceCompat {
  level: SourceCompatLevel
  issues: string[]
}

export interface StoredSource {
  id: string
  definition: Record<string, unknown>
  enabled: boolean
  starred: boolean
  blacklisted: boolean
  compat: SourceCompat
  importedAt: string
  updatedAt: string
}

export interface SourceListItem {
  id: string
  name: string
  url: string
  group: string
  enabled: boolean
  starred: boolean
  blacklisted: boolean
  compat: SourceCompat
  score: number
  searchSuccessRate: number
  avgMs: number
  importedAt: string
  customOrder: number
  /** 已加入书架、仍指向该来源的网络书数量；由 SourceService 填充。 */
  bookCount?: number
  lastError?: { operation: string; message: string; at: string }
}

export interface OperationStats {
  attempts: number
  successes: number
  empties: number
  errors: number
  totalMs: number
}

export interface SourceStats {
  search: OperationStats
  info: OperationStats
  toc: OperationStats
  content: OperationStats
  score: number
  lastError?: { operation: string; message: string; at: string }
  lastUsedAt: string | null
}

export interface StatsFile {
  version: 1
  bySource: Record<string, SourceStats>
}

export interface SourcesFile {
  version: 1
  sources: StoredSource[]
}

export interface NetworkSearchItem {
  sourceId: string
  sourceName: string
  title: string
  author: string
  intro?: string
  kind?: string
  coverUrl?: string
  bookUrl: string
  lastChapter?: string
  qualityScore: number
  starred: boolean
  inShelf: boolean
  /** 已在书架时对应的书架书 id，供「已在书架」直接打开。 */
  shelfId?: string
  /** 组内最佳来源排序用的内部字段，不展示。 */
  avgMs?: number
  importedAt?: string
}

export interface NetworkSearchGroup {
  key: string
  title: string
  author: string
  items: NetworkSearchItem[]
  bestSourceId: string
}

export interface RejectedSource {
  name?: string
  url?: string
  reason: string
}

export interface ImportSourcesResult {
  added: number
  updated: number
  rejected: RejectedSource[]
  warnings: string[]
}

export interface TocChapter {
  title: string
  url: string
  level: ChapterLevel
}

export interface UpdateTocResult {
  added: number
  total: number
  warnings: string[]
  lastChapter?: string
}

export interface DownloadFailedChapter {
  index: number
  title: string
  message: string
}

export interface DownloadProgress {
  bookId: string
  done: number
  total: number
  failed: number
}

export interface DownloadDone {
  bookId: string
  done: number
  total: number
  failedChapters: DownloadFailedChapter[]
  cancelled: boolean
}
