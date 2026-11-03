import { describe, expect, it } from 'vitest'
import { isDarkBitmap } from '../src/main/services/backdrop'

/** Builds a BGRA bitmap from a per-pixel colour function. */
function bitmap(
  width: number,
  height: number,
  pixel: (index: number) => [number, number, number, number]
): Buffer {
  const buffer = Buffer.alloc(width * height * 4)
  for (let index = 0; index < width * height; index += 1) {
    const [b, g, r, a] = pixel(index)
    const offset = index * 4
    buffer[offset] = b
    buffer[offset + 1] = g
    buffer[offset + 2] = r
    buffer[offset + 3] = a
  }
  return buffer
}

describe('isDarkBitmap', () => {
  it('treats a mostly black backdrop as dark', () => {
    expect(isDarkBitmap(bitmap(100, 100, () => [0, 0, 0, 255]))).toBe(true)
  })

  it('treats a mostly white backdrop as light', () => {
    expect(isDarkBitmap(bitmap(100, 100, () => [255, 255, 255, 255]))).toBe(false)
  })

  it('ignores the sparse text layer when measuring the backdrop', () => {
    // One in ten pixels is white text over a black window: the median stays dark.
    const buffer = bitmap(100, 100, (index) =>
      index % 10 === 0 ? [255, 255, 255, 255] : [0, 0, 0, 255]
    )
    expect(isDarkBitmap(buffer)).toBe(true)
  })

  it('falls back to light text for an empty bitmap', () => {
    expect(isDarkBitmap(Buffer.alloc(0))).toBe(true)
  })
})
