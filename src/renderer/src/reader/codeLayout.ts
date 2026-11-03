/** Matches the code font's fixed line box in the code disguise. */
export const CODE_ROW_HEIGHT = 20
export const CODE_COMMENT_MIN = 2
export const CODE_COMMENT_MAX = 12
export const CODE_COMMENT_DEFAULT = 4

export interface CodeLayout {
  /** Comment lines actually shown; drops below the request only if the window cannot fit it. */
  lines: number
  /** Fixed code lines above the comment band. */
  topRows: number
  /** Fixed code lines below the comment band. */
  bottomRows: number
  /** Highest line count the current window can show while keeping one code line each side. */
  maxLines: number
}

/**
 * Splits the editor into fixed code rows and a comment band measured in whole
 * lines. A window too short for the requested band shrinks the band instead of
 * covering the code, so the disguise always keeps at least one code line above
 * and below.
 */
export function codeLayout(editorHeight: number, requestedLines: number): CodeLayout {
  const totalRows = Math.max(4, Math.floor(editorHeight / CODE_ROW_HEIGHT))
  const maxLines = Math.min(CODE_COMMENT_MAX, totalRows - 2)
  const wanted = Number.isFinite(requestedLines)
    ? Math.round(requestedLines)
    : CODE_COMMENT_DEFAULT
  const lines = Math.min(Math.max(CODE_COMMENT_MIN, wanted), maxLines)
  const codeRows = totalRows - lines
  const topRows = Math.floor(codeRows / 2)
  const bottomRows = codeRows - topRows
  return { lines, topRows, bottomRows, maxLines }
}
