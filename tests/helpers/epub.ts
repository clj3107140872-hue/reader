import { deflateRawSync } from 'node:zlib'

export interface ZipFile {
  name: string
  text?: string
  data?: Buffer
  deflate?: boolean
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Minimal store/deflate ZIP writer so fixtures need no dependency. */
export function makeZip(files: ZipFile[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const file of files) {
    const data = file.data ?? Buffer.from(file.text ?? '', 'utf8')
    const compressed = file.deflate ? deflateRawSync(data) : data
    const method = file.deflate ? 8 : 0
    const name = Buffer.from(file.name, 'utf8')
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(compressed.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, compressed)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(compressed.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)

    offset += local.length + name.length + compressed.length
  }

  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(files.length, 8)
  end.writeUInt16LE(files.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}

const CONTAINER = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`

export interface FixtureOptions {
  opf: string
  files?: ZipFile[]
  encryption?: string
  omitMimetype?: boolean
}

export function makeEpub(options: FixtureOptions): Buffer {
  const files: ZipFile[] = []
  if (!options.omitMimetype) files.push({ name: 'mimetype', text: 'application/epub+zip' })
  files.push({ name: 'META-INF/container.xml', text: CONTAINER })
  if (options.encryption) {
    files.push({ name: 'META-INF/encryption.xml', text: options.encryption })
  }
  files.push({ name: 'OEBPS/content.opf', text: options.opf })
  files.push(...(options.files ?? []))
  return makeZip(files)
}

export function opf(options: {
  title?: string
  author?: string
  manifest: string
  spine: string
  spineAttrs?: string
  metadataExtra?: string
  version?: string
}): string {
  return `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="${options.version ?? '2.0'}" unique-identifier="id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>${options.title ?? '测试之书'}</dc:title>
    ${options.author ? `<dc:creator>${options.author}</dc:creator>` : ''}
    ${options.metadataExtra ?? ''}
  </metadata>
  <manifest>${options.manifest}</manifest>
  <spine${options.spineAttrs ?? ''}>${options.spine}</spine>
</package>`
}

export const NCX = `<?xml version="1.0"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="n1"><navLabel><text>第一章 起点</text></navLabel><content src="text/ch1.xhtml"/></navPoint>
    <navPoint id="n2"><navLabel><text>第二章 终点</text></navLabel><content src="text/ch2.xhtml"/></navPoint>
  </navMap>
</ncx>`

export const CH1 = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
<head><title>ignored</title><style>p { color: red }</style></head>
<body>
  <h1>第一章 起点</h1>
  <p>你好&amp;世界。</p>
  <p>第一行<br/>第二行</p>
  <script>evil()</script>
</body>
</html>`

export const CH2 = `<html><body>
  <div class="x"><p>第二段&#x4E2D;文&nbsp;空格</p></div>
</body></html>`

export const BASIC_OPF = opf({
  author: '某作者',
  manifest: `<item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
<item id="c1" href="text/ch1.xhtml" media-type="application/xhtml+xml"/>
<item id="c2" href="text/ch2.xhtml" media-type="application/xhtml+xml"/>
<item id="cover" href="images/cover.jpg" media-type="image/jpeg"/>`,
  spine: `<itemref idref="c1"/><itemref idref="c2"/>`,
  spineAttrs: ' toc="ncx"',
  metadataExtra: '<meta name="cover" content="cover"/>'
})

export function basicFiles(): ZipFile[] {
  return [
    { name: 'OEBPS/toc.ncx', text: NCX },
    { name: 'OEBPS/text/ch1.xhtml', text: CH1, deflate: true },
    { name: 'OEBPS/text/ch2.xhtml', text: CH2 },
    {
      name: 'OEBPS/images/cover.jpg',
      data: Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46])
    }
  ]
}

export function sampleEpub(): Buffer {
  return makeEpub({ opf: BASIC_OPF, files: basicFiles() })
}
