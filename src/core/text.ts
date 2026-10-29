const ZERO_WIDTH = /[\u200B-\u200D\uFEFF]/g

export function stripZeroWidth(s: string): string {
  return s.replace(ZERO_WIDTH, '')
}

export function toHalfWidth(s: string): string {
  return s.replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
}

export function normalizeForHash(s: string): string {
  return toHalfWidth(stripZeroWidth(s)).replace(/[\s\p{P}]/gu, '').toLowerCase()
}

export function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}
