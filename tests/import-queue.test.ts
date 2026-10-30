import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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

  it('skips non-txt files and directories with readable warnings', async () => {
    const jpg = join(root, '封面.jpg')
    const folder = join(root, '文件夹.txt')
    await writeFile(jpg, 'not a book')
    await mkdir(folder)

    const queue = new ImportQueue(new ImportService(library, books))
    const summary = await queue.importFiles([jpg, folder])

    expect(summary.imported).toBe(0)
    expect(summary.warnings.join('')).toContain('只支持 TXT 文件')
    expect(summary.warnings.join('')).toContain('不是文件')
    expect(await library.list()).toEqual([])
  })

  it('asks before importing a large file and respects the answer', async () => {
    const file = join(root, '大书.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
    const calls: { fileName: string; size: number }[] = []

    const rejected = new ImportQueue(new ImportService(library, books), {
      largeFileBytes: 10,
      confirmLargeFile: async (info) => {
        calls.push(info)
        return false
      }
    })
    const skipped = await rejected.importFiles([file])
    expect(skipped.imported).toBe(0)
    expect(calls[0].fileName).toBe('大书.txt')
    expect(calls[0].size).toBeGreaterThan(10)
    expect(skipped.warnings.join('')).toContain('已跳过')

    const accepted = new ImportQueue(new ImportService(library, books), {
      largeFileBytes: 10,
      confirmLargeFile: async () => true
    })
    const imported = await accepted.importFiles([file])
    expect(imported.imported).toBe(1)
  })

  it('reports missing files without aborting the batch', async () => {
    const queue = new ImportQueue(new ImportService(library, books))
    const summary = await queue.importFiles([join(root, '不存在.txt')])

    expect(summary.errors).toEqual([])
    expect(summary.warnings[0]).toContain('无法读取文件信息')
  })

  it('emits import stages in order', async () => {
    const file = join(root, '阶段.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
    const stages: string[] = []

    const queue = new ImportQueue(new ImportService(library, books))
    await queue.importFiles([file], ({ stage }) => stages.push(stage))

    expect(stages).toEqual(['reading', 'parsing', 'writing', 'done'])
  })
})
