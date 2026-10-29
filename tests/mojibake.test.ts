import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { repairMojibake } from '../src/core/mojibake'

const original = '这是一本测试小说，第一章开始。'

describe('repairMojibake', () => {
  it('repairs UTF-8 bytes that were read as Latin-1', () => {
    const broken = iconv.decode(iconv.encode(original, 'utf8'), 'latin1')
    const result = repairMojibake(broken, 'utf8')
    expect(result.repaired).toBe(true)
    expect(result.text).toBe(original)
  })

  it('repairs GBK bytes that were read as Latin-1', () => {
    const broken = iconv.decode(iconv.encode(original, 'gbk'), 'latin1')
    const result = repairMojibake(broken, 'gb18030')
    expect(result.repaired).toBe(true)
    expect(result.text).toBe(original)
  })

  it('strips burned replacement sequences and warns', () => {
    const result = repairMojibake('正文开始锟斤拷锟斤拷正文继续', 'gb18030')
    expect(result.text.includes('锟')).toBe(false)
    expect(result.warnings.length).toBeGreaterThan(0)
  })

  it('leaves clean text untouched', () => {
    const result = repairMojibake(original, 'utf8')
    expect(result.repaired).toBe(false)
    expect(result.text).toBe(original)
    expect(result.warnings).toEqual([])
  })
})
