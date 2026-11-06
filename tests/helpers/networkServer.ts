import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'

export interface FakeServer {
  url: string
  close: () => Promise<void>
  /** When true, the next request answers 500 and the flag resets. */
  failNext: boolean
  requestCount: number
  /** Milliseconds to wait before running the handler (0 = immediate). */
  delayMs: number
}

/**
 * One local HTTP server used by every network test. `failNext` and `delayMs`
 * exist from the start so search-cancel and download-cancel tests can use
 * them without reworking the helper later.
 */
export async function startFakeServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void
): Promise<FakeServer> {
  const state: FakeServer = {
    url: '',
    close: async () => undefined,
    failNext: false,
    requestCount: 0,
    delayMs: 0
  }
  const server = createServer((req, res) => {
    state.requestCount++
    if (state.failNext) {
      state.failNext = false
      res.writeHead(500)
      res.end()
      return
    }
    if (state.delayMs > 0) {
      setTimeout(() => handler(req, res), state.delayMs)
      return
    }
    handler(req, res)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('fake server did not bind')
  state.url = `http://127.0.0.1:${address.port}`
  state.close = () =>
    new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  return state
}
