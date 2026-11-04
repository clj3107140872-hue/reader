import { describe, expect, it } from 'vitest'
import { parseEpub } from '../src/core/epub'
import {
  BASIC_OPF,
  basicFiles,
  makeEpub,
  makeZip,
  opf,
  sampleEpub
} from './helpers/epub'

describe('parseEpub', () => {
  it('reads title, author, spine order and NCX titles', () => {
    const book = parseEpub(sampleEpub(), '测试.epub')
    expect(book.title).toBe('测试之书')
    expect(book.author).toBe('某作者')
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(['第一章 起点', '第二章 终点'])
  })

  it('turns XHTML into paragraphs and drops head, script and the duplicate heading', () => {
    const book = parseEpub(sampleEpub(), '测试.epub')
    expect(book.chapters[0].paragraphs).toEqual(['你好&世界。', '第一行', '第二行'])
    expect(book.chapters[1].paragraphs).toEqual(['第二段中文 空格'])
  })

  it('extracts the cover image and its mime type', () => {
    const book = parseEpub(sampleEpub(), '测试.epub')
    expect(book.cover).toBeDefined()
    expect(book.cover?.mime).toBe('image/jpeg')
    expect(book.cover?.data[0]).toBe(0xff)
  })

  it('falls back to a heading and warns when the book has no TOC', () => {
    const text = '<html><body><h2>自定标题</h2><p>正文一</p></body></html>'
    const book = parseEpub(
      makeEpub({
        opf: opf({
          title: '',
          manifest: '<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>',
          spine: '<itemref idref="c1"/>'
        }),
        files: [{ name: 'OEBPS/ch1.xhtml', text }]
      }),
      '无目录.epub'
    )
    expect(book.title).toBe('无目录')
    expect(book.chapters[0].title).toBe('自定标题')
    expect(book.chapters[0].paragraphs).toEqual(['正文一'])
    expect(book.warnings.join('')).toContain('目录')
  })

  it('reads an EPUB 3 navigation document', () => {
    const nav = `<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<body><nav epub:type="toc"><ol>
<li><a href="ch1.xhtml">导航一</a></li><li><a href="ch2.xhtml">导航二</a></li>
</ol></nav></body></html>`
    const book = parseEpub(
      makeEpub({
        opf: opf({
          version: '3.0',
          title: '第三版',
          manifest: `<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>`,
          spine: '<itemref idref="c1"/><itemref idref="c2"/>'
        }),
        files: [
          { name: 'OEBPS/nav.xhtml', text: nav },
          { name: 'OEBPS/ch1.xhtml', text: '<html><body><p>甲</p></body></html>' },
          { name: 'OEBPS/ch2.xhtml', text: '<html><body><p>乙</p></body></html>' }
        ]
      }),
      'nav.epub'
    )
    expect(book.chapters.map((chapter) => chapter.title)).toEqual(['导航一', '导航二'])
  })

  it('skips non-linear and empty spine documents', () => {
    const book = parseEpub(
      makeEpub({
        opf: opf({
          manifest: `<item id="c1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="cover" href="cover.xhtml" media-type="application/xhtml+xml"/>`,
          spine: `<itemref idref="c1"/><itemref idref="c2" linear="no"/><itemref idref="cover"/>`
        }),
        files: [
          { name: 'OEBPS/ch1.xhtml', text: '<html><body><p>唯一正文</p></body></html>' },
          { name: 'OEBPS/ch2.xhtml', text: '<html><body><p>不该出现</p></body></html>' },
          { name: 'OEBPS/cover.xhtml', text: '<html><body><img src="cover.jpg"/></body></html>' }
        ]
      }),
      'skip.epub'
    )
    expect(book.chapters).toHaveLength(1)
    expect(book.chapters[0].paragraphs).toEqual(['唯一正文'])
  })

  it('allows font obfuscation but rejects encrypted content', () => {
    const fontsOnly = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
<EncryptionMethod Algorithm="http://www.idpf.org/2008/embedding"/>
<CipherData><CipherReference URI="OEBPS/fonts/a.ttf"/></CipherData>
</EncryptedData></encryption>`
    expect(() =>
      parseEpub(makeEpub({ opf: BASIC_OPF, files: basicFiles(), encryption: fontsOnly }), '字体.epub')
    ).not.toThrow()

    const drm = `<encryption xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
<EncryptedData xmlns="http://www.w3.org/2001/04/xmlenc#">
<EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes128-cbc"/>
<CipherData><CipherReference URI="OEBPS/text/ch1.xhtml"/></CipherData>
</EncryptedData></encryption>`
    expect(() =>
      parseEpub(makeEpub({ opf: BASIC_OPF, files: basicFiles(), encryption: drm }), '加密.epub')
    ).toThrow(/版权保护|DRM|加密/)
  })

  it('rejects files that are not a readable EPUB', () => {
    expect(() => parseEpub(Buffer.from('not a zip'), '假.epub')).toThrow(/EPUB|压缩包/)
    expect(() =>
      parseEpub(makeZip([{ name: 'mimetype', text: 'application/epub+zip' }]), '缺包.epub')
    ).toThrow(/EPUB|目录|container/)
  })
})
