/**
 * Estimates how tall a chapter will be once the browser lays it out.
 *
 * The reader keeps `content-visibility: auto` on every chapter so opening a
 * long book stays fast. Chapters above the viewport are still measured with
 * `contain-intrinsic-size`, and the scroller clamps `scrollTop` against that
 * estimate. A flat estimate makes a jump to a late chapter impossible without
 * laying out the whole book first, so each chapter gets one derived from its
 * own text instead.
 */

export interface ChapterSizeMetrics {
  /** How many ems of body text fit on one line. */
  lineEm: number
  /** Resolved line height of body text, in px. */
  lineHeightPx: number
  /** Body font size, in px. */
  fontSizePx: number
  /** Space below each paragraph, in px. */
  paragraphGapPx: number
}

function isWide(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals, punctuation, kana, Han
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility punctuation
    (code >= 0xff00 && code <= 0xff60) || // full-width forms
    (code >= 0xffe0 && code <= 0xffe6)
  )
}

/**
 * Width of a paragraph in ems at the body font size. Chinese text is one em
 * per character; Latin letters and digits are narrower in the UI font.
 */
export function estimateTextEm(text: string): number {
  let em = 0
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i)
    if (isWide(code)) em += 1
    else if (code === 0x20) em += 0.3
    else if (code >= 0x41 && code <= 0x5a) em += 0.65 // A-Z
    else if (
      (code >= 0x61 && code <= 0x7a) || // a-z
      (code >= 0x30 && code <= 0x39) // 0-9
    ) {
      em += 0.55
    } else em += 0.5
  }
  return em
}

/** Lines a paragraph occupies, including the 2em first-line indent. */
export function countChapterLines(textEm: number, lineEm: number): number {
  if (textEm <= 0) return 0
  const width = Math.max(1, lineEm)
  const firstLine = Math.max(1, width - 2)
  if (textEm <= firstLine) return 1
  return 1 + Math.ceil((textEm - firstLine) / width)
}

/**
 * Estimated outer height of one chapter section, in px. Chapter titles render
 * at 1.25em with 1.6em/0.8em margins; volumes add extra space above.
 */
export function estimateChapterHeight(
  titleEm: number,
  paragraphEms: readonly number[],
  metrics: ChapterSizeMetrics,
  volume: boolean
): number {
  const titleFontPx = metrics.fontSizePx * 1.25
  const titleLines = Math.max(1, countChapterLines(titleEm, metrics.lineEm / 1.25))
  let height = titleLines * metrics.lineHeightPx * 1.25 + titleFontPx * 2.4
  if (volume) height += titleFontPx * 1.1 + 1
  for (const paragraphEm of paragraphEms) {
    height += countChapterLines(paragraphEm, metrics.lineEm) * metrics.lineHeightPx
    height += metrics.paragraphGapPx
  }
  return height
}
