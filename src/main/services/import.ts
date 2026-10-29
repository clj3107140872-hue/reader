import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { AdRule, LibraryEntry } from '../../core/model'
import { parseBookFile } from '../../core/pipeline'
import { chapterMatchRate, normalizeBookTitle } from '../../core/sameBook'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export interface ImportOutcome {
  entry: LibraryEntry
  suspects: { id: string; title: string; overlap: number }[]
  warnings: string[]
}

export interface DuplicateOutcome {
  duplicate: true
  title: string
}

export class ImportService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository,
    private readonly userRules: () => AdRule[] = () => []
  ) {}

  async importFile(filePath: string): Promise<ImportOutcome | DuplicateOutcome> {
    const contents = await readFile(filePath)
    const fileHash = createHash('sha256').update(contents).digest('hex')

    const existingByHash = await this.library.findByFileHash(fileHash)
    if (existingByHash) return { duplicate: true, title: existingByHash.title }

    const fileName = basename(filePath)
    const parsed = parseBookFile(contents, fileName, { userRules: this.userRules() })

    await this.books.writeBook({
      meta: parsed.meta,
      sourceText: parsed.sourceText,
      chapters: parsed.chapters
    })

    const entry: LibraryEntry = {
      id: parsed.meta.id,
      title: parsed.title,
      normalizedTitle: normalizeBookTitle(fileName),
      sourceFileName: fileName,
      fileHash,
      encoding: parsed.encoding,
      importedAt: parsed.meta.createdAt,
      lastReadAt: null,
      chapterCount: parsed.meta.chapters.length,
      progressPercent: 0,
      stats: parsed.stats
    }
    await this.library.add(entry)

    const suspects: ImportOutcome['suspects'] = []
    for (const other of await this.library.list()) {
      if (other.id === entry.id) continue
      try {
        const otherMeta = await this.books.readMeta(other.id)
        const overlap = chapterMatchRate(parsed.meta, otherMeta)
        const sameTitle =
          Boolean(entry.normalizedTitle) && entry.normalizedTitle === other.normalizedTitle
        if (sameTitle || overlap >= 0.05) {
          suspects.push({ id: other.id, title: other.title, overlap })
        }
      } catch {
        // A damaged entry must not abort an import that already succeeded.
      }
    }

    return { entry, suspects, warnings: parsed.warnings }
  }
}
