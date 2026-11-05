import { describe, expect, it } from 'vitest'
import { chapterWindow } from '../src/renderer/src/reader/chapterWindow'

describe('chapterWindow', () => {
  it('keeps one chapter on each side of the reading position', () => {
    expect(chapterWindow(928, 500)).toEqual({ start: 499, end: 502 })
  })

  it('starts at the first chapter near the beginning of the book', () => {
    expect(chapterWindow(928, 0)).toEqual({ start: 0, end: 3 })
    expect(chapterWindow(928, 1)).toEqual({ start: 0, end: 3 })
  })

  it('ends at the last chapter near the end of the book', () => {
    expect(chapterWindow(928, 927)).toEqual({ start: 925, end: 928 })
    expect(chapterWindow(928, 926)).toEqual({ start: 925, end: 928 })
  })

  it('renders short books whole', () => {
    expect(chapterWindow(1, 0)).toEqual({ start: 0, end: 1 })
    expect(chapterWindow(2, 1)).toEqual({ start: 0, end: 2 })
    expect(chapterWindow(0, 0)).toEqual({ start: 0, end: 0 })
  })

  it('clamps an out-of-range position', () => {
    expect(chapterWindow(928, -5)).toEqual({ start: 0, end: 3 })
    expect(chapterWindow(928, 2000)).toEqual({ start: 925, end: 928 })
  })
})
