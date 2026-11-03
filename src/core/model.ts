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
}

export interface BookMeta {
  version: 1
  id: string
  title: string
  encoding: string
  chapters: ChapterMeta[]
  /** Line numbers the user marked as chapter titles; absent for auto-split books. */
  chapterStarts?: number[]
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
  theme: ThemeName
  typography: TypographySettings
  cleaning: { enabled: boolean; disabledBuiltinIds: string[] }
  window: { width: number; height: number; x?: number; y?: number; maximized: boolean }
}
