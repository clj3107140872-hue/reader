import { describe, expect, it } from 'vitest'
import { isNewResizePoint } from '../src/renderer/src/reader/resizeDrag'

describe('isNewResizePoint', () => {
  it('drops a repeated screen position so a resize cannot feed itself', () => {
    expect(isNewResizePoint(null, { x: 10, y: 20 })).toBe(true)
    expect(isNewResizePoint({ x: 10, y: 20 }, { x: 10, y: 20 })).toBe(false)
    expect(isNewResizePoint({ x: 10, y: 20 }, { x: 11, y: 20 })).toBe(true)
    expect(isNewResizePoint({ x: 10, y: 20 }, { x: 10, y: 21 })).toBe(true)
  })
})
