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

const MASK64 = (1n << 64n) - 1n

function hash64(token: string): bigint {
  let h = 0xcbf29ce484222325n
  for (const ch of token) {
    h ^= BigInt(ch.codePointAt(0)!)
    h = (h * 0x100000001b3n) & MASK64
  }
  return h
}

function shingles(text: string): string[] {
  const t = text.replace(/\s+/g, '')
  if (t.length <= 4) return t ? [t] : []
  const out: string[] = []
  const stride = Math.max(1, Math.floor(t.length / 20000))
  for (let i = 0; i + 4 <= t.length; i += stride) out.push(t.slice(i, i + 4))
  return out
}

export function simhash64(text: string): string {
  const tokens = shingles(stripZeroWidth(text))
  if (tokens.length === 0) return '0000000000000000'
  const v = new Array<number>(64).fill(0)
  for (const token of tokens) {
    const h = hash64(token)
    for (let i = 0; i < 64; i++) v[i] += (h >> BigInt(i)) & 1n ? 1 : -1
  }
  let out = 0n
  for (let i = 0; i < 64; i++) if (v[i] > 0) out |= 1n << BigInt(i)
  return out.toString(16).padStart(16, '0')
}

export function toBig(hex: string): bigint {
  return BigInt('0x' + hex)
}

export function hammingBig(a: bigint, b: bigint): number {
  let x = a ^ b
  let count = 0
  while (x > 0n) {
    count += Number(x & 1n)
    x >>= 1n
  }
  return count
}

export function hamming64(a: string, b: string): number {
  return hammingBig(toBig(a), toBig(b))
}

export function countCjkRatio(text: string): number {
  if (!text) return 0
  let cjk = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13 || c === 32) continue
    total++
    if (c >= 0x4e00 && c <= 0x9fff) cjk++
  }
  return total === 0 ? 0 : cjk / total
}
