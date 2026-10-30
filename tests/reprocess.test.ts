import { describe, expect, it } from 'vitest'
import type { BookMeta } from '../src/core/model'
import { chaptersFromLines } from '../src/core/reprocess'

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

describe('chaptersFromLines', () => {
  it('rebuilds chapter paragraphs from saved line numbers', () => {
    const chapters = chaptersFromLines('第一章\n甲。\n\n第二章\n乙。\n丙。', meta())
    expect(chapters.map((chapter) => chapter.paragraphs)).toEqual([['甲。'], ['乙。', '丙。']])
    expect(chapters.map((chapter) => chapter.startLine)).toEqual([0, 3])
  })
})
