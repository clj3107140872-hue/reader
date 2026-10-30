import { describe, expect, it } from 'vitest'
import { splitChapters } from '../src/core/chapters'
import { buildBookDocuments } from '../src/core/compose'

describe('buildBookDocuments', () => {
  it('rebuilds source text and line numbers from merged chapters', () => {
    const documents = buildBookDocuments({
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      createdAt: '2026-01-01T00:00:00.000Z',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 99, paragraphs: ['第一段。', '第二段。'] },
        { title: '第二章', level: 'chapter', startLine: 99, paragraphs: ['第三段。'] },
        { title: '第三章', level: 'chapter', startLine: 99, paragraphs: ['第四段。'] }
      ]
    })

    expect(documents.chapters.map((chapter) => chapter.startLine)).toEqual([0, 5, 8])
    expect(documents.sourceText.split('\n').filter(Boolean)).toEqual([
      '第一章',
      '第一段。',
      '第二段。',
      '第二章',
      '第三段。',
      '第三章',
      '第四段。'
    ])
    expect(documents.meta.chapters.map((chapter) => chapter.title)).toEqual([
      '第一章',
      '第二章',
      '第三章'
    ])

    const resplit = splitChapters(documents.sourceText)
    expect(resplit.detected).toBe(true)
    expect(resplit.chapters.map((chapter) => [chapter.title, chapter.paragraphs])).toEqual([
      ['第一章', ['第一段。', '第二段。']],
      ['第二章', ['第三段。']],
      ['第三章', ['第四段。']]
    ])
  })

  it('keeps an existing source and its chapter line numbers', () => {
    const documents = buildBookDocuments({
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      createdAt: '2026-01-01T00:00:00.000Z',
      sourceText: '第一章\n原文。\n第二章\n更多。',
      chapters: [
        { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['原文。'] },
        { title: '第二章', level: 'chapter', startLine: 2, paragraphs: ['更多。'] }
      ]
    })

    expect(documents.sourceText).toBe('第一章\n原文。\n第二章\n更多。')
    expect(documents.chapters.map((chapter) => chapter.startLine)).toEqual([0, 2])
    expect(documents.meta.chapters.map((chapter) => chapter.startLine)).toEqual([0, 2])
  })
})
