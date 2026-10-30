// Development-only automation helper.
// Evaluates JavaScript inside the running reader window over the Chrome
// DevTools Protocol. The dev build opens port 9222 automatically; packaged
// builds do not.
//
// Usage:
//   npm run dev                         # in another terminal
//   node scripts/debug-eval.cjs "window.api.ping()"
//   node scripts/debug-eval.cjs "window.api.debugImport(['D:/books/novel.txt'])"
//   node scripts/debug-eval.cjs "document.querySelector('.toast')?.textContent"

const expression = process.argv[2]
if (!expression) {
  console.error('usage: node scripts/debug-eval.cjs "<javascript expression>"')
  process.exit(2)
}

async function main() {
  const list = await (await fetch('http://127.0.0.1:9222/json/list')).json()
  const page = list.find((target) => target.type === 'page')
  if (!page) throw new Error('no page target; is the dev app running?')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = reject
  })

  let nextId = 0
  function send(method, params) {
    return new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 15000)
      const onMessage = (event) => {
        const message = JSON.parse(event.data)
        if (message.id !== id) return
        clearTimeout(timer)
        ws.removeEventListener('message', onMessage)
        resolve(message)
      }
      ws.addEventListener('message', onMessage)
      ws.send(JSON.stringify({ id, method, params }))
    })
  }

  const response = await send('Runtime.evaluate', {
    expression,
    returnByValue: true,
    awaitPromise: true
  })
  const value = response.result?.result?.value
  console.log(JSON.stringify(value !== undefined ? value : response.result, null, 2))
  ws.close()
}

main().catch((error) => {
  console.error(error.message)
  process.exit(1)
})
