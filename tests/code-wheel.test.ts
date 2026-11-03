import { describe, expect, it } from 'vitest'
import { wheelLineStep } from '../src/renderer/src/reader/codeWheel'

// DOM_DELTA_PIXEL = 0, DOM_DELTA_LINE = 1, DOM_DELTA_PAGE = 2
const PIXEL = 0
const LINE = 1
const PAGE = 2

describe('wheelLineStep', () => {
  it('advances exactly one line for a full mouse notch', () => {
    expect(wheelLineStep(100, PIXEL, 0)).toEqual({ lines: 1, travel: 0 })
    expect(wheelLineStep(120, PIXEL, 0)).toEqual({ lines: 1, travel: 20 })
    expect(wheelLineStep(150, PIXEL, 0)).toEqual({ lines: 1, travel: 50 })
    expect(wheelLineStep(-120, PIXEL, 0)).toEqual({ lines: -1, travel: -20 })
  })

  it('accumulates small trackpad deltas instead of jumping', () => {
    expect(wheelLineStep(40, PIXEL, 0)).toEqual({ lines: 0, travel: 40 })
    expect(wheelLineStep(40, PIXEL, 40)).toEqual({ lines: 0, travel: 80 })
    expect(wheelLineStep(40, PIXEL, 80)).toEqual({ lines: 1, travel: 20 })
  })

  it('treats line and page deltas as one line per event', () => {
    expect(wheelLineStep(3, LINE, 0)).toEqual({ lines: 1, travel: 0 })
    expect(wheelLineStep(-1, PAGE, 0)).toEqual({ lines: -1, travel: 0 })
  })

  it('drops the leftover travel when the wheel reverses', () => {
    expect(wheelLineStep(-100, PIXEL, 20)).toEqual({ lines: -1, travel: 0 })
  })
})
