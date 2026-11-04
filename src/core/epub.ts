import { inflateRawSync } from 'node:zlib'

export interface EpubChapter {
  title: string
  paragraphs: string[]
}

export interface EpubCover {
  data: Buffer
  mime: string
}

export interface EpubBook {
  title: string
  author?: string
  chapters: EpubChapter[]
  cover?: EpubCover
  warnings: string[]
}

const MAX_ENTRY_BYTES = 64 * 1024 * 1024
const MAX_TOTAL_BYTES = 512 * 1024 * 1024

function normalizePath(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '')
}

function dirname(path: string): string {
  const index = path.lastIndexOf('/')
  return index < 0 ? '' : path.slice(0, index)
}

function resolvePath(baseDir: string, href: string): string {
  const clean = href.split('#')[0].split('?')[0]
  let decoded = clean
  try {
    decoded = decodeURIComponent(clean)
  } catch {
    // Keep the raw href when it is not valid percent-encoding.
  }
  const parts = (baseDir ? baseDir.split('/') : []).concat(decoded.split('/'))
  const stack: string[] = []
  for (const part of parts) {
    if (!part || part === '.') continue
    if (part === '..') {
      stack.pop()
      continue
    }
    stack.push(part)
  }
  return stack.join('/')
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  mdash: '—',
  ndash: '–',
  hellip: '…',
  ldquo: '“',
  rdquo: '”',
  lsquo: '‘',
  rsquo: '’',
  middot: '·',
  times: '×'
}

