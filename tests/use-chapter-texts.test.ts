import { describe, expect, it } from 'vitest'
import { needsLoad, mergeChapterText } from '../src/renderer/src/reader/useChapterTexts'
import { chapterForPercent, percentForChapter } from '../src/renderer/src/reader/position'

describe('useChapterTexts helpers', () => {
  it('loads only enabled, absent and not-requested indexes', () => {
    expect(needsLoad(2, true, new Set([1]), new Set())).toBe(true)
    expect(needsLoad(1, true, new Set([1]), new Set())).toBe(false)
    expect(needsLoad(3, false, new Set(), new Set())).toBe(false)
    expect(needsLoad(4, true, new Set(), new Set([4]))).toBe(false)
  })

  it('merges a resolved text without dropping other chapters', () => {
    expect(mergeChapterText({ 1: 'a' }, 2, 'b')).toEqual({ 1: 'a', 2: 'b' })
  })
})

describe('network progress helpers', () => {
  it('maps a chapter index to a percent and back', () => {
    expect(percentForChapter(100, 0)).toBe(0)
    expect(percentForChapter(100, 50)).toBe(50)
    expect(percentForChapter(100, 99)).toBe(99)
    expect(percentForChapter(0, 5)).toBe(0)
    expect(chapterForPercent(100, 50)).toBe(50)
    expect(chapterForPercent(100, 100)).toBe(99)
    expect(chapterForPercent(0, 100)).toBe(0)
  })
})
