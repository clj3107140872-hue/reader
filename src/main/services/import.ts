import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import { BUILTIN_AD_RULES } from '../../core/cleaning'
import type { CleaningRunConfig } from '../../core/cleaning'
import { buildBookDocuments } from '../../core/compose'
import { isEpubFile, parseEpub } from '../../core/epub'
import type { ImportStats, LibraryEntry } from '../../core/model'
import type { ParseBookResult } from '../../core/pipeline'
import { parseBookFile } from '../../core/pipeline'
import { chapterMatchRate, normalizeBookTitle } from '../../core/sameBook'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

interface ParsedImport extends ParseBookResult {
  cover?: Buffer
}

function statsFrom(meta: ParseBookResult['meta']): ImportStats {
  return {
    adLinesRemoved: 0,
    duplicateParagraphsMerged: 0,
    suspectedDuplicateChapters: meta.chapters.filter(
      (chapter) => chapter.flags.suspectedDuplicate
    ).length
  }
}

export type ImportStage = 'reading' | 'parsing' | 'writing' | 'done'

export interface ImportOutcome {
  entry: LibraryEntry
  suspects: {
    id: string
    title: string
    targetFiles: string[]
    targetChapterCount: number
    overlap: number
  }[]
  warnings: string[]
}

function sourceFiles(entry: LibraryEntry): string[] {
  return entry.sourceFileNames ?? [entry.sourceFileName]
}

export interface DuplicateOutcome {
  duplicate: true
  title: string
}

export class ImportService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly cleaning: () => CleaningRunConfig = () => ({
      adCleaning: true,
      rules: BUILTIN_AD_RULES
    })
  ) {}

  private parseText(contents: Buffer, fileName: string): ParsedImport {
    const cleaning = this.cleaning()
    return parseBookFile(contents, fileName, {
      adRules: cleaning.rules,
      adCleaning: cleaning.adCleaning
    })
  }

  private parseEpubImport(contents: Buffer, fileName: string): ParsedImport {
    const epub = parseEpub(contents, fileName)
    const documents = buildBookDocuments({
      id: randomUUID(),
      title: epub.title,
      encoding: 'utf-8',
      createdAt: new Date().toISOString(),
      chapters: epub.chapters.map((chapter) => ({
        title: chapter.title,
        level: 'chapter' as const,
        startLine: 0,
        paragraphs: chapter.paragraphs
      })),
      format: 'epub',
      ...(epub.author ? { author: epub.author } : {}),
      ...(epub.cover ? { cover: { mime: epub.cover.mime } } : {})
    })
    return {
      title: documents.meta.title,
      encoding: documents.meta.encoding,
      ...documents,
      stats: statsFrom(documents.meta),
      warnings: epub.warnings,
      ...(epub.cover ? { cover: epub.cover.data } : {})
    }
  }

  async importFile(
    filePath: string,
    onStage: (stage: ImportStage) => void = () => {}
  ): Promise<ImportOutcome | DuplicateOutcome> {
    onStage('reading')
    const contents = await readFile(filePath)
    const fileHash = createHash('sha256').update(contents).digest('hex')

    const existingByHash = await this.library.findByFileHash(fileHash)
    if (existingByHash) return { duplicate: true, title: existingByHash.title }

    const fileName = basename(filePath)
    onStage('parsing')
    const parsed = isEpubFile(fileName)
      ? this.parseEpubImport(contents, fileName)
      : this.parseText(contents, fileName)

    onStage('writing')
    await this.books.writeBook({
      meta: parsed.meta,
      sourceText: parsed.sourceText,
      chapters: parsed.chapters,
      // Keep the raw bytes so the user can switch encodings later.
      original: contents,
      cover: parsed.cover
    })

    const entry: LibraryEntry = {
      id: parsed.meta.id,
      title: parsed.title,
      format: parsed.meta.format ?? 'txt',
      ...(parsed.meta.author ? { author: parsed.meta.author } : {}),
      hasCover: Boolean(parsed.meta.cover),
      normalizedTitle: normalizeBookTitle(fileName),
      sourceFileName: fileName,
      sourceFileNames: [fileName],
      fileHash,
      fileHashes: [fileHash],
      encoding: parsed.encoding,
      importedAt: parsed.meta.createdAt,
      lastReadAt: null,
      chapterCount: parsed.meta.chapters.length,
      progressPercent: 0,
      stats: parsed.stats
    }
    await this.library.add(entry)
    onStage('done')

    const suspects: ImportOutcome['suspects'] = []
    for (const other of await this.library.list()) {
      if (other.id === entry.id) continue
      try {
        const otherMeta = await this.books.readMeta(other.id)
        const overlap = chapterMatchRate(parsed.meta, otherMeta)
        const sameTitle =
          Boolean(entry.normalizedTitle) && entry.normalizedTitle === other.normalizedTitle
        if (sameTitle || overlap >= 0.05) {
          suspects.push({
            id: other.id,
            title: other.title,
            targetFiles: sourceFiles(other),
            targetChapterCount: otherMeta.chapters.length,
            overlap
          })
        }
      } catch {
        // A damaged entry must not abort an import that already succeeded.
      }
    }

    return { entry, suspects, warnings: parsed.warnings }
  }
}
