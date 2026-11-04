/**
 * Geometry for the paged reading mode. A chapter is laid out as fixed-width
 * columns; every column is one page, and the next page starts one column plus
 * the gap to the right.
 */

/** Number of page columns that carry content. */
export function pageCountFor(scrollWidth: number, pageWidth: number, gap: number): number {
  if (!(pageWidth > 0) || !(scrollWidth > 0)) return 1
  const step = pageWidth + gap
  if (!(step > 0)) return 1
  // Column boxes add up to count * width + (count - 1) * gap; the rounding
  // absorbs subpixel scroll widths reported by the browser.
  return Math.max(1, Math.round((scrollWidth + gap) / step))
}

/**
 * Page that contains a pixel offset from the start of the paginated flow.
 * A column start can measure a fraction left of its exact boundary, so one
 * pixel of slack keeps it on the page it belongs to.
 */
export function pageIndexForOffset(offset: number, pageWidth: number, gap: number): number {
  const step = pageWidth + gap
  if (!(step > 0)) return 0
  return Math.max(0, Math.floor((Math.max(0, offset) + 1) / step))
}

/** Horizontal scroll offset that shows a page. */
export function scrollLeftForPage(page: number, pageWidth: number, gap: number): number {
  return Math.max(0, page) * (pageWidth + gap)
}

export interface WheelPageStep {
  /** -1 previous page, 0 nothing yet, 1 next page. */
  turn: -1 | 0 | 1
  /** Pixels carried toward the next page turn. */
  travel: number
}

const WHEEL_PAGE_THRESHOLD = 100
const LINE_HEIGHT_PX = 20
const PAGE_HEIGHT_PX = 400

/**
 * Accumulates wheel deltas into whole-page turns. A reversal drops the old
 * travel so an overshoot does not immediately flick the other way.
 */
export function wheelPageStep(deltaY: number, deltaMode: number, travel: number): WheelPageStep {
  const delta =
    deltaMode === 1 ? deltaY * LINE_HEIGHT_PX : deltaMode === 2 ? deltaY * PAGE_HEIGHT_PX : deltaY
  const next = travel !== 0 && Math.sign(delta) !== Math.sign(travel) ? delta : travel + delta
  if (Math.abs(next) < WHEEL_PAGE_THRESHOLD) return { turn: 0, travel: next }
  return { turn: next > 0 ? 1 : -1, travel: 0 }
}
