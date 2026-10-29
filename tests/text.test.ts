import { describe, expect, it } from 'vitest'
import { fnv1a, normalizeForHash, stripZeroWidth, toHalfWidth } from '../src/core/text'

describe('text utils', () => {
  it('converts full-width characters to half-width', () => {
    expect(toHalfWidth('ＡＢＣ１２３')).toBe('ABC123')
  })

  it('strips zero-width characters', () => {
    expect(stripZeroWidth('小\u200b说\ufeff')).toBe('小说')
  })

  it('produces stable 8-char hashes', () => {
    expect(fnv1a('第一章')).toHaveLength(8)
    expect(fnv1a('第一章')).toBe(fnv1a('第一章'))
    expect(fnv1a('第一章')).not.toBe(fnv1a('第二章'))
  })

  it('normalizes punctuation and whitespace for hashing', () => {
    expect(normalizeForHash('第 一 章。')).toBe('第一章')
  })
})
