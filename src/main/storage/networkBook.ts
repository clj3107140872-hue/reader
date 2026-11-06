import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { assertBookId } from '../bookId'
import type { BookMeta } from '../../core/model'
import { atomicWriteJson, ensureDir, pathExists, readJson } from './fsUtil'

function fileName(index: number): string {
  return `${String(index).padStart(5, '0')}.txt`
}

export class NetworkBookRepository {
  constructor(private readonly root: string) {}

  private bookDir(id: string): string {
    assertBookId(id)
    return join(this.root, 'books', id)
  }

  async create(meta: BookMeta): Promise<void> {
    const dir = this.bookDir(meta.id)
    await ensureDir(join(dir, 'chapters'))
    await ensureDir(join(dir, 'raw'))
    await atomicWriteJson(join(dir, 'meta.json'), meta)
  }

  async writeMeta(id: string, meta: BookMeta): Promise<void> {
    await atomicWriteJson(join(this.bookDir(id), 'meta.json'), meta)
  }

  async readMeta(id: string): Promise<BookMeta> {
    const meta = await readJson<BookMeta>(join(this.bookDir(id), 'meta.json'))
    if (!meta) throw new Error(`书籍数据缺失：${id}`)
    return meta
  }

  async listCachedChapters(id: string): Promise<number[]> {
    let names: string[]
    try {
      names = await fs.readdir(join(this.bookDir(id), 'chapters'))
    } catch {
      return []
    }
    const cached: number[] = []
    for (const name of names) {
      const match = /^(\d{5})\.txt$/.exec(name)
      if (!match) continue
      try {
        const stat = await fs.stat(join(this.bookDir(id), 'chapters', name))
        if (stat.size > 0) cached.push(Number(match[1]))
      } catch {
        // A disappearing file is simply not cached.
      }
    }
    return cached.sort((a, b) => a - b)
  }

  async readChapterText(id: string, index: number): Promise<string | null> {
    try {
      const text = await fs.readFile(join(this.bookDir(id), 'chapters', fileName(index)), 'utf8')
      return text.trim() ? text : null
    } catch {
      return null
    }
  }

  async readRawChapter(id: string, index: number): Promise<string | null> {
    try {
      const text = await fs.readFile(join(this.bookDir(id), 'raw', fileName(index)), 'utf8')
      return text.trim() ? text : null
    } catch {
      return null
    }
  }

  async writeChapter(id: string, index: number, raw: string, cleaned: string): Promise<void> {
    const dir = this.bookDir(id)
    await ensureDir(join(dir, 'raw'))
    await ensureDir(join(dir, 'chapters'))
    await this.atomicWrite(join(dir, 'raw', fileName(index)), raw)
    await this.atomicWrite(join(dir, 'chapters', fileName(index)), cleaned)
  }

  private async atomicWrite(path: string, text: string): Promise<void> {
    const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
    await fs.writeFile(tmp, text, 'utf8')
    await fs.rename(tmp, path)
  }

  async exists(id: string): Promise<boolean> {
    return pathExists(this.bookDir(id))
  }
}
