import { promises as dns } from 'node:dns'
import { isIP } from 'node:net'
import iconv from 'iconv-lite'

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

export function isBlockedAddress(address: string): boolean {
  const ip = address.toLowerCase().startsWith('::ffff:') ? address.slice(7) : address
  if (ip === '::1' || ip === '0.0.0.0') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 0 || a === 127 || a === 10 ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254)
    )
  }
  if (isIP(ip) === 6) {
    return /^(fc|fd|fe8|fe9|fea|feb)/i.test(ip) || ip === '::1'
  }
  return false
}

async function assertAllowed(url: URL, allowLocal: boolean): Promise<void> {
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new NetworkError('只允许 http 或 https 地址', 'blocked')
  }
  const host = url.hostname.replace(/^\[|\]$/g, '')
  if (host === 'localhost') {
    if (allowLocal && url.port) return
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
  if (isIP(host)) {
    if (isBlockedAddress(host) && !(allowLocal && (host === '127.0.0.1' || host === '::1'))) {
      throw new NetworkError('不允许访问本地或内网地址', 'blocked')
    }
    return
  }
  let addresses: { address: string }[]
  try {
    addresses = await dns.lookup(host, { all: true })
  } catch {
    throw new NetworkError('无法解析书源域名', 'network')
  }
  if (addresses.some((entry) => isBlockedAddress(entry.address)) && !allowLocal) {
    throw new NetworkError('不允许访问本地或内网地址', 'blocked')
  }
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
      try {
        return await this.requestOnce(request)
      } catch (error) {
        lastError = error
        if (!(error instanceof NetworkError) || !['timeout', 'network'].includes(error.kind)) break
      }
    }
    throw lastError instanceof Error ? lastError : new NetworkError('网络请求失败', 'network')
  }

  private async requestOnce(request: HttpRequest): Promise<HttpResponse> {
    let current = new URL(request.url)
    const warnings: string[] = []
    for (let redirect = 0; redirect <= MAX_REDIRECTS; redirect++) {
      await assertAllowed(current, this.allowLocal)
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? this.timeoutMs)
      const onAbort = (): void => controller.abort()
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
          signal: controller.signal
        })
        const setCookies = typeof response.headers.getSetCookie === 'function'
          ? response.headers.getSetCookie()
          : []
        this.cookies.store(request.sourceId ?? '', current, setCookies)
        if (response.status >= 300 && response.status < 400) {
          const location = response.headers.get('location')
          if (!location) throw new NetworkError(`重定向缺少地址（${response.status}）`, 'http', response.status)
          current = new URL(location, current)
          continue
        }
        if (response.status >= 400) {
          throw new NetworkError(`HTTP ${response.status}`, 'http', response.status)
        }
        const length = Number(response.headers.get('content-length') ?? 0)
        if (Number.isFinite(length) && length > this.maxBytes) {
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
            if (total > this.maxBytes) {
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
        if (controller.signal.aborted) throw new NetworkError('请求超时', 'timeout')
        throw new NetworkError(error instanceof Error ? error.message : '网络请求失败', 'network')
      } finally {
        clearTimeout(timer)
        request.signal?.removeEventListener('abort', onAbort)
      }
    }
    throw new NetworkError('重定向次数过多', 'network')
  }
}
