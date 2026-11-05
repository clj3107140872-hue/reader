import { describe, expect, it } from 'vitest'
import {
  countChapterLines,
  estimateChapterHeight,
  estimateTextEm
} from '../src/renderer/src/reader/chapterSize'

const metrics = {
  lineEm: 50,
  lineHeightPx: 25.2,
  fontSizePx: 14,
  paragraphGapPx: 11.2
}

describe('estimateTextEm', () => {
  it('counts Chinese characters at one em each', () => {
    expect(estimateTextEm('你好世界')).toBe(4)
    expect(estimateTextEm('，。！？')).toBe(4)
  })

  it('counts Latin text narrower than Chinese', () => {
    expect(estimateTextEm('hello')).toBeLessThan(5)
    expect(estimateTextEm('hello')).toBeGreaterThan(2)
    expect(estimateTextEm('')).toBe(0)
  })
})

describe('countChapterLines', () => {
  it('fits text on the first line after the paragraph indent', () => {
    // A 50em line leaves 48em for the first line once the 2em indent is taken.
    expect(countChapterLines(0, 50)).toBe(0)
    expect(countChapterLines(40, 50)).toBe(1)
    expect(countChapterLines(48, 50)).toBe(1)
    expect(countChapterLines(49, 50)).toBe(2)
    expect(countChapterLines(98, 50)).toBe(2)
    expect(countChapterLines(99, 50)).toBe(3)
  })
})

describe('estimateChapterHeight', () => {
  it('grows when text wraps onto more lines', () => {
    const oneLine = estimateChapterHeight(8, [40], metrics, false)
    const twoLines = estimateChapterHeight(8, [80], metrics, false)
    expect(twoLines).toBeGreaterThan(oneLine)
  })

  it('grows with every paragraph it contains', () => {
    expect(estimateChapterHeight(8, [40, 40], metrics, false)).toBeGreaterThan(
      estimateChapterHeight(8, [40], metrics, false)
    )
  })

  it('reserves more room for a volume heading', () => {
    expect(estimateChapterHeight(8, [40], metrics, true)).toBeGreaterThan(
      estimateChapterHeight(8, [40], metrics, false)
    )
  })

  it('wraps a long title onto extra lines', () => {
    const short = estimateChapterHeight(8, [40], metrics, false)
    const long = estimateChapterHeight(120, [40], metrics, false)
    expect(long - short).toBeGreaterThan(metrics.lineHeightPx)
  })

  it('never returns zero height, even for an empty chapter', () => {
    expect(estimateChapterHeight(0, [], metrics, false)).toBeGreaterThan(0)
  })
})
