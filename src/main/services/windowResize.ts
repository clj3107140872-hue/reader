export type WindowResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export interface WindowBounds {
  x: number
  y: number
  width: number
  height: number
}

export interface SizeLimit {
  width: number
  height: number
}

const UNBOUNDED: SizeLimit = { width: Number.POSITIVE_INFINITY, height: Number.POSITIVE_INFINITY }

/**
 * Applies a pointer drag to a window's bounds. Edges named "w"/"n" move the
 * window origin so the opposite edge stays put, and the minimum size clamps
 * there too. The maximum keeps a stuck drag from growing the window beyond
 * the desktop, which can stall the compositor.
 */
export function resizeBounds(
  start: WindowBounds,
  edge: WindowResizeEdge,
  dx: number,
  dy: number,
  min: SizeLimit,
  max: SizeLimit = UNBOUNDED
): WindowBounds {
  let { x, y, width, height } = start
  const clampWidth = (value: number): number => Math.min(max.width, Math.max(min.width, value))
  const clampHeight = (value: number): number => Math.min(max.height, Math.max(min.height, value))

  if (edge.includes('e')) width = clampWidth(start.width + dx)
  if (edge.includes('s')) height = clampHeight(start.height + dy)
  if (edge.includes('w')) {
    width = clampWidth(start.width - dx)
    x = start.x + start.width - width
  }
  if (edge.includes('n')) {
    height = clampHeight(start.height - dy)
    y = start.y + start.height - height
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}

/** True when two bounds describe the same rectangle. */
export function sameBounds(a: WindowBounds, b: WindowBounds): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height
}
