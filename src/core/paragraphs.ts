/** Split a chapter's stored text into trimmed, non-empty paragraphs. */
export function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}
