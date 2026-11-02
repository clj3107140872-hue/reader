import { describe, expect, it } from 'vitest'
import { splitParagraphs } from '../src/core/paragraphs'

describe('splitParagraphs', () => {
  it('splits on blank lines and trims each paragraph', () => {
    expect(splitParagraphs('第一段\n\n  第二段  \n\n\n第三段')).toEqual([
      '第一段',
      '第二段',
      '第三段'
    ])
  })

  it('returns an empty list for blank text', () => {
    expect(splitParagraphs('\n\n  \n')).toEqual([])
  })
})
