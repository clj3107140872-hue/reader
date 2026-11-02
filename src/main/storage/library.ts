import { join } from 'node:path'
import type { LibraryEntry } from '../../core/model'
import { atomicWriteJson, readJson } from './fsUtil'
import { Mutex } from './mutex'

interface LibraryFile {
  version: 1
  entries: LibraryEntry[]
}

export class LibraryRepository {
  private readonly mutex = new Mutex()

  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'library.json')
  }

  async list(): Promise<LibraryEntry[]> {
    const main = await readJson<LibraryFile>(this.file)
    if (main && Array.isArray(main.entries)) return main.entries
    const backup = await readJson<LibraryFile>(`${this.file}.bak`)
    return backup && Array.isArray(backup.entries) ? backup.entries : []
  }

  /**
   * Restore `library.json` from its backup when the main file is missing or
   * unreadable. Runs once at startup before the window lists the shelf.
   */
  async repair(): Promise<{ restored: boolean }> {
    return this.runExclusive(async () => {
      const main = await readJson<LibraryFile>(this.file)
      if (main && Array.isArray(main.entries)) return { restored: false }
      const backup = await readJson<LibraryFile>(`${this.file}.bak`)
      if (!backup || !Array.isArray(backup.entries)) return { restored: false }
      await atomicWriteJson(this.file, backup, false)
      return { restored: true }
    })
  }

  /** Runs a read-modify-write against the library without interleaving. */
  runExclusive<T>(task: () => Promise<T>): Promise<T> {
    return this.mutex.runExclusive(task)
  }

  /** Only call while holding runExclusive (repository mutations do this). */
  async save(entries: LibraryEntry[]): Promise<void> {
    await atomicWriteJson(this.file, { version: 1, entries })
  }

  async add(entry: LibraryEntry): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.list()
      if (entries.some((existing) => existing.id === entry.id)) return
      entries.push(entry)
      await this.save(entries)
    })
  }

  async update(id: string, patch: Partial<LibraryEntry>): Promise<void> {
    await this.runExclusive(async () => {
      const entries = await this.list()
      const index = entries.findIndex((entry) => entry.id === id)
      if (index < 0) return
      entries[index] = { ...entries[index], ...patch }
      await this.save(entries)
    })
  }

  async remove(id: string): Promise<void> {
    await this.runExclusive(async () => {
      await this.save((await this.list()).filter((entry) => entry.id !== id))
    })
  }

  async findByFileHash(fileHash: string): Promise<LibraryEntry | null> {
    const entries = await this.list()
    return (
      entries.find(
        (entry) => entry.fileHash === fileHash || entry.fileHashes?.includes(fileHash)
      ) ?? null
    )
  }
}
