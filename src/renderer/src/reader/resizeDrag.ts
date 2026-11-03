export interface ResizePoint {
  x: number
  y: number
}

/**
 * True when a pointer move carries a screen position the drag has not
 * forwarded yet. Resizing a window can make it re-send moves at the same
 * point; forwarding those would make every resize schedule the next one and
 * lock the app up.
 */
export function isNewResizePoint(last: ResizePoint | null, next: ResizePoint): boolean {
  return last === null || last.x !== next.x || last.y !== next.y
}
