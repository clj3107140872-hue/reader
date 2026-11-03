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

/**
 * Applies a pointer drag to a window's bounds. Edges named "w"/"n" move the
 * window origin so the opposite edge stays put, and the minimum size clamps
 * there too.
 */
export function resizeBounds(
  start: WindowBounds,
  edge: WindowResizeEdge,
  dx: number,
  dy: number,
  min: SizeLimit
): WindowBounds {
  let { x, y, width, height } = start

  if (edge.includes('e')) width = Math.max(min.width, start.width + dx)
  if (edge.includes('s')) height = Math.max(min.height, start.height + dy)
  if (edge.includes('w')) {
    width = Math.max(min.width, start.width - dx)
    x = start.x + start.width - width
  }
  if (edge.includes('n')) {
    height = Math.max(min.height, start.height - dy)
    y = start.y + start.height - height
  }

  return { x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) }
}
