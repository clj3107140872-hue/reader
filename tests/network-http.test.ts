import { gzipSync } from 'node:zlib'
import { afterEach, describe, expect, it } from 'vitest'
import { startFakeServer } from './helpers/networkServer'
import { HttpClient } from '../src/main/services/network/httpClient'

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
