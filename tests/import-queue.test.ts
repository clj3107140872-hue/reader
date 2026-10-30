import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportQueue } from '../src/main/services/importQueue'
import { ImportService } from '../src/main/services/import'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
let library: LibraryRepository
let books: BookRepository

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-import-queue-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeBookText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(`第${i}章 风起`, `这是第${i}章的正文。`, '')
  }
  return lines.join('\n')
}

describe('ImportQueue', () => {
  it('reports suspects with the newly imported source id', async () => {
    const first = join(root, '测试书_1-3章.txt')
    const second = join(root, '测试书_4-6章.txt')
    await writeFile(first, iconv.encode(makeBookText(1, 3), 'utf8'))
    await writeFile(second, iconv.encode(makeBookText(4, 6), 'utf8'))

    const queue = new ImportQueue(new ImportService(library, books))
    const summary = await queue.importFiles([first, second])

    const entries = await library.list()
    const source = entries.find((entry) => entry.sourceFileName === '测试书_4-6章.txt')
    const target = entries.find((entry) => entry.sourceFileName === '测试书_1-3章.txt')

    expect(summary.imported).toBe(2)
    expect(summary.suspects).toContainEqual(
      expect.objectContaining({
        sourceId: source?.id,
        sourceTitle: '测试书_4-6章',
        id: target?.id,
        title: '测试书_1-3章'
      })
    )
  })
})
