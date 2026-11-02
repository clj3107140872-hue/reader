import type {
  AppSettings,
  BookMeta,
  Bookmark,
  BookProgress,
  ImportStats,
  LibraryEntry
} from '../core/model'
import type { SettingsPatch } from './settings'

export interface ImportSuspect {
  sourceId: string
  sourceTitle: string
  sourceFiles: string[]
  sourceChapterCount: number
  id: string
  title: string
  targetFiles: string[]
  targetChapterCount: number
  overlap: number
}

export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: ImportSuspect[]
  errors: string[]
  warnings: string[]
  canceled?: boolean
}

export interface MergeCandidate {
  targetId: string
  targetTitle: string
  targetFiles: string[]
  targetChapterCount: number
  sourceId: string
  sourceTitle: string
  sourceFiles: string[]
  sourceChapterCount: number
  /** Chapter overlap ratio, 0..1. */
  overlap: number
}

export interface FindMergesResult {
  candidates: MergeCandidate[]
  warnings: string[]
}

export interface MergeResult {
  targetId: string
  title: string
  chapterCount: number
  removedId: string
  warning?: string
}

export interface ReprocessResult {
  id: string
  chapterCount: number
  stats: ImportStats
  warning?: string
}

export interface BackupInfo {
  name: string
  createdAt: string
  chapterCount: number
  reason: 'merge' | 'reclean' | 'resplit' | 'unknown'
  sourceTitle?: string
}

export interface RestoreBackupResult {
  id: string
  chapterCount: number
  restoredSource: boolean
  warning?: string
}

export interface StartupNotice {
  libraryRestored: boolean
}

export interface OpenBookPayload {
  meta: BookMeta
  chapters: string[]
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export interface NewBookmark {
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
}

export interface SearchHit {
  chapterIndex: number
  chapterKey: string
  paragraphIndex: number
  excerpt: string
}

export interface SearchProgress {
  token: string
  scanned: number
  total: number
}

export interface SearchResults {
  token: string
  hits: SearchHit[]
  truncated: boolean
  cancelled: boolean
}

export interface ReaderApi {
  ping(): Promise<string>
  libraryList(): Promise<LibraryEntry[]>
  removeBook(id: string): Promise<void>
  chooseAndImport(): Promise<ImportSummary>
  importPaths(paths: string[]): Promise<ImportSummary>
  /** Resolves the on-disk path of a file dropped onto the window. */
  pathForFile(file: unknown): string
  /** Development builds only; rejects in packaged builds. */
  debugImport(paths: string[]): Promise<ImportSummary>
  onImportProgress(cb: (payload: { fileName: string; stage: string }) => void): () => void
  openBook(id: string): Promise<OpenBookPayload>
  saveProgress(id: string, progress: BookProgress): Promise<void>
  addBookmark(id: string, bookmark: NewBookmark): Promise<Bookmark[]>
  removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]>
  findMerges(ids: string[]): Promise<FindMergesResult>
  mergeBooks(targetId: string, sourceId: string): Promise<MergeResult>
  listBackups(id: string): Promise<BackupInfo[]>
  restoreBackup(id: string, name: string): Promise<RestoreBackupResult>
  getStartupNotice(): Promise<StartupNotice>
  recleanBook(id: string): Promise<ReprocessResult>
  resplitBook(id: string): Promise<ReprocessResult>
  searchBook(id: string, query: string, token: string): Promise<SearchResults>
  cancelSearch(token: string): Promise<void>
  onSearchProgress(cb: (payload: SearchProgress) => void): () => void
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  toggleFullscreen(): Promise<boolean>
}
