import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import type {
  BookMeta,
  BookProgress,
  Bookmark,
  CleanedChapter,
  LibraryEntry
} from '../../core/model'
import { splitParagraphs } from '../../core/paragraphs'
import { assertBookId } from '../bookId'
import { atomicWriteJson, ensureDir, pathExists, readJson } from './fsUtil'

export interface BookFiles {
  meta: BookMeta
  sourceText: string
  chapters: CleanedChapter[]
  /**
   * Original file bytes, kept so the encoding can be changed later.
   * On write: a Buffer replaces the stored bytes, `null` drops them, and
   * `undefined` keeps whatever the book already has.
   */
  original?: Buffer | null
}

export interface ProgressFile {
  progress: BookProgress | null
  bookmarks: Bookmark[]
}

export interface BackupManifest {
  version: 1
  reason: 'merge' | 'reclean' | 'resplit' | 'encoding'
  createdAt: string
  targetEntry: LibraryEntry
  sourceEntry?: LibraryEntry
  sourceId?: string
  sourceTitle?: string
}

export interface BackupInfo {
  name: string
  createdAt: string
  chapterCount: number
  reason: 'merge' | 'reclean' | 'resplit' | 'encoding' | 'unknown'
  sourceTitle?: string
  hasSource: boolean
}

export interface BackupContents {
  files: BookFiles
  progress: ProgressFile
  manifest: BackupManifest | null
  sourceBookDir: string | null
}

function assertBackupName(name: string): void {
  if (!/^[0-9A-Za-z-]+$/.test(name)) throw new Error('无效的备份编号')
}

