import { randomUUID } from 'node:crypto'
import { chapterTitleHash, splitChapters } from './chapters'
import { BUILTIN_AD_RULES, cleanChapters } from './cleaning'
import { markDuplicateChapters } from './dedupe'
import { decodeBook } from './encoding'
import { repairMojibake } from './mojibake'
import type { AdRule, BookMeta, ChapterMeta, CleanedChapter, ImportStats } from './model'
import { simhash64 } from './text'

export interface ParseBookResult {
  title: string
  encoding: string
  sourceText: string
  chapters: CleanedChapter[]
  meta: BookMeta
  stats: ImportStats
  warnings: string[]
}

export function titleFromFileName(fileName: string): string {
  const base = fileName.replace(/\.txt$/i, '').trim()
  return base || '未命名'
}

export function buildChapterMetas(chapters: CleanedChapter[]): ChapterMeta[] {
  const metas: ChapterMeta[] = chapters.map((chapter, index) => ({
    index,
    title: chapter.title,
    level: chapter.level,
    titleHash: chapterTitleHash(chapter.title),
    startLine: chapter.startLine,
    charCount: chapter.paragraphs.join('').length,
    simhash: simhash64(chapter.paragraphs.join('\n')),
    flags: {}
  }))

  const duplicates = markDuplicateChapters(
    metas.map((meta) => ({ titleHash: meta.titleHash, simhash: meta.simhash, charCount: meta.charCount }))
  )
  duplicates.forEach((isDuplicate, index) => {
    if (isDuplicate) metas[index].flags.suspectedDuplicate = true
  })
  return metas
}

export function parseBookFile(
  contents: Buffer,
  fileName: string,
  options: { userRules?: AdRule[]; id?: string; now?: string } = {}
): ParseBookResult {
  const decoded = decodeBook(contents)
  const repair = repairMojibake(decoded.text, decoded.encoding)
  const split = splitChapters(repair.text)
  const cleaned = cleanChapters(split.chapters, [...BUILTIN_AD_RULES, ...(options.userRules ?? [])])

  const paragraphCount = cleaned.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0)
  if (paragraphCount === 0) throw new Error('文件没有可阅读的正文')

  const metas = buildChapterMetas(cleaned.chapters)
  const title = titleFromFileName(fileName)
  const stats: ImportStats = {
    adLinesRemoved: cleaned.adLinesRemoved,
    duplicateParagraphsMerged: cleaned.duplicateParagraphsMerged,
    suspectedDuplicateChapters: metas.filter((meta) => meta.flags.suspectedDuplicate).length
  }
  const meta: BookMeta = {
    version: 1,
    id: options.id ?? randomUUID(),
    title,
    encoding: decoded.encoding,
    chapters: metas,
    createdAt: options.now ?? new Date().toISOString()
  }

  return {
    title,
    encoding: decoded.encoding,
    sourceText: repair.text,
    chapters: cleaned.chapters,
    meta,
    stats,
    warnings: repair.warnings
  }
}
