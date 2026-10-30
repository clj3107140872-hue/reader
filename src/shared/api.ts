import type { AppSettings, BookMeta, Bookmark, BookProgress, LibraryEntry } from '../core/model'
import type { SettingsPatch } from './settings'

export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: { id: string; title: string; overlap: number }[]
  errors: string[]
  warnings: string[]
}

export interface MergeResult {
  targetId: string
  title: string
  chapterCount: number
  removedId: string
  warning?: string
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
  /** Development builds only; rejects in packaged builds. */
  debugImport(paths: string[]): Promise<ImportSummary>
  onImportProgress(cb: (payload: { fileName: string; stage: string }) => void): () => void
  openBook(id: string): Promise<OpenBookPayload>
  saveProgress(id: string, progress: BookProgress): Promise<void>
  addBookmark(id: string, bookmark: NewBookmark): Promise<Bookmark[]>
  removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]>
  mergeBooks(targetId: string, sourceId: string): Promise<MergeResult>
  searchBook(id: string, query: string, token: string): Promise<SearchResults>
  cancelSearch(token: string): Promise<void>
  onSearchProgress(cb: (payload: SearchProgress) => void): () => void
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  toggleFullscreen(): Promise<boolean>
}