function timestampName(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export class BookRepository {
  constructor(private readonly root: string) {}

  private booksDir(): string {
    return join(this.root, 'books')
  }

  private bookDir(id: string): string {
    return join(this.booksDir(), id)
  }

  /**
   * Atomically replace a book's files. By default the previous version is
   * moved into `backup/<timestamp>/`; merge callers pass `backup: false`
   * because they create a combined restore point first. Existing backups are
   * flattened into `backup/` so older restore points do not nest.
   */
  async writeBook(
    files: BookFiles,
    options: { backup?: boolean } = {}
  ): Promise<{ backupDir: string | null }> {
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
    if (files.original !== null && files.original !== undefined && Buffer.isBuffer(files.original)) {
      await fs.writeFile(join(tmp, 'original.bin'), files.original)
    } else if (files.original === undefined && (await pathExists(join(target, 'original.bin')))) {
      await fs.copyFile(join(target, 'original.bin'), join(tmp, 'original.bin'))
    }

    let replaced: string | null = null
    if (await pathExists(target)) {
      replaced = join(booksDir, `.bak-${files.meta.id}-${Date.now()}`)
      await fs.rename(target, replaced)
    }

    await fs.rename(tmp, target)

    let backupDir: string | null = null
    if (replaced) {
      if (options.backup !== false) {
        backupDir = join(target, 'backup', timestampName())
        await ensureDir(backupDir)
        for (const entry of await fs.readdir(replaced)) {
          if (entry === 'backup') continue
          await fs.rename(join(replaced, entry), join(backupDir, entry))
        }
      }
      const oldBackups = join(replaced, 'backup')
      if (await pathExists(oldBackups)) {
        const parent = join(target, 'backup')
        await ensureDir(parent)
        for (const entry of await fs.readdir(oldBackups)) {
          let destination = join(parent, entry)
          let suffix = 1
          while (await pathExists(destination)) {
            destination = join(parent, `${entry}-${suffix++}`)
          }
          await fs.rename(join(oldBackups, entry), destination)
        }
      }
      await fs.rm(replaced, { recursive: true, force: true })
    }
    return { backupDir }
  }

  private async copyBookData(from: string, to: string): Promise<void> {
    await ensureDir(to)
    for (const name of ['source.txt', 'meta.json', 'progress.json', 'original.bin']) {
      if (await pathExists(join(from, name))) {
        await fs.copyFile(join(from, name), join(to, name))
      }
    }
    if (await pathExists(join(from, 'chapters'))) {
      await fs.cp(join(from, 'chapters'), join(to, 'chapters'), { recursive: true })
    }
  }

  /**
   * Snapshot both books before a merge. The merge itself writes the target
   * with `{ backup: false }`, so this combined point is the single undo unit.
   */
  async createMergeRestorePoint(
    targetId: string,
    sourceId: string,
    targetEntry: LibraryEntry,
    sourceEntry: LibraryEntry
  ): Promise<string> {
    assertBookId(targetId)
    assertBookId(sourceId)
    const parent = join(this.bookDir(targetId), 'backup')
    const base = `${timestampName()}-merge`
    let name = base
    let dir = join(parent, name)
    let suffix = 1
    while (await pathExists(dir)) {
      name = `${base}-${suffix++}`
      dir = join(parent, name)
    }

    try {
      await ensureDir(dir)
      await this.copyBookData(this.bookDir(targetId), join(dir, 'target-book'))
      await this.copyBookData(this.bookDir(sourceId), join(dir, 'source-book'))
      const manifest: BackupManifest = {
        version: 1,
        reason: 'merge',
        createdAt: new Date().toISOString(),
        targetEntry,
        sourceEntry,
        sourceId,
        sourceTitle: sourceEntry.title
      }
      await atomicWriteJson(join(dir, 'manifest.json'), manifest)
    } catch (reason) {
      await fs.rm(dir, { recursive: true, force: true })
      throw reason instanceof Error ? reason : new Error('创建合并备份失败')
    }
    return dir
  }

  /** Attach the pre-write library entry to an automatic backup. */
  async annotateBackup(
    backupDir: string,
    manifest: Omit<BackupManifest, 'version' | 'createdAt'>
  ): Promise<void> {
    await atomicWriteJson(join(backupDir, 'manifest.json'), {
      version: 1,
      createdAt: new Date().toISOString(),
      ...manifest
    } satisfies BackupManifest)
  }

  async listBackups(id: string): Promise<BackupInfo[]> {
    assertBookId(id)
    const root = join(this.bookDir(id), 'backup')
    let names: string[]
    try {
      const entries = await fs.readdir(root, { withFileTypes: true })
      names = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }

    const backups: BackupInfo[] = []
    for (const name of names) {
      if (!/^[0-9A-Za-z-]+$/.test(name)) continue
      const dir = join(root, name)
      const manifest = await readJson<BackupManifest>(join(dir, 'manifest.json'))
      const hasTargetFolder = await pathExists(join(dir, 'target-book', 'meta.json'))
      const bookRoot = manifest?.reason === 'merge' || hasTargetFolder ? join(dir, 'target-book') : dir
      const meta = await readJson<BookMeta>(join(bookRoot, 'meta.json'))
      if (!meta) continue
      let createdAt = manifest?.createdAt
      if (!createdAt) {
        try {
          createdAt = (await fs.stat(dir)).mtime.toISOString()
        } catch {
          createdAt = ''
        }
      }
      backups.push({
        name,
        createdAt,
        chapterCount: meta.chapters.length,
        reason: manifest?.reason ?? 'unknown',
        sourceTitle: manifest?.sourceTitle,
        hasSource: Boolean(manifest?.sourceId && (await pathExists(join(dir, 'source-book'))))
      })
    }
    return backups.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
  }

  async readBackup(id: string, name: string): Promise<BackupContents> {
    assertBookId(id)
    assertBackupName(name)
    const dir = join(this.bookDir(id), 'backup', name)
    if (!(await pathExists(dir))) throw new Error('找不到这个备份，可能已被删除')

    const manifest = await readJson<BackupManifest>(join(dir, 'manifest.json'))
    const hasTargetFolder = await pathExists(join(dir, 'target-book', 'meta.json'))
    const mergeLayout = manifest?.reason === 'merge' || hasTargetFolder
    const bookRoot = mergeLayout ? join(dir, 'target-book') : dir
    const meta = await readJson<BookMeta>(join(bookRoot, 'meta.json'))
    if (!meta) throw new Error('备份数据不完整，无法恢复')

    const chapters: CleanedChapter[] = []
    for (const chapter of meta.chapters) {
      const fileName = `${String(chapter.index).padStart(5, '0')}.txt`
      const text = await fs.readFile(join(bookRoot, 'chapters', fileName), 'utf8')
      chapters.push({
        title: chapter.title,
        level: chapter.level,
        startLine: chapter.startLine,
        paragraphs: splitParagraphs(text)
      })
    }
    const sourceText = await fs.readFile(join(bookRoot, 'source.txt'), 'utf8')
    const progress =
      (await readJson<ProgressFile>(join(bookRoot, 'progress.json'))) ?? {
        progress: null,
        bookmarks: []
      }
    const sourceBookDir = mergeLayout ? join(dir, 'source-book') : null

    return {
      files: { meta, sourceText, chapters },
      progress,
      manifest,
      sourceBookDir:
        sourceBookDir && (await pathExists(sourceBookDir)) ? sourceBookDir : null
    }
  }

  /** Copy a snapshot back as a separate book (used to undo a merge). */
  async restoreSource(entry: LibraryEntry, sourceBookDir: string): Promise<void> {
    assertBookId(entry.id)
    const destination = this.bookDir(entry.id)
    if (await pathExists(destination)) throw new Error('源书已存在，无法恢复合并前的状态')
    const tmp = join(this.booksDir(), `.restore-${entry.id}-${Date.now()}`)
    await fs.rm(tmp, { recursive: true, force: true })
    try {
      await fs.cp(sourceBookDir, tmp, { recursive: true })
      await fs.rename(tmp, destination)
    } catch (reason) {
      await fs.rm(tmp, { recursive: true, force: true })
      throw reason
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
        paragraphs: splitParagraphs(text)
      })
    }
    const original = await this.readOriginal(id)
    return { meta, sourceText: await this.readSource(id), chapters, original }
  }

  async readOriginal(id: string): Promise<Buffer | undefined> {
    try {
      return await fs.readFile(join(this.bookDir(id), 'original.bin'))
    } catch {
      return undefined
    }
  }

  /** Store the original bytes for books imported before this file was kept. */
  async writeOriginal(id: string, bytes: Buffer): Promise<void> {
    assertBookId(id)
    const target = join(this.bookDir(id), 'original.bin')
    const tmp = `${target}.tmp`
    await fs.writeFile(tmp, bytes)
    await fs.rename(tmp, target)
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
