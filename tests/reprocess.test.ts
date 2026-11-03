import { describe, expect, it } from 'vitest'
import type { BookMeta } from '../src/core/model'
import { chapterFromLines, chaptersFromLines } from '../src/core/reprocess'

function meta(): BookMeta {
  return {
    version: 1,
    id: 'a',
    title: '测试书',
    encoding: 'utf8',
    chapters: [
      {
        index: 0,
        title: '第一章',
        level: 'chapter',
        titleHash: 'a',
        startLine: 0,
        charCount: 0,
        simhash: '0',
        flags: {}
      },
      {
        index: 1,
        title: '第二章',
        level: 'chapter',
        titleHash: 'b',
        startLine: 3,
        charCount: 0,
        simhash: '0',
        flags: {}
      }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

function metaWith(chapters: Array<{ title: string; startLine: number }>): BookMeta {
  return {
    version: 1,
    id: 'a',
    title: '测试书',
    encoding: 'utf8',
    chapters: chapters.map((chapter, index) => ({
      index,
      title: chapter.title,
      level: 'chapter' as const,
      titleHash: String(index),
      startLine: chapter.startLine,
      charCount: 0,
      simhash: '0',
      flags: {}
    })),
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('chaptersFromLines', () => {
  it('rebuilds chapter paragraphs from saved line numbers', () => {
    const chapters = chaptersFromLines('第一章\n甲。\n\n第二章\n乙。\n丙。', meta())
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['甲。'], ['乙。', '丙。']])
    expect(chapters.map((chapter) => chapter.startLine)).toEqual([0, 3])
  })

  it('keeps the first line of a synthetic preface chapter', () => {
    const chapters = chaptersFromLines(
      '前言段。\n第一章\n甲。\n第二章\n乙。\n第三章\n丙。',
      metaWith([
        { title: '前言', startLine: 0 },
        { title: '第一章', startLine: 1 },
        { title: '第二章', startLine: 3 },
        { title: '第三章', startLine: 5 }
      ])
    )
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([
      ['前言段。'],
      ['甲。'],
      ['乙。'],
      ['丙。']
    ])
  })

  it('keeps the first line of a no-title chapter', () => {
    const chapters = chaptersFromLines('开头。\n第二段。', metaWith([{ title: '正文', startLine: 0 }]))
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['开头。', '第二段。']])
  })
})

describe('chapterFromLines', () => {
  it('rebuilds only the requested chapter', () => {
    const chapter = chapterFromLines('第一章\n甲。\n第二章\n乙。\n丙。', meta(), 1)
    expect(chapter).toEqual({ title: '第二章', level: 'chapter', startLine: 3, paragraphs: ['乙。', '丙。'] })
  })
})
