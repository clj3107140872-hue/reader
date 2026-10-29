import { describe, expect, it } from 'vitest'
import {
  chapterTitleHash,
  cnNumberToInt,
  parseChapterOrdinal,
  splitAtMarkerLines,
  splitChapters
} from '../src/core/chapters'

const sample = [
  '第一章 风起',
  '正文第一段。',
  '他翻到第三章。',
  '第二章 云涌',
  '正文第二段。',
  '【第三章】雨落',
  '正文第三段。'
].join('\n')

describe('splitChapters', () => {
  it('splits common chapter titles and ignores sentence look-alikes', () => {
    const result = splitChapters(sample)
    expect(result.detected).toBe(true)
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 风起', '第二章 云涌', '【第三章】雨落'])
    expect(result.chapters[0].paragraphs).toEqual(['正文第一段。', '他翻到第三章。'])
  })

  it('treats short text without markers as one chapter', () => {
    const result = splitChapters('只有一段文字，没有任何章节。')
    expect(result.detected).toBe(false)
    expect(result.chapters).toHaveLength(1)
    expect(result.chapters[0].title).toBe('正文')
    expect(result.chapters[0].paragraphs).toEqual(['只有一段文字，没有任何章节。'])
  })

  it('splits at manually supplied marker lines', () => {
    const text = ['第一章 甲', '内容一', '第二章 乙', '内容二'].join('\n')
    const result = splitAtMarkerLines(text, [0, 2])
    expect(result.chapters.map((c) => c.title)).toEqual(['第一章 甲', '第二章 乙'])
    expect(result.chapters[0].paragraphs).toEqual(['内容一'])
  })
})

describe('chapter numbering', () => {
  it('parses Chinese numerals', () => {
    expect(cnNumberToInt('五百零二')).toBe(502)
    expect(cnNumberToInt('十二')).toBe(12)
    expect(cnNumberToInt('三')).toBe(3)
    expect(cnNumberToInt('abc')).toBeNull()
  })

  it('hash-normalizes Arabic and Chinese chapter numbers equally', () => {
    expect(chapterTitleHash('第12章 风起')).toBe(chapterTitleHash('第十二章 风起'))
  })

  it('extracts chapter ordinals', () => {
    expect(parseChapterOrdinal('第五百零二章 决战')).toBe(502)
    expect(parseChapterOrdinal('序章')).toBeNull()
  })
})
