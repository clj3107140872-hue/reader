import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { decodeBook, decodeWithEncoding } from '../src/core/encoding'

describe('decodeWithEncoding', () => {
  it('decodes with the chosen encoding and strips a matching BOM', () => {
    const text = '第一章 风起\n正文。'
    expect(decodeWithEncoding(iconv.encode(text, 'gb18030'), 'gb18030')).toEqual({
      encoding: 'gb18030',
      text
    })
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')])
    expect(decodeWithEncoding(withBom, 'utf8')).toEqual({ encoding: 'utf8', text })
  })
})

describe('decodeBook', () => {
  const simplified = '这是一本测试小说，第一章开始。'
  const traditional = '這是一本測試小說，第一章開始。'

  it.each([
    ['utf8', simplified],
    ['gbk', simplified],
    ['gb18030', simplified],
    ['big5', traditional],
    ['utf16le', simplified]
  ] as const)('detects %s input', (encoding, text) => {
    const buf = iconv.encode(text, encoding)
    const result = decodeBook(buf)
    expect(result.encoding).toBe(encoding === 'gbk' ? 'gb18030' : encoding)
    expect(result.text).toBe(text)
  })

  it('honors UTF-8 and UTF-16 BOMs', () => {
    const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(simplified, 'utf8')])
    expect(decodeBook(utf8)).toEqual({ encoding: 'utf8', text: simplified })

    const utf16 = Buffer.concat([Buffer.from([0xff, 0xfe]), iconv.encode(simplified, 'utf16le')])
    expect(decodeBook(utf16)).toEqual({ encoding: 'utf16le', text: simplified })
  })

  it('rejects an empty file', () => {
    expect(() => decodeBook(Buffer.alloc(0))).toThrow('空文件')
  })

  it('rejects a binary file renamed to .txt', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52])
    expect(() => decodeBook(png)).toThrow('不是文本文件')
  })
})
