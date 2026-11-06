import { promises as dns } from 'node:dns'
import { isIP, type LookupFunction } from 'node:net'
import iconv from 'iconv-lite'
import { Agent, fetch } from 'undici'

export class NetworkError extends Error {
  constructor(
    message: string,
    readonly kind: 'timeout' | 'http' | 'network' | 'blocked' | 'too-large',
    readonly status?: number
  ) {
    super(message)
    this.name = 'NetworkError'
  }
}

export interface HttpRequest {
  url: string
  method?: 'GET' | 'POST'
  headers?: Record<string, string>
  body?: string
  charset?: string
  sourceId?: string
  signal?: AbortSignal
  timeoutMs?: number
  retry?: number
  /** Per-request response cap; defaults to the client-wide cap. */
  maxBytes?: number
}

export interface HttpResponse {
  url: string
  status: number
  text: string
  contentType: string
  warnings: string[]
}

const DEFAULT_TIMEOUT = 10_000
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024
const MAX_REDIRECTS = 5

function isBlockedIPv4(a: number, b: number): boolean {
  return (
    a === 0 || a === 127 || a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  )
}

/** Expands an IPv6 address (including `::` and embedded IPv4) to 8 hextets. */
function expandIPv6(address: string): number[] | null {
  const toHextets = (part: string): number[] | null => {
    const groups = part === '' ? [] : part.split(':')
    const numbers: number[] = []
    for (let index = 0; index < groups.length; index++) {
      const group = groups[index]
      const dotted = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(group)
      if (dotted) {
        if (index !== groups.length - 1) return null
        const octets = [Number(dotted[1]), Number(dotted[2]), Number(dotted[3]), Number(dotted[4])]
        if (octets.some((octet) => octet > 255)) return null
        numbers.push((octets[0] << 8) | octets[1], (octets[2] << 8) | octets[3])
        continue
      }
      if (!/^[0-9a-f]{1,4}$/.test(group)) return null
      numbers.push(parseInt(group, 16))
    }
    return numbers
  }
  const marker = address.indexOf('::')
  if (marker >= 0) {
    if (address.indexOf('::', marker + 1) >= 0) return null
    const head = toHextets(address.slice(0, marker))
    const tail = toHextets(address.slice(marker + 2))
    if (!head || !tail) return null
    const missing = 8 - head.length - tail.length
    if (missing < 1) return null
    return [...head, ...new Array<number>(missing).fill(0), ...tail]
  }
  const numbers = toHextets(address)
  return numbers && numbers.length === 8 ? numbers : null
}

export function isBlockedAddress(address: string): boolean {
  const ip = address.trim().toLowerCase().replace(/%.*$/, '')
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    return isBlockedIPv4(Number(v4[1]), Number(v4[2]))
  }
  if (isIP(ip) !== 6) return false
  const hextets = expandIPv6(ip)
  if (!hextets) return false
  if (hextets.every((hextet) => hextet === 0)) return true
  // IPv4-mapped ::ffff:0:0/96 — `new URL` rewrites dotted forms to `::ffff:7f00:1`.
  if (
    hextets[0] === 0 && hextets[1] === 0 && hextets[2] === 0 && hextets[3] === 0 &&
    hextets[4] === 0 && hextets[5] === 0xffff
  ) {
    return isBlockedIPv4(hextets[6] >> 8, hextets[6] & 0xff)
  }
  if (hextets[7] === 1 && hextets.slice(0, 7).every((hextet) => hextet === 0)) return true
  const first = hextets[0]
  return (
    (first & 0xfe00) === 0xfc00 || // fc00::/7
    (first & 0xffc0) === 0xfe80 || // fe80::/10
    (first & 0xffc0) === 0xfec0 // fec0::/10
  )
}

interface PinnedAddress {
  address: string
  family: number
}

/** Fails closed: only hosts validated by assertAllowed for this request resolve. */
function pinnedLookup(pinned: Map<string, PinnedAddress[]>): LookupFunction {
  return (hostname, options, callback) => {
    const addresses = pinned.get(hostname)
    if (!addresses || addresses.length === 0) {
      callback(new Error('地址未通过校验'), '')
      return
    }
    if (options.all) {
      callback(null, addresses)
      return
    }
    callback(null, addresses[0].address, addresses[0].family)
  }
}

