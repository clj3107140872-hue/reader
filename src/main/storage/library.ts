import { join } from 'node:path'
import type { LibraryEntry } from '../../core/model'
import { atomicWriteJson, readJson } from './fsUtil'

interface LibraryFile {
  version: 1
  entries: LibraryEntry[]
}

export class LibraryRepository {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'library.json')
  }

  async list(): Promise<LibraryEntry[]> {
    const main = await readJson<LibraryFile>(this.file)
    if (main?.entries) return main.entries
    const backup = await readJson<LibraryFile>(`${this.file}.bak`)
    return backup?.entries ?? []
  }

  async save(entries: LibraryEntry[]): Promise<void> {
    await atomicWriteJson(this.file, { version: 1, entries })
  }

  async add(entry: LibraryEntry): Promise<void> {
    const entries = await this.list()
    if (entries.some((existing) => existing.id === entry.id)) return
    entries.push(entry)
    await this.save(entries)
  }

  async update(id: string, patch: Partial<LibraryEntry>): Promise<void> {
    const entries = await this.list()
    const index = entries.findIndex((entry) => entry.id === id)
    if (index < 0) return
    entries[index] = { ...entries[index], ...patch }
    await this.save(entries)
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((entry) => entry.id !== id))
  }

  async findByFileHash(fileHash: string): Promise<LibraryEntry | null> {
    const entries = await this.list()
    return entries.find((entry) => entry.fileHash === fileHash) ?? null
  }
}
