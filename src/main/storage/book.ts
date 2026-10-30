import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type { BookMeta, BookProgress, Bookmark, CleanedChapter } from '../../core/model'
import { assertBookId } from '../bookId'
import { atomicWriteJson, ensureDir, pathExists, readJson } from './fsUtil'

export interface BookFiles {
  meta: BookMeta
  sourceText: string
  chapters: CleanedChapter[]
}

export interface ProgressFile {
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export class BookRepository {
  constructor(private readonly root: string) {}

  private booksDir(): string {
    return join(this.root, 'books')
  }

  private bookDir(id: string): string {
    return join(this.booksDir(), id)
  }

  async writeBook(files: BookFiles): Promise<void> {
    const booksDir = this.booksDir()
    await ensureDir(booksDir)

    const tmp = join(booksDir, `.tmp-${files.meta.id}`)
    await fs.rm(tmp, { recursive: true, force: true })
    await ensureDir(join(tmp, 'chapters'))

    await fs.writeFile(join(tmp, 'source.txt'), files.sourceText, 'utf8')
    await fs.writeFile(join(tmp, 'meta.json'), JSON.stringify(files.meta, null, 2), 'utf8')

    for (let i = 0; i < files.chapters.length; i++) {
      const name = `${String(files.meta.chapters[i].index).padStart(5, '0')}.txt`
      await fs.writeFile(join(tmp, 'chapters', name), files.chapters[i].paragraphs.join('\n\n'), 'utf8')
    }

    const target = this.bookDir(files.meta.id)
    let backupSource: string | null = null
    if (await pathExists(target)) {
      backupSource = join(booksDir, `.bak-${files.meta.id}-${Date.now()}`)
      await fs.rename(target, backupSource)
    }

    await fs.rename(tmp, target)

    if (backupSource) {
      const backupDir = join(target, 'backup', new Date().toISOString().replace(/[:.]/g, '-'))
      await ensureDir(backupDir)
      const entries = await fs.readdir(backupSource)
      for (const entry of entries) {
        await fs.rename(join(backupSource, entry), join(backupDir, entry))
      }
      await fs.rm(backupSource, { recursive: true, force: true })
      const allBackups = await fs.readdir(join(target, 'backup'))
      if (allBackups.length === 0) await fs.rm(join(target, 'backup'), { recursive: true, force: true })
    }
  }

  async readMeta(id: string): Promise<BookMeta> {
    const meta = await readJson<BookMeta>(join(this.bookDir(id), 'meta.json'))
    if (!meta) throw new Error(`书籍数据缺失：${id}`)
    return meta
  }

  async readChapter(id: string, index: number): Promise<string> {
    const name = `${String(index).padStart(5, '0')}.txt`
    return fs.readFile(join(this.bookDir(id), 'chapters', name), 'utf8')
  }

  async readSource(id: string): Promise<string> {
    return fs.readFile(join(this.bookDir(id), 'source.txt'), 'utf8')
  }

  async readBook(id: string): Promise<BookFiles> {
    const meta = await this.readMeta(id)
    const chapters: CleanedChapter[] = []
    for (const chapter of meta.chapters) {
      const text = await this.readChapter(id, chapter.index)
      chapters.push({
        title: chapter.title,
        level: chapter.level,
        startLine: chapter.startLine,
        paragraphs: text
          .split(/\n{2,}/)
          .map((paragraph) => paragraph.trim())
          .filter(Boolean)
      })
    }
    return { meta, sourceText: await this.readSource(id), chapters }
  }

  async readProgress(id: string): Promise<ProgressFile> {
    const stored = await readJson<ProgressFile>(join(this.bookDir(id), 'progress.json'))
    return stored ?? { progress: null, bookmarks: [] }
  }

  async writeProgress(id: string, value: ProgressFile): Promise<void> {
    await atomicWriteJson(join(this.bookDir(id), 'progress.json'), value)
  }

  async remove(id: string): Promise<void> {
    assertBookId(id)
    await fs.rm(this.bookDir(id), { recursive: true, force: true })
    await fs.rm(join(this.booksDir(), `.tmp-${id}`), { recursive: true, force: true })
  }
}
