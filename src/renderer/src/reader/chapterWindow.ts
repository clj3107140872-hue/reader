/**
 * Chapters kept in the DOM around the reading position: the previous, the
 * current and the next one. Rendering the whole book makes every global
 * reflow (window resize, font change) touch every paragraph, which freezes
 * the app on long books. A window that slides by one chapter keeps the work
 * constant.
 */
export function chapterWindow(
  chapterCount: number,
  currentIndex: number
): { start: number; end: number } {
  if (chapterCount <= 0) return { start: 0, end: 0 }
  const anchor = Math.min(Math.max(currentIndex, 0), chapterCount - 1)
  const start = Math.max(0, Math.min(anchor - 1, chapterCount - 3))
  return { start, end: Math.min(chapterCount, start + 3) }
}
