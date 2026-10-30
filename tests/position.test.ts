import { describe, expect, it } from 'vitest'
import type { BookMeta } from '../src/core/model'
import {
  chapterCharStarts,
  chapterIndexForPercent,
  charsBefore,
  nearestIndexByTop,
  percentAt,
  positionForPercent,
  resolveChapterIndex,
  totalChars
} from '../src/renderer/src/reader/position'

function meta(): BookMeta {
  return {
    version: 1,
    id: 'b',
    title: '书',
    encoding: 'utf8',
    chapters: [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'h1', startLine: 0, charCount: 10, simhash: '1', flags: {} },
      { index: 1, title: '第二章', level: 'chapter', titleHash: 'h2', startLine: 2, charCount: 10, simhash: '2', flags: {} }
    ],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

const paragraphs = [['12345', '12345'], ['12345', '12345']]

describe('reader position', () => {
  it('maps chapters to cumulative character offsets', () => {
    expect(chapterCharStarts(meta())).toEqual([0, 10])
    expect(totalChars(meta())).toBe(20)
    expect(charsBefore(meta(), 0, 1, paragraphs)).toBe(5)
    expect(charsBefore(meta(), 1, 0, paragraphs)).toBe(10)
    expect(percentAt(meta(), 0, 1, paragraphs)).toBe(25)
    expect(percentAt(meta(), 1, 0, paragraphs)).toBe(50)
  })

  it('returns zero percent for a book without characters', () => {
    const empty: BookMeta = { ...meta(), chapters: [] }
    expect(totalChars(empty)).toBe(0)
    expect(percentAt(empty, 0, 0, [])).toBe(0)
    expect(chapterIndexForPercent(empty, 50)).toBe(0)
  })

  it('locates a chapter by percentage', () => {
    expect(chapterIndexForPercent(meta(), 0)).toBe(0)
    expect(chapterIndexForPercent(meta(), 60)).toBe(1)
    expect(chapterIndexForPercent(meta(), 100)).toBe(1)
  })

  it('prefers the title hash and falls back to the chapter index', () => {
    expect(resolveChapterIndex(meta(), 'h2', 0)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', 1)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', 99)).toBe(1)
    expect(resolveChapterIndex(meta(), 'missing', -5)).toBe(0)
  })

  it('picks the matching chapter closest to the saved index when titles repeat', () => {
    const repeated: BookMeta = {
      ...meta(),
      chapters: [
        { ...meta().chapters[0], titleHash: 'same' },
        { ...meta().chapters[1], titleHash: 'same' },
        { ...meta().chapters[1], index: 2, titleHash: 'h3' }
      ]
    }
    expect(resolveChapterIndex(repeated, 'same', 0)).toBe(0)
    expect(resolveChapterIndex(repeated, 'same', 1)).toBe(1)
    expect(resolveChapterIndex(repeated, 'same', 2)).toBe(1)
  })

  it('finds the last top boundary at or above the probe point', () => {
    expect(nearestIndexByTop([100, 200, 300], 50)).toBe(0)
    expect(nearestIndexByTop([100, 200, 300], 150)).toBe(0)
    expect(nearestIndexByTop([100, 200, 300], 250)).toBe(1)
    expect(nearestIndexByTop([100, 200, 300], 400)).toBe(2)
    expect(nearestIndexByTop([100, 200, 300], 100)).toBe(0)
    expect(nearestIndexByTop([100, 200, 300], 300)).toBe(2)
    expect(nearestIndexByTop([], 400)).toBe(0)
  })

  it('maps a percent inside a single chapter to a mid-chapter paragraph', () => {
    const single: BookMeta = { ...meta(), chapters: [{ ...meta().chapters[0], charCount: 40 }] }
    const chapterParagraphs = [
      ['a'.repeat(10), 'b'.repeat(10), 'c'.repeat(10), 'd'.repeat(10)]
    ]
    expect(positionForPercent(single, 50, chapterParagraphs)).toEqual({
      chapterIndex: 0,
      paragraphIndex: 2
    })
  })

  it('maps a percent inside the last chapter to a mid-chapter paragraph', () => {
    expect(positionForPercent(meta(), 75, paragraphs)).toEqual({ chapterIndex: 1, paragraphIndex: 1 })
  })

  it('maps 100 percent to the last paragraph of the last chapter', () => {
    expect(positionForPercent(meta(), 100, paragraphs)).toEqual({ chapterIndex: 1, paragraphIndex: 1 })
  })

  it('falls back to the first position for a book without characters', () => {
    const empty: BookMeta = { ...meta(), chapters: [] }
    expect(positionForPercent(empty, 50, [])).toEqual({ chapterIndex: 0, paragraphIndex: 0 })
    const zeroChars: BookMeta = { ...meta(), chapters: [{ ...meta().chapters[0], charCount: 0 }] }
    expect(positionForPercent(zeroChars, 50, [['x']])).toEqual({ chapterIndex: 0, paragraphIndex: 0 })
  })
})