async function assertAllowed(
  url: URL,
  allowLocal: boolean,
  pinned: Map<string, PinnedAddress[]>
): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkError('只允许 http 或 https 地址', 'blocked')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost' && (!allowLocal || !url.port)) {
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
  if (isIP(host)) {
    if (isBlockedAddress(host) && !(allowLocal && (host === '127.0.0.1' || host === '::1'))) {
      throw new NetworkError('不允许访问本地或内网地址', 'blocked')
    }
    return
  }
  if (pinned.has(host)) return
  let addresses: PinnedAddress[]
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new NetworkError('无法解析书源域名', 'network')
  }
  if (addresses.some((entry) => isBlockedAddress(entry.address)) && !allowLocal) {
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
  pinned.set(host, addresses)
}

function charsetFrom(contentType: string, html: string): string | null {
  const header = /charset=([^;]+)/i.exec(contentType)?.[1]?.trim().replace(/^["']|["']$/g, '')
  if (header) return header
  return /<meta[^>]+charset=["']?([^"'\s/>]+)/i.exec(html.slice(0, 4096))?.[1] ?? null
}

export function decodeBody(buffer: Buffer, charset?: string, contentType = ''): { text: string; warnings: string[] } {
  const warnings: string[] = []
  if (buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    return { text: buffer.subarray(3).toString('utf8'), warnings }
  }
  const head = buffer.subarray(0, 4096).toString('latin1')
  const label = charset ?? charsetFrom(contentType, head) ?? 'utf-8'
  const normalized = /^gb2312$/i.test(label) ? 'gbk' : label
  if (!iconv.encodingExists(normalized)) {
    warnings.push(`未知字符集 ${label}，按 UTF-8 处理`)
    return { text: buffer.toString('utf8'), warnings }
  }
  return { text: iconv.decode(buffer, normalized), warnings }
}

class CookieJar {
  private readonly values = new Map<string, Map<string, string>>()
  private key(sourceId: string, host: string): string { return `${sourceId}|${host}` }

  header(sourceId: string, url: URL): string {
    const values = this.values.get(this.key(sourceId, url.hostname))
    return values ? [...values.entries()].map(([key, value]) => `${key}=${value}`).join('; ') : ''
  }

  store(sourceId: string, url: URL, setCookies: string[]): void {
    if (setCookies.length === 0) return
    const key = this.key(sourceId, url.hostname)
    const values = this.values.get(key) ?? new Map<string, string>()
    for (const cookie of setCookies) {
      const pair = cookie.split(';', 1)[0]
      const at = pair.indexOf('=')
      if (at > 0) values.set(pair.slice(0, at).trim(), pair.slice(at + 1).trim())
    }
    this.values.set(key, values)
  }

  clearSource(sourceId: string): void {
    for (const key of this.values.keys()) {
      if (key.startsWith(`${sourceId}|`)) this.values.delete(key)
    }
  }
}

export class HttpClient {
  private readonly timeoutMs: number
  private readonly maxBytes: number
  private readonly allowLocal: boolean
  private readonly cookies = new CookieJar()

  constructor(options: { timeoutMs?: number; maxBytes?: number; allowLocal?: boolean } = {}) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
    this.allowLocal = options.allowLocal ?? process.env.READER_ALLOW_LOCAL_SOURCES === '1'
  }

  clearSourceCookies(sourceId: string): void {
    this.cookies.clearSource(sourceId)
  }

  async request(request: HttpRequest): Promise<HttpResponse> {
    const retries = request.method === 'POST' ? 0 : Math.min(1, request.retry ?? 1)
    let lastError: unknown
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (request.signal?.aborted) throw new NetworkError('请求已取消', 'network')
      try {
        return await this.requestOnce(request)
      } catch (error) {
        lastError = error
        // An aborted caller is cancelled, not retried; a timeout or network
        // error with a live signal keeps its normal retry.
        if (request.signal?.aborted) break
        if (!(error instanceof NetworkError) || !['timeout', 'network'].includes(error.kind)) break
      }
    }
    throw lastError instanceof Error ? lastError : new NetworkError('网络请求失败', 'network')
  }

  private async requestOnce(request: HttpRequest): Promise<HttpResponse> {
    const maxBytes = request.maxBytes ?? this.maxBytes
    let current: URL
    try {
      current = new URL(request.url)
    } catch {
      throw new NetworkError('书源地址无效', 'network')
    }
    const warnings: string[] = []
    const pinned = new Map<string, PinnedAddress[]>()
    const dispatcher = new Agent({ connect: { lookup: pinnedLookup(pinned) } })
    try {
      for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
        await assertAllowed(current, this.allowLocal, pinned)
        if (request.signal?.aborted) throw new NetworkError('请求已取消', 'network')
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs)
        const onAbort = (): void => controller.abort()
        // 调用方信号若已中止，监听器不会再触发，先同步中止内部请求。
        if (request.signal?.aborted) controller.abort()
        request.signal?.addEventListener('abort', onAbort)
        try {
          const headers: Record<string, string> = {
            'User-Agent': 'Reader/1.0',
            ...request.headers
          }
          const cookie = this.cookies.header(request.sourceId ?? '', current)
          if (cookie) {
            // A source header may spell the key either way; merge instead of
            // sending two different Cookie headers.
            const existing = headers.Cookie ?? headers.cookie
            headers.Cookie = existing ? `${existing}; ${cookie}` : cookie
            delete headers.cookie
          }
          const response = await fetch(current, {
            method: request.method ?? 'GET',
            headers,
            ...(request.body !== undefined && request.method === 'POST'
              ? { body: Buffer.from(iconv.encode(request.body, request.charset && iconv.encodingExists(request.charset) ? request.charset : 'utf8')) }
              : {}),
            redirect: 'manual',
            signal: controller.signal,
            dispatcher
          })
          const setCookies = typeof response.headers.getSetCookie === 'function'
            ? response.headers.getSetCookie()
            : []
          this.cookies.store(request.sourceId ?? '', current, setCookies)
          if (response.status >= 300 && response.status < 400) {
            const location = response.headers.get('location')
            if (!location) throw new NetworkError(`重定向缺少地址（${response.status}）`, 'http', response.status)
            try {
              current = new URL(location, current)
            } catch {
              throw new NetworkError('重定向地址无效', 'network')
            }
            continue
          }
          if (response.status >= 400) {
            throw new NetworkError(`HTTP ${response.status}`, 'http', response.status)
          }
          const length = Number(response.headers.get('content-length') ?? 0)
          if (Number.isFinite(length) && length > maxBytes) {
            throw new NetworkError('响应内容过大', 'too-large')
          }
          const reader = response.body?.getReader()
          const chunks: Uint8Array[] = []
          let total = 0
          if (reader) {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              total += value.byteLength
              if (total > maxBytes) {
                await reader.cancel().catch(() => undefined)
                throw new NetworkError('响应内容过大', 'too-large')
              }
              chunks.push(value)
            }
          }
          const buffer = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
          const contentType = response.headers.get('content-type') ?? ''
          const decoded = decodeBody(buffer, request.charset, contentType)
          return {
            url: current.toString(),
            status: response.status,
            text: decoded.text,
            contentType,
            warnings: [...warnings, ...decoded.warnings]
          }
        } catch (error) {
          if (error instanceof NetworkError) throw error
          if (request.signal?.aborted) throw new NetworkError('请求已取消', 'network')
          if (controller.signal.aborted) throw new NetworkError('请求超时', 'timeout')
          throw new NetworkError('网络请求失败', 'network')
        } finally {
          clearTimeout(timer)
          request.signal?.removeEventListener('abort', onAbort)
        }
      }
      throw new NetworkError('重定向次数过多', 'network')
    } finally {
      await dispatcher.destroy()
    }
  }
}
