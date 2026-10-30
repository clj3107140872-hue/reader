import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SearchService } from '../src/main/services/search'
import { BookRepository } from '../src/main/storage/book'
import type { BookMeta } from '../src/core/model'

let root = ''
let books: BookRepository
let service: SearchService

function meta(): BookMeta {
  return {
    version: 1,
    id: 'b',
    title: '搜索测试',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'h1', startLine: 0, charCount: 20, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'h2', startLine: 2, charCount: 20, simhash: '2', flags: {} },
      { index: 2, title: '第三章', level: 'chapter', titleHash: 'h3', startLine: 4, charCount: 20, simhash: '3', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

async function writeMatchBook(count: number): Promise<void> {
  const paragraphs = Array.from({ length: count }, (_, index) => `第${index}段 关键词命中`)
  await books.writeBook({
    meta: {
      version: 1,
      id: 'm',
      title: '命中测试',
      encoding: 'utf8',
      chapters: [
        {
          index: 0,
          title: '正文',
          level: 'chapter',
          titleHash: 'hm',
          startLine: 0,
          charCount: paragraphs.join('').length,
          simhash: 'm',
          flags: {}
        }
      ],
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    sourceText: '原文',
    chapters: [{ title: '正文', level: 'chapter', startLine: 0, paragraphs }]
  })
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-search-'))
  books = new BookRepository(root)
  service = new SearchService(books)
  await books.writeBook({
    meta: meta(),
    sourceText: '原文',
    chapters: [
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['开场白。', '这里有正文内容。'] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['第二章正文。'] },
      { title: '第三章', level: 'chapter', startLine: 4, paragraphs: ['包含 .* 和 [ 符号的段落。'] }
    ]
  })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('SearchService', () => {
  it('returns hits in chapter and paragraph order', async () => {
    const result = await service.search('b', '正文', 't1', () => undefined)
    expect(result.hits.map((hit) => [hit.chapterIndex, hit.paragraphIndex])).toEqual([
      [0, 1],
      [1, 0]
    ])
    expect(result.hits[0].chapterKey).toBe('h1')
    expect(result.hits[0].excerpt).toContain('正文')
    expect(result.cancelled).toBe(false)
  })

  it('treats regular expression characters as literal text', async () => {
    const result = await service.search('b', '.*', 't2', () => undefined)
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0].chapterIndex).toBe(2)
  })

  it('returns early when the token was cancelled', async () => {
    service.cancel('t3')
    const result = await service.search('b', '正文', 't3', () => undefined)
    expect(result.cancelled).toBe(true)
    expect(result.hits).toEqual([])
  })

  it('does not report truncation when exactly 300 matches exist', async () => {
    await writeMatchBook(300)
    const exact = await service.search('m', '关键词', 't4', () => undefined)
    expect(exact.hits).toHaveLength(300)
    expect(exact.truncated).toBe(false)
  })

  it('reports truncation when a 301st match exists', async () => {
    await writeMatchBook(301)
    const capped = await service.search('m', '关键词', 't5', () => undefined)
    expect(capped.hits).toHaveLength(300)
    expect(capped.truncated).toBe(true)
  })
})
