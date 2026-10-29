import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import iconv from 'iconv-lite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ImportService } from '../src/main/services/import'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-import-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function makeBookText(from: number, to: number): string {
  const lines: string[] = []
  for (let i = from; i <= to; i++) {
    lines.push(
      `第${i}章 风起云涌`,
      `这是第${i}章的正文内容，用来测试导入流程是否稳定。`,
      'www.example-ad.com',
      `第${i}章的更多正文，故事继续向前推进。`,
      ''
    )
  }
  return lines.join('\n')
}

describe('ImportService', () => {
  it('imports a file and records it in the library', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '斗罗大陆_1-50章.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 50), 'gbk'))

    const outcome = await service.importFile(file)
    if ('duplicate' in outcome) throw new Error('unexpected duplicate')

    expect(outcome.entry.chapterCount).toBe(50)
    expect(outcome.entry.encoding).toBe('gb18030')
    expect(outcome.entry.stats.adLinesRemoved).toBe(50)
    expect((await library.list())).toHaveLength(1)
    expect((await books.readMeta(outcome.entry.id)).chapters).toHaveLength(50)
  })

  it('rejects the same file twice by content hash', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '重复.txt')
    await writeFile(file, iconv.encode(makeBookText(1, 3), 'utf8'))
    await service.importFile(file)

    const second = await service.importFile(file)
    expect(second).toMatchObject({ duplicate: true, title: '重复' })
  })

  it('reports a suspect when the second volume shares the normalized title', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const first = join(root, '斗罗大陆_1-50章.txt')
    const second = join(root, '斗罗大陆_51-100章.txt')
    await writeFile(first, iconv.encode(makeBookText(1, 50), 'utf8'))
    await writeFile(second, iconv.encode(makeBookText(51, 100), 'utf8'))

    const firstOutcome = await service.importFile(first)
    if ('duplicate' in firstOutcome) throw new Error('unexpected duplicate')

    const secondOutcome = await service.importFile(second)
    if ('duplicate' in secondOutcome) throw new Error('unexpected duplicate')

    const suspect = secondOutcome.suspects.find((item) => item.id === firstOutcome.entry.id)
    expect(suspect).toBeDefined()
    expect(suspect?.title).toBe('斗罗大陆_1-50章')
    expect((await library.list())).toHaveLength(2)
  })

  it('does not fail an import when another book entry is damaged', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const damaged = join(root, '损坏.txt')
    await writeFile(damaged, iconv.encode(makeBookText(1, 3), 'utf8'))
    const first = await service.importFile(damaged)
    if ('duplicate' in first) throw new Error('unexpected duplicate')

    await rm(join(root, 'books', first.entry.id), { recursive: true, force: true })

    const file = join(root, '新书.txt')
    await writeFile(file, iconv.encode(makeBookText(10, 12), 'utf8'))
    const outcome = await service.importFile(file)
    if ('duplicate' in outcome) throw new Error('unexpected duplicate')

    expect(outcome.entry.chapterCount).toBe(3)
    expect(await library.list()).toHaveLength(2)
  })

  it('propagates parse errors without touching the library', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '空.txt')
    await writeFile(file, Buffer.from('   \n\n   '))
    await expect(service.importFile(file)).rejects.toThrow('文件没有可阅读的正文')
    expect(await library.list()).toEqual([])
  })

  it('surfaces repair warnings from the parser', async () => {
    const library = new LibraryRepository(root)
    const books = new BookRepository(root)
    const service = new ImportService(library, books)

    const file = join(root, '乱码.txt')
    const text = makeBookText(1, 3).replace(
      '这是第1章的正文内容，用来测试导入流程是否稳定。',
      '正文开始锟斤拷锟斤拷正文继续。'
    )
    await writeFile(file, iconv.encode(text, 'utf8'))

    const outcome = await service.importFile(file)
    if ('duplicate' in outcome) throw new Error('unexpected duplicate')
    expect(outcome.warnings).toContain('部分乱码内容无法恢复，已清除')
  })
})
