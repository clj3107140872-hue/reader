const LUMINANCE_CUTOFF = 128
const MAX_SAMPLES = 4000

/**
 * Decides whether a backdrop is dark by taking the median perceived luminance
 * of a BGRA bitmap (Electron's `NativeImage#toBitmap` layout). The median
 * ignores the reader's own text, which only covers a small slice of the
 * window, so a black desktop with white text still counts as dark.
 */
export function isDarkBitmap(bitmap: Buffer): boolean {
  const pixels = Math.floor(bitmap.length / 4)
  if (pixels === 0) return true
  const step = Math.max(1, Math.floor(pixels / MAX_SAMPLES))
  const values: number[] = []
  for (let index = 0; index < pixels; index += step) {
    const offset = index * 4
    const b = bitmap[offset] ?? 0
    const g = bitmap[offset + 1] ?? 0
    const r = bitmap[offset + 2] ?? 0
    values.push(0.2126 * r + 0.7152 * g + 0.0722 * b)
  }
  values.sort((left, right) => left - right)
  const median = values[Math.floor(values.length / 2)] ?? 255
  return median < LUMINANCE_CUTOFF
}
