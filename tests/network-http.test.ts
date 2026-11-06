import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { HttpClient, NetworkError, isBlockedAddress } from '../src/main/services/network/httpClient'
import { userFacingNetworkError } from '../src/main/services/network/errors'

process.env.READER_ALLOW_LOCAL_SOURCES = '1'

let close: (() => Promise<void>) | null = null
afterEach(async () => { if (close) await close(); close = null })

describe('HttpClient', () => {
  it('fetches text and follows a redirect, revalidating the target', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/go') { res.writeHead(302, { Location: '/ok' }); res.end(); return }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<p>你好</p>')
    })
    close = server.close
    const client = new HttpClient()
    const response = await client.request({ url: `${server.url}/go` })
    expect(response.text).toContain('你好')
    expect(response.url).toBe(`${server.url}/ok`)
  })

  it('blocks private addresses unless the test flag is on', async () => {
    const previous = process.env.READER_ALLOW_LOCAL_SOURCES
    delete process.env.READER_ALLOW_LOCAL_SOURCES
    try {
      const client = new HttpClient()
      await expect(client.request({ url: 'http://127.0.0.1:9/' }))
        .rejects.toMatchObject({ kind: 'blocked' })
    } finally {
      process.env.READER_ALLOW_LOCAL_SOURCES = previous
    }
  })

  it('blocks IPv4-mapped IPv6 forms', () => {
    expect(isBlockedAddress('::ffff:127.0.0.1')).toBe(true)
    expect(isBlockedAddress('::ffff:7f00:1')).toBe(true)
    expect(isBlockedAddress('::ffff:c0a8:101')).toBe(true)
    expect(isBlockedAddress('::ffff:8.8.8.8')).toBe(false)
  })

  it('revalidates redirect targets and blocks private ones', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(302, { Location: 'http://10.255.255.1:9/' })
      res.end()
    })
    close = server.close
    const client = new HttpClient()
    await expect(client.request({ url: `${server.url}/to-private` }))
      .rejects.toMatchObject({ kind: 'blocked' })
  })

  it('turns an invalid address into a Chinese error', async () => {
    const client = new HttpClient()
    const rejection = client.request({ url: 'not a url' })
    await expect(rejection).rejects.toBeInstanceOf(NetworkError)
    await expect(rejection).rejects.toMatchObject({
      message: expect.stringMatching(/[一-鿿]/)
    })
  })

  it('stops a request when the caller aborts and never retries it', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('<p>迟到的响应</p>')
    })
    close = server.close
    server.delayMs = 200
    const controller = new AbortController()
    const client = new HttpClient()
    const running = client.request({ url: `${server.url}/slow`, signal: controller.signal })
    setTimeout(() => controller.abort(), 30)
    const error = await running.catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(NetworkError)
    expect((error as Error).message).toMatch(/[一-鿿]/)
    expect(server.requestCount).toBe(1)
  })

  it('decodes GBK', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
    })
    close = server.close
    const client = new HttpClient()
    const response = await client.request({ url: `${server.url}/gbk`, charset: 'gbk' })
    expect(response.text).toBe('你好')
  })

  it('maps http failures to actionable Chinese copy with the source name', () => {
    const http = (status: number): NetworkError => new NetworkError(`HTTP ${status}`, 'http', status)
    expect(userFacingNetworkError(http(403), '源A')).toBe(
      '《源A》拒绝访问（403），可能需要登录或更换书源'
    )
    expect(userFacingNetworkError(http(404), '源A')).toBe(
      '《源A》页面不存在（404），书源可能已失效'
    )
    expect(userFacingNetworkError(http(429), '源A')).toBe(
      '《源A》请求太频繁（429），请稍后再试'
    )
    expect(userFacingNetworkError(http(503), '源A')).toBe(
      '《源A》站点暂时不可用（503），请稍后再试'
    )
    expect(userFacingNetworkError(new NetworkError('请求超时', 'timeout'), '源A')).toBe(
      '连接《源A》超时，请稍后重试或换个书源'
    )
    // Already-Chinese, already-actionable errors pass through unchanged.
    expect(userFacingNetworkError(new NetworkError('不允许访问本地或内网地址', 'blocked'), '源A'))
      .toBe('不允许访问本地或内网地址')
  })

  it('caps a single request below the client default', async () => {
    const server = await startFakeServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('y'.repeat(2048))
    })
    close = server.close
    const client = new HttpClient()
    await expect(client.request({ url: `${server.url}/big`, maxBytes: 1024 }))
      .rejects.toMatchObject({ kind: 'too-large' })
  })

  it('stops an oversized body and a gzip bomb by decompressed size', async () => {
    const server = await startFakeServer((req, res) => {
      if (req.url === '/bomb') {
        // Small on the wire, 4 KB after decompression: the stream cap must
        // count decompressed bytes, not content-length.
        res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' })
        res.end(gzipSync(Buffer.from('x'.repeat(4096))))
        return
      }
      res.writeHead(200, { 'Content-Type': 'text/html' })
      res.end('y'.repeat(2048))
    })
    close = server.close
    const client = new HttpClient({ maxBytes: 1024 })
    await expect(client.request({ url: `${server.url}/big` }))
      .rejects.toMatchObject({ kind: 'too-large' })
    await expect(client.request({ url: `${server.url}/bomb` }))
      .rejects.toMatchObject({ kind: 'too-large' })
  })
})
