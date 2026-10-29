import { describe, expect, it } from 'vitest'
import { countCjkRatio, hamming64, simhash64 } from '../src/core/text'

const base = '萧炎缓缓睁开双眼，体内的斗气如同火焰一般在经脉中奔涌，他知道，自己终于突破了斗者九星。'
const similar = '萧炎缓缓睁开双眼，体内的斗气像火焰一般在经脉中奔涌，他知道，自己终于突破了斗者九星。'
const different = '林动站在山巅，望着远处翻滚的云海，心中一片平静，手中长枪微微震颤。'

describe('simhash64', () => {
  it('returns a stable 16-char fingerprint', () => {
    expect(simhash64(base)).toMatch(/^[0-9a-f]{16}$/)
    expect(simhash64(base)).toBe(simhash64(base))
  })

  it('keeps similar text close and different text far apart', () => {
    const near = hamming64(simhash64(base), simhash64(similar))
    const far = hamming64(simhash64(base), simhash64(different))
    expect(near).toBeLessThanOrEqual(12)
    expect(far).toBeGreaterThan(12)
  })

  it('returns all zeros for empty text', () => {
    expect(simhash64('')).toBe('0000000000000000')
  })
})

describe('countCjkRatio', () => {
  it('counts Chinese characters as CJK', () => {
    expect(countCjkRatio('这是中文abc')).toBeCloseTo(4 / 7, 5)
  })

  it('returns 0 for empty text', () => {
    expect(countCjkRatio('')).toBe(0)
  })
})
