import { describe, expect, it } from 'vitest'
import { codeLayout } from '../src/renderer/src/reader/codeLayout'

describe('codeLayout', () => {
  it('keeps the requested comment lines when the window has room', () => {
    const layout = codeLayout(800, 4)
    expect(layout.lines).toBe(4)
    expect(layout.topRows).toBe(19)
    expect(layout.bottomRows).toBe(19)
  })

  it('reserves one code line above and below when the window is too short', () => {
    const layout = codeLayout(200, 12)
    expect(layout.lines).toBe(8)
    expect(layout.topRows).toBe(1)
    expect(layout.bottomRows).toBe(1)
  })

  it('caps the comment band at 12 lines', () => {
    const layout = codeLayout(1600, 20)
    expect(layout.lines).toBe(12)
  })
})
