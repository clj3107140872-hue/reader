import { describe, expect, it } from 'vitest'
import {
  pageCountFor,
  pageIndexForOffset,
  scrollLeftForPage,
  wheelPageStep
} from '../src/renderer/src/reader/pagination'

describe('pageCountFor', () => {
  it('counts the columns that carry content', () => {
    // Three 400px columns with 20px gaps have a scroll width of 1240px.
    expect(pageCountFor(1240, 400, 20)).toBe(3)
    expect(pageCountFor(400, 400, 20)).toBe(1)
  })

  it('tolerates subpixel scroll widths', () => {
    expect(pageCountFor(1240.4, 400, 20)).toBe(3)
    expect(pageCountFor(1239.6, 400, 20)).toBe(3)
  })

  it('treats missing layout as a single page', () => {
    expect(pageCountFor(0, 0, 20)).toBe(1)
    expect(pageCountFor(0, 400, 20)).toBe(1)
  })
})

describe('pageIndexForOffset', () => {
  it('maps a column offset to its page', () => {
    expect(pageIndexForOffset(0, 400, 20)).toBe(0)
    expect(pageIndexForOffset(420, 400, 20)).toBe(1)
    expect(pageIndexForOffset(840, 400, 20)).toBe(2)
  })

  it('treats a subpixel-rounded column start as that column', () => {
    expect(pageIndexForOffset(419.6, 400, 20)).toBe(1)
  })

  it('keeps an offset inside a column on that page', () => {
    expect(pageIndexForOffset(200, 400, 20)).toBe(0)
    expect(pageIndexForOffset(630, 400, 20)).toBe(1)
  })
})

describe('scrollLeftForPage', () => {
  it('advances by one column plus the gap', () => {
    expect(scrollLeftForPage(0, 400, 20)).toBe(0)
    expect(scrollLeftForPage(3, 400, 20)).toBe(1260)
    expect(scrollLeftForPage(-2, 400, 20)).toBe(0)
  })
})

describe('wheelPageStep', () => {
  it('turns a page once a hundred pixels accumulate', () => {
    expect(wheelPageStep(30, 0, 0)).toEqual({ turn: 0, travel: 30 })
    expect(wheelPageStep(30, 0, 30)).toEqual({ turn: 0, travel: 60 })
    expect(wheelPageStep(40, 0, 60)).toEqual({ turn: 1, travel: 0 })
    expect(wheelPageStep(-120, 0, 0)).toEqual({ turn: -1, travel: 0 })
  })

  it('scales line and page mode deltas', () => {
    expect(wheelPageStep(5, 1, 0)).toEqual({ turn: 1, travel: 0 })
    expect(wheelPageStep(1, 2, 0)).toEqual({ turn: 1, travel: 0 })
  })

  it('drops the accumulated travel when the wheel reverses', () => {
    expect(wheelPageStep(-30, 0, 80)).toEqual({ turn: 0, travel: -30 })
    expect(wheelPageStep(30, 0, -30)).toEqual({ turn: 0, travel: 30 })
  })
})
