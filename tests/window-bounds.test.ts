import { describe, expect, it } from 'vitest'
import { clampWindowState } from '../src/main/windowBounds'

const primary = { x: 0, y: 0, width: 1920, height: 1080 }

describe('clampWindowState', () => {
  it('centers a window saved on a monitor that is no longer connected', () => {
    const state = { width: 1000, height: 700, x: -20000, y: -20000, maximized: false }
    expect(clampWindowState(state, [primary])).toMatchObject({ x: 460, y: 190 })
  })

  it('keeps a window that still overlaps a display', () => {
    const state = { width: 1000, height: 700, x: 100, y: 80, maximized: false }
    expect(clampWindowState(state, [primary])).toBe(state)
  })

  it('leaves a never-positioned window alone', () => {
    const state = { width: 1000, height: 700, maximized: true }
    expect(clampWindowState(state, [primary])).toBe(state)
  })
})
