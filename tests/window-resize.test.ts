import { describe, expect, it } from 'vitest'
import { resizeBounds, sameBounds } from '../src/main/services/windowResize'

const START = { x: 100, y: 100, width: 400, height: 300 }
const MIN = { width: 120, height: 80 }
const MAX = { width: 1920, height: 1080 }

describe('resizeBounds', () => {
  it('grows from the east and south edges', () => {
    expect(resizeBounds(START, 'e', 60, 0, MIN)).toEqual({
      x: 100,
      y: 100,
      width: 460,
      height: 300
    })
    expect(resizeBounds(START, 's', 0, 40, MIN)).toEqual({
      x: 100,
      y: 100,
      width: 400,
      height: 340
    })
  })

  it('keeps the opposite edge fixed when dragging west or north', () => {
    expect(resizeBounds(START, 'w', -50, 0, MIN)).toEqual({
      x: 50,
      y: 100,
      width: 450,
      height: 300
    })
    expect(resizeBounds(START, 'n', 0, -30, MIN)).toEqual({
      x: 100,
      y: 70,
      width: 400,
      height: 330
    })
  })

  it('resizes both axes for corner edges', () => {
    expect(resizeBounds(START, 'se', 30, 20, MIN)).toEqual({
      x: 100,
      y: 100,
      width: 430,
      height: 320
    })
    expect(resizeBounds(START, 'nw', -30, -20, MIN)).toEqual({
      x: 70,
      y: 80,
      width: 430,
      height: 320
    })
  })

  it('stops at the minimum size while keeping the opposite edge fixed', () => {
    expect(resizeBounds(START, 'w', 500, 0, MIN)).toEqual({
      x: 380,
      y: 100,
      width: 120,
      height: 300
    })
    expect(resizeBounds(START, 'n', 0, 500, MIN)).toEqual({
      x: 100,
      y: 320,
      width: 400,
      height: 80
    })
  })

  it('caps runaway growth at the virtual desktop size', () => {
    expect(resizeBounds(START, 'e', 5000, 0, MIN, MAX)).toEqual({
      x: 100,
      y: 100,
      width: 1920,
      height: 300
    })
    expect(resizeBounds(START, 'w', -5000, 0, MIN, MAX)).toEqual({
      x: -1420,
      y: 100,
      width: 1920,
      height: 300
    })
    expect(resizeBounds(START, 'n', 0, -5000, MIN, MAX)).toEqual({
      x: 100,
      y: -680,
      width: 400,
      height: 1080
    })
    expect(resizeBounds(START, 'se', 5000, 5000, MIN, MAX)).toEqual({
      x: 100,
      y: 100,
      width: 1920,
      height: 1080
    })
  })
})

describe('sameBounds', () => {
  it('recognises identical bounds so a repeated resize event is ignored', () => {
    const bounds = resizeBounds(START, 'e', 60, 0, MIN)
    expect(sameBounds(bounds, { ...bounds })).toBe(true)
    expect(sameBounds(bounds, { ...bounds, width: bounds.width + 1 })).toBe(false)
    expect(sameBounds(bounds, { ...bounds, x: bounds.x - 1 })).toBe(false)
  })
})
