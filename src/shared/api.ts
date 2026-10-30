import type { AppSettings, BookMeta, Bookmark, BookProgress, LibraryEntry } from '../core/model'
import type { SettingsPatch } from './settings'

export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: { id: string; title: string; overlap: number }[]
  errors: string[]
  warnings: string[]
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

export interface ReaderApi {
  ping(): Promise<string>
  libraryList(): Promise<LibraryEntry[]>
  chooseAndImport(): Promise<ImportSummary>
  /** Development builds only; rejects in packaged builds. */
  debugImport(paths: string[]): Promise<ImportSummary>
  onImportProgress(cb: (payload: { fileName: string; stage: string }) => void): () => void
  openBook(id: string): Promise<OpenBookPayload>
  saveProgress(id: string, progress: BookProgress): Promise<void>
  addBookmark(id: string, bookmark: NewBookmark): Promise<Bookmark[]>
  removeBookmark(id: string, bookmarkId: string): Promise<Bookmark[]>
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  toggleFullscreen(): Promise<boolean>
}
