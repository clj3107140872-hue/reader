/** Pixel travel that counts as one mouse-wheel notch. */
export const WHEEL_NOTCH_PX = 100

export interface WheelStep {
  /** Whole lines to move: -1, 0 or 1. */
  lines: number
  /** Unused travel carried into the next event. */
  travel: number
}

/**
 * Turns a wheel event into whole-line movement. A full notch (or a line/page
 * mode event) moves exactly one line; smaller trackpad deltas accumulate
 * instead of sliding part of a line into view.
 */
export function wheelLineStep(deltaY: number, deltaMode: number, travel: number): WheelStep {
  if (deltaY === 0) return { lines: 0, travel }
  // Chrome normally reports pixels; line/page deltas already mean whole rows.
  if (deltaMode !== 0) return { lines: deltaY > 0 ? 1 : -1, travel: 0 }
  // Turning the wheel around should not spend the old direction's leftover.
  const base = Math.sign(travel) === Math.sign(deltaY) ? travel : 0
  const total = base + deltaY
  if (Math.abs(total) < WHEEL_NOTCH_PX) return { lines: 0, travel: total }
  const lines = total > 0 ? 1 : -1
  return { lines, travel: total - lines * WHEEL_NOTCH_PX }
}
