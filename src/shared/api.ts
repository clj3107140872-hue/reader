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
import type {
  DownloadDone,
  DownloadProgress,
  ImportSourcesResult,
  NetworkSearchGroup,
  NetworkSearchItem,
  SourceListItem,
  UpdateTocResult
} from '../core/booksource/model'

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
  contentMode: 'eager' | 'lazy'
  /** 本地书：全部章节；网络书：[]。 */
  chapters: string[]
  /** 网络书：已缓存章节索引；本地书：[]。 */
  cachedChapters: number[]
  /** User-visible notes about chapters that had to be rebuilt or replaced. */
  warnings: string[]
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export type SourceImportRequest =
  | { kind: 'file'; dryRun?: boolean }
  | { kind: 'json'; json: string; dryRun?: boolean }
  | { kind: 'url'; url: string; dryRun?: boolean }

export interface NetworkSearchRequest {
  requestId: string
  keyword: string
  scope: 'quality' | 'all'
}

export interface NetworkSearchSourceEvent {
  requestId: string
  sourceId: string
  sourceName: string
  status: 'success' | 'empty' | 'error'
  count: number
  ms: number
  message?: string
}

export interface NetworkSearchPayload {
  requestId: string
  groups: NetworkSearchGroup[]
  searched: number
  succeeded: number
  empty: number
  failed: number
  remaining: number
  scope: 'quality' | 'all'
}

export interface NetworkSearchDone {
  requestId: string
  cancelled: boolean
  searched: number
  succeeded: number
  empty: number
  failed: number
  groups: NetworkSearchGroup[]
}

export interface AddNetworkBookInput {
  sourceId: string
  bookUrl: string
  title?: string
  author?: string
  /** 书籍信息拉取失败时用搜索结果补齐。 */
  intro?: string
  kind?: string
  lastChapter?: string
}

export interface AddNetworkBookResult {
  entry: LibraryEntry
  /** 加入成功但需要提示的降级情况（书信息页失败、目录翻页警告等）。 */
  warnings: string[]
}

export interface NetworkChapterPayload {
  text: string
  cached: boolean
  /** 本章的抓取/清洗提示（截断、清洗后为空等）。 */
  warnings?: string[]
}

export interface ConvertToLocalResult {
  id: string
  chapterCount: number
  warnings: string[]
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
  /** 网络书只搜索了已缓存章节。 */
  cachedOnly: boolean
  /** 网络书因未缓存而跳过的章节数。 */
  skippedUncached: number
}

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export type WindowResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface DebugWindowState {
  visible: boolean
  minimised: boolean
  opacity: number
  alwaysOnTop: boolean
  bossKey: string | null
  disguise: DisguiseStyle
  windowKind: 'normal' | 'transparent' | 'code'
  resizable: boolean
  bounds: WindowBounds
}

export interface BackdropTone {
  /** True when the desktop behind the window is dark, so text should be light. */
  dark: boolean
}

export interface ReaderApi {
  ping(): Promise<string>
  libraryList(): Promise<LibraryEntry[]>
  /** Cover image as a data URL, or null when the book has none. */
  bookCover(id: string): Promise<string | null>
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
  /** Custom window resizing for frameless disguises (native resize is off). */
  windowResizeStart(edge: WindowResizeEdge, screenX: number, screenY: number): void
  windowResizeMove(screenX: number, screenY: number): void
  windowResizeEnd(): void
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

  sourceList(): Promise<SourceListItem[]>
  importSources(request: SourceImportRequest): Promise<ImportSourcesResult>
  setSourceFlags(
    id: string,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<SourceListItem[]>
  sourceRaw(id: string): Promise<Record<string, unknown> | null>
  deleteSource(id: string): Promise<void>

  searchNetwork(request: NetworkSearchRequest): Promise<NetworkSearchDone>
  cancelNetworkSearch(requestId: string): Promise<void>
  addNetworkBook(input: AddNetworkBookInput): Promise<AddNetworkBookResult>
  updateToc(id: string): Promise<UpdateTocResult>
  downloadAll(id: string): Promise<DownloadDone>
  cancelDownload(id: string): Promise<void>
  readNetworkChapter(id: string, index: number): Promise<NetworkChapterPayload>
  convertToLocal(id: string): Promise<ConvertToLocalResult>

  onNetworkSearchSource(cb: (payload: NetworkSearchSourceEvent) => void): () => void
  onNetworkSearchResults(cb: (payload: NetworkSearchPayload) => void): () => void
  onNetworkSearchDone(cb: (payload: NetworkSearchDone) => void): () => void
  onNetworkSearchError(cb: (payload: { requestId: string; message: string }) => void): () => void
  onDownloadProgress(cb: (payload: DownloadProgress) => void): () => void
  onDownloadDone(cb: (payload: DownloadDone) => void): () => void
  onBookTocUpdated(cb: (payload: { id: string; added: number; total: number }) => void): () => void
}
