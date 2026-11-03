import type { CleanLineDetail } from '../core/cleaning'
import type { SupportedEncoding } from './encodings'
import type {
  AdRule,
  AppSettings,
  BookMeta,
  Bookmark,
  BookProgress,
  DisguiseStyle,
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
  /** Imported books in import order, used to open the latest cleaning report. */
  importedBooks: { id: string; title: string }[]
  duplicates: string[]
  suspects: ImportSuspect[]
  errors: string[]
  warnings: string[]
  canceled?: boolean
}

export interface CleaningConfig {
  /** Global ad-cleaning switch; hygiene and duplicate merging still run when off. */
  adCleaning: boolean
  builtinRules: AdRule[]
  userRules: AdRule[]
}

export interface CleaningRuleHit {
  id: string
  name: string
  type: 'line' | 'sentence'
  scope: 'builtin' | 'user'
  hits: number
}

export interface CleaningChapterSummary {
  index: number
  title: string
  adLinesRemoved: number
  duplicateParagraphsMerged: number
}

export interface CleaningPreview {
  bookId: string
  title: string
  adCleaning: boolean
  chapterCount: number
  /** Paragraphs left after the previewed cleaning. */
  paragraphCount: number
  adLinesRemoved: number
  duplicateParagraphsMerged: number
  ruleHits: CleaningRuleHit[]
  chapters: CleaningChapterSummary[]
  /** Stats currently stored on the library entry, i.e. what the book looks like now. */
  appliedStats: ImportStats
}

export interface CleaningChapterDiff {
  index: number
  title: string
  lines: CleanLineDetail[]
  adLinesRemoved: number
  duplicateParagraphsMerged: number
}

export interface ChapterLinesPayload {
  lines: string[]
  starts: number[]
}

export interface EncodingPreview {
  encoding: string
  lines: string[]
  totalLines: number
  warnings: string[]
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
  reason: 'merge' | 'reclean' | 'resplit' | 'encoding' | 'unknown'
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
  /** User-visible notes about chapters that had to be rebuilt or replaced. */
  warnings: string[]
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
  /** User-visible notes about chapters that were rebuilt or skipped. */
  warnings: string[]
  truncated: boolean
  cancelled: boolean
}

export interface DebugWindowState {
  visible: boolean
  minimised: boolean
  opacity: number
  alwaysOnTop: boolean
  bossKey: string | null
  disguise: DisguiseStyle
  windowKind: 'normal' | 'transparent' | 'code'
  resizable: boolean
}

export interface BackdropTone {
  /** True when the desktop behind the window is dark, so text should be light. */
  dark: boolean
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
  /** Development builds only; runs the boss-key action without a registered shortcut. */
  debugBossToggle(): Promise<void>
  /** Development builds only; overrides the sampled backdrop tone. */
  debugSetBackdrop(dark: boolean): Promise<void>
  debugWindowState(): Promise<DebugWindowState | null>
  /** Tells the main process which page (book or library) the window shows. */
  setViewState(bookId: string | null): Promise<void>
  /** The main process asks the reader to persist before its window is replaced. */
  onFlushRequest(cb: () => void): () => void
  /** Acknowledges that the reading position has been persisted. */
  notifyFlushed(): void
  onBackdropTone(cb: (payload: BackdropTone) => void): () => void
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
  chapterLines(id: string): Promise<ChapterLinesPayload>
  applyChapterStarts(id: string, starts: number[]): Promise<ReprocessResult>
  previewEncoding(id: string, encoding: SupportedEncoding): Promise<EncodingPreview>
  applyEncoding(id: string, encoding: SupportedEncoding): Promise<ReprocessResult>
  attachOriginal(id: string): Promise<{ fileName: string } | null>
  getCleaningConfig(): Promise<CleaningConfig>
  saveCleaningConfig(config: CleaningConfig): Promise<CleaningConfig>
  previewCleaning(bookId: string, config?: CleaningConfig): Promise<CleaningPreview>
  cleaningChapterDiff(
    bookId: string,
    chapterIndex: number,
    config?: CleaningConfig
  ): Promise<CleaningChapterDiff>
  searchBook(id: string, query: string, token: string): Promise<SearchResults>
  cancelSearch(token: string): Promise<void>
  onSearchProgress(cb: (payload: SearchProgress) => void): () => void
  getSettings(): Promise<AppSettings>
  updateSettings(patch: SettingsPatch): Promise<AppSettings>
  toggleFullscreen(): Promise<boolean>
}
