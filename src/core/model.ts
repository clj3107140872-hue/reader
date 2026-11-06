export type ChapterLevel = 'volume' | 'chapter'

export interface ChapterMeta {
  index: number
  title: string
  level: ChapterLevel
  titleHash: string
  startLine: number
  charCount: number
  simhash: string
  flags: { suspectedDuplicate?: boolean }
  /** 网络章节地址；本地章节没有该字段。 */
  url?: string
}

export type BookFormat = 'txt' | 'epub' | 'network'
export type DownloadState = 'none' | 'partial' | 'complete'

export interface NetworkBookInfo {
  sourceId: string
  /** 用于书源删除后按 URL 重新关联。 */
  sourceUrl: string
  /** 快照，书源删除后仍能显示。 */
  sourceName: string
  bookUrl: string
  tocUrl: string
  lastChapter?: string
  lastTocAt: string | null
  lastCheckAt: string | null
  lastDownloadAt?: string | null
}

export interface BookMeta {
  version: 1
  id: string
  title: string
  encoding: string
  /** Source format; absent on books imported before EPUB support. */
  format?: BookFormat
  author?: string
  /** Present when the book directory holds a cover image. */
  cover?: { mime: string }
  chapters: ChapterMeta[]
  /** Line numbers the user marked as chapter titles; absent for auto-split books. */
  chapterStarts?: number[]
  intro?: string
  kind?: string
  network?: NetworkBookInfo
  createdAt: string
}

export interface CleanedChapter {
  title: string
  level: ChapterLevel
  startLine: number
  paragraphs: string[]
}

export interface ImportStats {
  adLinesRemoved: number
  duplicateParagraphsMerged: number
  suspectedDuplicateChapters: number
}

export interface LibraryEntry {
  id: string
  title: string
  /** Source format; absent means TXT (shelf entries from before EPUB support). */
  format?: BookFormat
  author?: string
  hasCover?: boolean
  normalizedTitle: string
  sourceFileName: string
  /** Every original file name; set when volumes are merged. */
  sourceFileNames?: string[]
  fileHash: string
  /** Every source file represented by this entry; set when volumes are merged. */
  fileHashes?: string[]
  encoding: string
  importedAt: string
  lastReadAt: string | null
  chapterCount: number
  progressPercent: number
  stats: ImportStats
  intro?: string
  kind?: string
  /** 网络书当前绑定的书源；来源删除后用于显示「书源已删除」。 */
  sourceId?: string
  sourceName?: string
  networkCache?: { cached: number; total: number }
  downloadState?: DownloadState
  lastUpdateAt?: string
}

export interface BookProgress {
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  percent: number
  updatedAt: string
}

export interface Bookmark {
  id: string
  chapterKey: string
  chapterIndex: number
  paragraphIndex: number
  excerpt: string
  createdAt: string
}

export interface AdRule {
  id: string
  name: string
  type: 'line' | 'sentence'
  pattern: string
  enabled: boolean
}

export type ThemeName = 'light' | 'dark' | 'green' | 'sepia'
export type ThemeMode = 'day' | 'night' | 'system'
/** Continuous scrolling, or one chapter laid out into whole pages. */
export type ReadingMode = 'scroll' | 'paged'
export type BossKeyAction = 'hide' | 'minimize'
/** How the reader disguises itself; 'none' turns the disguise off. */
export type DisguiseStyle = 'none' | 'notepad' | 'transparent' | 'code'

export interface SlackingSettings {
  disguise: DisguiseStyle
  /** Window opacity, 0.6..1. */
  opacity: number
  alwaysOnTop: boolean
  /** Electron accelerator, or an empty string to disable the boss key. */
  bossKey: string
  bossKeyAction: BossKeyAction
}

export interface TypographySettings {
  fontFamily: string
  fontSize: number
  lineHeight: number
  paragraphSpacing: number
  pagePadding: number
  maxContentWidth: number | null
}

export interface AppSettings {
  version: 1
  /** Day palette; night mode always renders the dark palette. */
  theme: ThemeName
  themeMode: ThemeMode
  readingMode: ReadingMode
  slacking: SlackingSettings
  typography: TypographySettings
  cleaning: { enabled: boolean; disabledBuiltinIds: string[] }
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean }
  network: {
    enabled: boolean
    autoCheckOnOpen: boolean
  }
}