export function decodeEntities(input: string): string {
  return input.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code =
        entity[1] === 'x' || entity[1] === 'X'
          ? parseInt(entity.slice(2), 16)
          : parseInt(entity.slice(1), 10)
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match
      try {
        return String.fromCodePoint(code)
      } catch {
        return match
      }
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

function stripTags(input: string): string {
  return input.replace(/<[^>]*>/g, '')
}

function attr(tag: string, name: string): string | null {
  const pattern = new RegExp(`\\s${escapeRegExp(name)}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i')
  const match = pattern.exec(tag)
  if (!match) return null
  return decodeEntities(match[2] ?? match[3] ?? '')
}

interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

interface ZipArchive {
  entries: Map<string, ZipEntry>
  read(name: string): Buffer | null
  readText(name: string): string | null
}

function readZip(buffer: Buffer): ZipArchive {
  if (buffer.length < 22) throw new Error('不是有效的 EPUB 文件：压缩包为空或损坏')

  let end = -1
  const earliest = Math.max(0, buffer.length - 22 - 0xffff)
  for (let i = buffer.length - 22; i >= earliest; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i
      break
    }
  }
  if (end < 0) throw new Error('不是有效的 EPUB 文件：找不到压缩包目录')

  const count = buffer.readUInt16LE(end + 10)
  const directorySize = buffer.readUInt32LE(end + 12)
  let cursor = buffer.readUInt32LE(end + 16)
  if (count === 0xffff || directorySize === 0xffffffff) {
    throw new Error('暂不支持 ZIP64 格式的 EPUB')
  }
  if (cursor + directorySize > buffer.length) throw new Error('EPUB 压缩包目录已损坏')

  const entries = new Map<string, ZipEntry>()
  for (let i = 0; i < count; i++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error('EPUB 压缩包目录已损坏')
    }
    const method = buffer.readUInt16LE(cursor + 10)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const localOffset = buffer.readUInt32LE(cursor + 42)
    const name = normalizePath(buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8'))
    entries.set(name, { name, method, compressedSize, uncompressedSize, localOffset })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  let totalRead = 0
  const read = (name: string): Buffer | null => {
    const entry = entries.get(normalizePath(name))
    if (!entry) return null
    if (entry.uncompressedSize > MAX_ENTRY_BYTES) throw new Error('EPUB 内有文件过大，无法导入')
    const local = entry.localOffset
    if (local + 30 > buffer.length || buffer.readUInt32LE(local) !== 0x04034b50) {
      throw new Error('EPUB 压缩包内容已损坏')
    }
    const nameLength = buffer.readUInt16LE(local + 26)
    const extraLength = buffer.readUInt16LE(local + 28)
    const start = local + 30 + nameLength + extraLength
    const raw = buffer.subarray(start, start + entry.compressedSize)
    if (raw.length !== entry.compressedSize) throw new Error('EPUB 压缩包内容已损坏')
    let data: Buffer
    if (entry.method === 0) {
      data = Buffer.from(raw)
    } else if (entry.method === 8) {
      try {
        data = inflateRawSync(raw)
      } catch {
        throw new Error('EPUB 压缩包内容已损坏，无法解压')
      }
    } else {
      throw new Error('EPUB 使用了不支持的压缩方式')
    }
    totalRead += data.length
    if (totalRead > MAX_TOTAL_BYTES) throw new Error('EPUB 解压后体积过大，已停止导入')
    return data
  }

  return {
    entries,
    read,
    readText: (name) => {
      const data = read(name)
      if (!data) return null
      const text = data.toString('utf8')
      return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
    }
  }
}

interface ManifestItem {
  id: string
  href: string
  mediaType: string
  properties: string
}

interface PackageInfo {
  title: string
  author?: string
  coverId?: string
  manifest: ManifestItem[]
  spine: { idref: string; linear: boolean }[]
  spineToc?: string
}

function parsePackage(opf: string): PackageInfo {
  const titleMatch = /<dc:title\b[^>]*>([\s\S]*?)<\/dc:title>/i.exec(opf)
  const title = titleMatch ? decodeEntities(stripTags(titleMatch[1])).trim() : ''
  const creatorMatch = /<dc:creator\b[^>]*>([\s\S]*?)<\/dc:creator>/i.exec(opf)
  const author = creatorMatch ? decodeEntities(stripTags(creatorMatch[1])).trim() : ''

  let coverId: string | undefined
  for (const meta of opf.match(/<meta\b[^>]*>/gi) ?? []) {
    if ((attr(meta, 'name') ?? '').toLowerCase() === 'cover') {
      coverId = attr(meta, 'content') ?? undefined
    }
  }

  const manifest: ManifestItem[] = []
  for (const item of opf.match(/<item\b[^>]*>/gi) ?? []) {
    const id = attr(item, 'id')
    const href = attr(item, 'href')
    if (!id || !href) continue
    manifest.push({
      id,
      href,
      mediaType: (attr(item, 'media-type') ?? '').toLowerCase(),
      properties: attr(item, 'properties') ?? ''
    })
  }

  const spineMatch = /<spine\b([^>]*)>([\s\S]*?)<\/spine>/i.exec(opf)
  const spine: PackageInfo['spine'] = []
  if (spineMatch) {
    for (const itemref of spineMatch[2].match(/<itemref\b[^>]*>/gi) ?? []) {
      const idref = attr(itemref, 'idref')
      if (!idref) continue
      spine.push({ idref, linear: (attr(itemref, 'linear') ?? 'yes').toLowerCase() !== 'no' })
    }
  }

  return {
    title,
    ...(author ? { author } : {}),
    ...(coverId ? { coverId } : {}),
    manifest,
    spine,
    ...(spineMatch && attr(`<spine${spineMatch[1]}>`, 'toc')
      ? { spineToc: attr(`<spine${spineMatch[1]}>`, 'toc') ?? undefined }
      : {})
  }
}

function titleMapFromNcx(ncx: string, baseDir: string): Map<string, string> {
  const titles = new Map<string, string>()
  const pattern = /<navLabel\b[^>]*>([\s\S]*?)<\/navLabel>\s*<content\b([^>]*)>/gi
  let match: RegExpExecArray | null
  while ((match = pattern.exec(ncx)) !== null) {
    const src = attr(`<content${match[2]}>`, 'src')
    if (!src) continue
    const title = decodeEntities(stripTags(match[1])).replace(/\s+/g, ' ').trim()
    if (!title) continue
    const path = resolvePath(baseDir, src)
    if (!titles.has(path)) titles.set(path, title)
  }
  return titles
}

function titleMapFromNav(nav: string, baseDir: string): Map<string, string> {
  const titles = new Map<string, string>()
  let tocBody: string | null = null
  const navPattern = /<nav\b([^>]*)>([\s\S]*?)<\/nav>/gi
  let navMatch: RegExpExecArray | null
  while ((navMatch = navPattern.exec(nav)) !== null) {
    const type = attr(`<nav${navMatch[1]}>`, 'epub:type') ?? attr(`<nav${navMatch[1]}>`, 'type') ?? ''
    if (/\btoc\b/i.test(type)) {
      tocBody = navMatch[2]
      break
    }
  }
  if (!tocBody) {
    const firstNav = /<nav\b[^>]*>([\s\S]*?)<\/nav>/i.exec(nav)
    tocBody = firstNav?.[1] ?? nav
  }
  const linkPattern = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi
  let link: RegExpExecArray | null
  while ((link = linkPattern.exec(tocBody)) !== null) {
    const href = attr(`<a${link[1]}>`, 'href')
    if (!href) continue
    const title = decodeEntities(stripTags(link[2])).replace(/\s+/g, ' ').trim()
    if (!title) continue
    const path = resolvePath(baseDir, href)
    if (!titles.has(path)) titles.set(path, title)
  }
  return titles
}

export function htmlToParagraphs(html: string): { paragraphs: string[]; heading: string | null } {
  const headingMatch = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(html)
  const heading = headingMatch
    ? decodeEntities(stripTags(headingMatch[1])).replace(/\s+/g, ' ').trim() || null
    : null

  let text = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!DOCTYPE[^>]*>/gi, '')
    .replace(/<\?[\s\S]*?\?>/g, '')
    .replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi, '')
    .replace(/<(script|style|svg|math|rt|rp)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(
      /<\/?(?:p|div|h[1-6]|li|ul|ol|tr|td|th|table|blockquote|section|article|header|footer|figure|figcaption|pre|dt|dd|hr)\b[^>]*>/gi,
      '\n\n'
    )
    .replace(/<[^>]*>/g, '')

  text = decodeEntities(text).replace(/\u00a0/g, ' ')

  const paragraphs: string[] = []
  for (const line of text.split(/\r\n|\r|\n/)) {
    const cleaned = line.replace(/\s+/g, ' ').trim()
    if (cleaned) paragraphs.push(cleaned)
  }
  return { paragraphs, heading }
}

function sniffImageMime(data: Buffer, fallback: string): string {
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) return 'image/jpeg'
  if (data.length >= 8 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png'
  }
  if (data.length >= 6 && data.subarray(0, 4).toString('latin1') === 'GIF8') return 'image/gif'
  if (data.length >= 12 && data.subarray(0, 4).toString('latin1') === 'RIFF' && data.subarray(8, 12).toString('latin1') === 'WEBP') {
    return 'image/webp'
  }
  return fallback.startsWith('image/') ? fallback : 'image/jpeg'
}

function assertNotEncrypted(zip: ZipArchive): void {
  const encryption = zip.readText('META-INF/encryption.xml')
  if (!encryption) return
  const blocks = encryption.match(/<EncryptedData\b[\s\S]*?<\/EncryptedData>/gi) ?? []
  for (const block of blocks) {
    const uri = attr(block, 'URI') ?? attr(block, 'uri')
    if (!uri) continue
    const algorithm = attr(block, 'Algorithm') ?? ''
    const fontObfuscated =
      /obfuscation/i.test(algorithm) || /\.(ttf|otf|ttc|woff2?)(\?|#|$)/i.test(uri)
    if (!fontObfuscated) {
      throw new Error('这本书带有版权保护（DRM），暂不支持导入')
    }
  }
}

export function isEpubFile(fileName: string): boolean {
  return /\.epub$/i.test(fileName)
}

export function parseEpub(contents: Buffer, fileName: string): EpubBook {
  const zip = readZip(contents)
  assertNotEncrypted(zip)

  const container = zip.readText('META-INF/container.xml')
  if (!container) throw new Error('不是有效的 EPUB：缺少 container.xml')
  const rootfileMatch = /<rootfile\b[^>]*>/i.exec(container)
  const opfPath = rootfileMatch ? attr(rootfileMatch[0], 'full-path') : null
  if (!opfPath) throw new Error('不是有效的 EPUB：缺少书籍描述文件')

  const opf = zip.readText(opfPath)
  if (!opf) throw new Error('EPUB 书籍描述文件缺失，无法导入')
  const opfDir = dirname(normalizePath(opfPath))
  const pkg = parsePackage(opf)

  const warnings: string[] = []
  const tocItemId = pkg.spineToc
  const ncxItem =
    pkg.manifest.find((item) => tocItemId && item.id === tocItemId) ??
    pkg.manifest.find((item) => item.mediaType === 'application/x-dtbncx+xml')
  const navItem = pkg.manifest.find((item) => item.properties.split(/\s+/).includes('nav'))

  let titles = new Map<string, string>()
  if (ncxItem) {
    const ncx = zip.readText(resolvePath(opfDir, ncxItem.href))
    if (ncx) titles = titleMapFromNcx(ncx, dirname(resolvePath(opfDir, ncxItem.href)))
  }
  if (titles.size === 0 && navItem) {
    const nav = zip.readText(resolvePath(opfDir, navItem.href))
    if (nav) titles = titleMapFromNav(nav, dirname(resolvePath(opfDir, navItem.href)))
  }
  if (titles.size === 0) warnings.push('未找到目录，已按正文标题分章')

  const manifestById = new Map(pkg.manifest.map((item) => [item.id, item]))
  const chapters: EpubChapter[] = []
  let missing = 0
  for (const ref of pkg.spine) {
    if (!ref.linear) continue
    const item = manifestById.get(ref.idref)
    if (!item) {
      missing += 1
      continue
    }
    const path = resolvePath(opfDir, item.href)
    const html = zip.readText(path)
    if (html === null) {
      missing += 1
      continue
    }
    const { paragraphs, heading } = htmlToParagraphs(html)
    if (paragraphs.length === 0) continue
    const title = titles.get(path) ?? heading ?? `第 ${chapters.length + 1} 章`
    if (paragraphs[0] === title) paragraphs.shift()
    if (paragraphs.length === 0) continue
    chapters.push({ title, paragraphs })
  }
  if (missing > 0) warnings.push(`有 ${missing} 个章节文件缺失，已跳过`)
  if (chapters.length === 0) throw new Error('这本书没有可阅读的正文')

  let cover: EpubCover | undefined
  const coverItem =
    pkg.manifest.find((item) => pkg.coverId && item.id === pkg.coverId) ??
    pkg.manifest.find((item) => item.properties.split(/\s+/).includes('cover-image'))
  if (coverItem) {
    const data = zip.read(resolvePath(opfDir, coverItem.href))
    if (data && data.length > 0) {
      cover = { data, mime: sniffImageMime(data, coverItem.mediaType) }
    }
  }

  const fallbackTitle = fileName.replace(/\.epub$/i, '').trim() || '未命名'
  const title = pkg.title.trim() || fallbackTitle

  return {
    title,
    ...(pkg.author ? { author: pkg.author } : {}),
    chapters,
    ...(cover ? { cover } : {}),
    warnings
  }
}
