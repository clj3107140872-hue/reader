// 网络书源离屏验收：真实应用 + 127.0.0.1 假书源。
// READER_ACCEPTANCE=1 让窗口离屏；PORTABLE_EXECUTABLE_DIR 指向临时目录。
// Usage: node scripts/acceptance-network.cjs

const { spawn, execFileSync } = require('node:child_process')
const { createServer } = require('node:http')
const { connect: connectTcp } = require('node:net')
const { createWriteStream } = require('node:fs')
const { mkdtemp, readFile, rm } = require('node:fs/promises')
const { tmpdir } = require('node:os')
const { join } = require('node:path')

const ROOT = join(__dirname, '..')
const CDP_LIST = 'http://127.0.0.1:9222/json/list'

function sourceDefinition(url) {
  return {
    bookSourceName: '假书源',
    bookSourceUrl: url,
    bookSourceGroup: '验收',
    searchUrl: '/s?q={{key}}',
    ruleSearch: {
      bookList: '.book',
      name: '.name',
      author: '.author',
      bookUrl: '.name@href',
      intro: '.intro'
    },
    ruleBookInfo: { name: 'h1', author: '.author', intro: '.intro', tocUrl: '.toc@href' },
    ruleToc: { chapterList: '.c', chapterName: '@text', chapterUrl: '@href' },
    ruleContent: { content: '#content@html' }
  }
}

function startFakeSource() {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    const url = req.url ?? ''
    if (url.startsWith('/s?')) {
      res.end(
        '<div class="book"><a class="name" href="/info">测试书</a><span class="author">作者</span><p class="intro">简介</p></div>'
      )
    } else if (url.startsWith('/info')) {
      res.end('<h1>测试书</h1><span class="author">作者</span><a class="toc" href="/toc">目录</a>')
    } else if (url === '/toc') {
      res.end('<a class="c" href="/c/1">第一章</a><a class="c" href="/c/2">第二章</a>')
    } else if (url === '/c/1') {
      res.end('<div id="content">正文一<br>第二句</div>')
    } else if (url === '/c/2') {
      res.end('<div id="content">正文二</div>')
    } else {
      res.end('')
    }
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () =>
          new Promise((done) => {
            // 渲染进程假死时 keep-alive 连接会让 close() 一直等下去；先断开
            // 现有连接，再给关闭本身加超时兜底。
            let settled = false
            const finish = () => {
              if (settled) return
              settled = true
              clearTimeout(timer)
              done()
            }
            const timer = setTimeout(finish, 5000)
            timer.unref?.()
            try {
              server.closeAllConnections?.()
            } catch {
              // 老版本 Node 没有这个方法。
            }
            server.close(() => finish())
          })
      })
    })
  })
}

/** Any successful TCP connect means the debugging port is already taken. */
function portInUse(port, timeoutMs = 1000) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connectTcp({ host: '127.0.0.1', port })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
  })
}

async function tailLog(logPath, lines = 20) {
  try {
    const text = await readFile(logPath, 'utf8')
    return text.split(/\r?\n/).slice(-lines).join('\n')
  } catch {
    return ''
  }
}

async function currentTarget() {
  const response = await fetch(CDP_LIST, { signal: AbortSignal.timeout(1000) })
  if (!response.ok) return null
  const list = await response.json()
  return list.find((target) => target.type === 'page') ?? null
}

async function waitForApp({ child, logPath, timeoutMs = 120000 }) {
  let exit = null
  const onExit = (code, signal) => {
    exit = { code, signal }
  }
  child.once('exit', onExit)
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      if (exit) {
        throw new Error(
          `开发进程提前退出（code=${exit.code} signal=${exit.signal}），日志末尾：\n${await tailLog(logPath)}`
        )
      }
      let text = ''
      try {
        text = await readFile(logPath, 'utf8')
      } catch {
        // 日志文件还没建好。
      }
      // 本进程自己的 Electron 抢不到 9222 时才会出现这一行；另一个实例
      // 占着端口时，绝不能把我们的假书源写进它的真实数据目录。
      if (text.includes('Cannot start http server for devtools')) {
        throw new Error(`9222 调试端口被其他实例占用，本次启动未能接管，日志末尾：\n${await tailLog(logPath)}`)
      }
      // 只有本进程的 Electron 真正在 9222 上启动调试服务后，才去取页面
      // 目标；否则可能连到别的开发实例。
      if (text.includes('DevTools listening on ws://127.0.0.1:9222/')) {
        const target = await currentTarget().catch(() => null)
        if (target) return target
      }
      await new Promise((resolve) => setTimeout(resolve, 500))
    }
  } finally {
    child.removeListener('exit', onExit)
  }
  throw new Error(`开发窗口在 ${timeoutMs / 1000} 秒内没有打开 9222 调试端口`)
}

/**
 * The main process logs its resolved data dir at startup. Asserting it points
 * at the temp directory proves a regression in env handling cannot silently
 * write the fake source or book into the real `data/`.
 */
async function assertTempDataDir(tempDir, timeoutMs = 15000) {
  const expected = join(tempDir, 'data')
  const appLog = join(expected, 'logs', 'app.log')
  const deadline = Date.now() + timeoutMs
  let text = ''
  while (Date.now() < deadline) {
    try {
      text = await readFile(appLog, 'utf8')
    } catch {
      text = ''
    }
    if (text.includes(`data=${expected}`)) return
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`应用没有使用临时数据目录：${appLog} 里没有 data=${expected}`)
}

async function connect(target) {
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.close()
      } catch {
        // 连接还没建立。
      }
      reject(new Error('CDP WebSocket 握手超时'))
    }, 10000)
    ws.onopen = () => {
      clearTimeout(timer)
      resolve()
    }
    ws.onerror = (event) => {
      clearTimeout(timer)
      reject(new Error(`CDP WebSocket 连接失败：${event?.message ?? '未知错误'}`))
    }
  })
  let nextId = 0
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId
      const timer = setTimeout(() => reject(new Error('CDP timeout')), 30000)
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
  const evaluate = async (expression) => {
    const response = await send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true
    })
    const exception = response.result?.exceptionDetails
    if (exception) {
      throw new Error(exception.exception?.description ?? exception.text ?? '页面执行失败')
    }
    return response.result?.result?.value
  }
  return { evaluate, close: () => ws.close() }
}

async function waitFor(page, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const value = await page.evaluate(expression)
      if (value) return value
    } catch {
      // 重载期间上下文暂时不可用。
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${label}（等待超时）`)
}

/**
 * Waits until `expression` returns a truthy value and the same value three
 * times in a row. Lazy chapter text arrives asynchronously; the reader's
 * settle effect moves the view after it lands, so a single observation is not
 * enough to know the page has stopped changing.
 */
async function waitForStable(page, expression, label, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  let last = null
  let confirmed = 0
  while (Date.now() < deadline) {
    let value = null
    try {
      value = await page.evaluate(expression)
    } catch {
      value = null
    }
    if (value) {
      if (value === last) confirmed++
      else {
        last = value
        confirmed = 0
      }
      if (confirmed >= 2) return value
    } else {
      last = null
      confirmed = 0
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`${label}（等待超时）`)
}

async function reload(page) {
  try {
    await page.evaluate('location.reload()')
  } catch {
    // 导航会打断这次执行，忽略。
  }
  await waitFor(
    page,
    "document.readyState === 'complete' && !!document.querySelector('.toolbar')",
    '页面重载后没有回到书架'
  )
}

async function stopApp(child) {
  const deadline = Date.now() + 20000
  while (Date.now() < deadline) {
    try {
      await fetch(CDP_LIST, { signal: AbortSignal.timeout(500) })
    } catch {
      return
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
  }
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' })
  } catch {
    // 进程已经不在了。
  }
}

async function main() {
  // 任何 TCP 响应都视为 9222 已被占用：只要端口有监听，开发应用就绑不上；
  // 也不能冒险连到别的实例，把假书源写进它的真实 data/。
  if (await portInUse(9222)) {
    throw new Error('9222 已有实例在运行（端口有响应），先关闭开发实例再跑验收')
  }
  let tempDir = null
  let log = null
  let child = null
  let page = null
  let fake = null
  try {
    tempDir = await mkdtemp(join(tmpdir(), 'reader-acceptance-network-'))
    const logPath = join(tempDir, 'dev.log')
    log = createWriteStream(logPath)
    fake = await startFakeSource()

    const env = { ...process.env }
    delete env.ELECTRON_RUN_AS_NODE
    env.READER_ACCEPTANCE = '1'
    env.PORTABLE_EXECUTABLE_DIR = tempDir
    // 仅验收脚本为 127.0.0.1 假书源放行；生产代码仍然只允许 http(s) 公网地址。
    env.READER_ALLOW_LOCAL_SOURCES = '1'
    child = spawn('npm run dev', {
      cwd: ROOT,
      env,
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    child.stdout.pipe(log)
    child.stderr.pipe(log)

    page = await connect(await waitForApp({ child, logPath }))
    // 证明应用确实用了临时数据目录，绝没有碰仓库里真实的 data/。
    await assertTempDataDir(tempDir)
    await waitFor(page, "!!document.querySelector('.toolbar')", '书架没有加载')

    const imported = await page.evaluate(
      `window.api.importSources({ kind: 'json', json: ${JSON.stringify(
        JSON.stringify(sourceDefinition(fake.url))
      )} })`
    )
    if (imported.added !== 1) throw new Error(`导入书源失败：${JSON.stringify(imported)}`)
    console.log('PASS 导入书源')

    const found = await page.evaluate(
      "window.api.searchNetwork({ requestId: 'acc', keyword: '测试书', scope: 'quality' })"
    )
    const item = found?.groups?.[0]?.items?.[0]
    if (!item) throw new Error(`搜索没有结果：${JSON.stringify(found)}`)
    console.log('PASS 优质书源搜索')

    const entry = await page.evaluate(
      `window.api.addNetworkBook(${JSON.stringify({ sourceId: item.sourceId, bookUrl: item.bookUrl })})`
    )
    if (!entry?.id) throw new Error('加入书架没有返回书籍')
    console.log('PASS 加入书架')

    await reload(page)
    const cardText = await waitFor(
      page,
      "[...document.querySelectorAll('.card')].map((node) => node.textContent).join('|')",
      '书架没有卡片'
    )
    if (!cardText.includes('网络 · 假书源')) throw new Error(`书架没有网络徽标：${cardText}`)
    console.log('PASS 书架网络徽标')

    // 在真实阅读器里打开网络书：首章正文是懒加载的，必须等真实 DOM
    // 状态（正文出现、占位消失、滚动位置稳定）再继续。
    await page.evaluate("document.querySelector('.card-open').click()")
    await waitForStable(
      page,
      `(() => {
        const scroller = document.querySelector('.reader-scroll')
        const section = document.querySelector('[data-chapter-section="0"]')
        if (!scroller || !section) return ''
        if (!section.textContent.includes('正文一')) return ''
        if (document.querySelectorAll('.chapter-placeholder').length > 0) return ''
        const paragraphs = section.querySelectorAll('.reader-paragraph').length
        return 'ready:' + paragraphs + ':' + Math.round(scroller.scrollTop)
      })()`,
      '阅读器没有完成第一章懒加载'
    )
    console.log('PASS 阅读器懒加载第一章')
    await page.evaluate(
      "[...document.querySelectorAll('.reader-toolbar button')].find((button) => button.textContent === '← 书架').click()"
    )
    await waitFor(page, "!!document.querySelector('.card')", '从阅读器返回书架失败')

    const chapter = await page.evaluate(
      `window.api.readNetworkChapter(${JSON.stringify(entry.id)}, 0)`
    )
    if (!chapter.text.includes('正文一')) throw new Error('按需读取第一章失败')
    console.log('PASS 按需读取章节')

    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '书源').click()"
    )
    const sourceText = await waitFor(
      page,
      "document.querySelector('.source-row')?.textContent ?? ''",
      '书源页没有列出书源'
    )
    if (!sourceText.includes('假书源')) throw new Error('书源页没有导入的书源')
    console.log('PASS 书源页')

    await page.evaluate("document.querySelector('.toolbar button').click()")
    await waitFor(page, "!!document.querySelector('.card')", '返回书架失败')
    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '网络搜索').click()"
    )
    await waitFor(page, "!!document.querySelector('.network-search-bar')", '网络搜索页没有打开')
    console.log('PASS 网络搜索页')

    const updated = await page.evaluate(`window.api.updateToc(${JSON.stringify(entry.id)})`)
    if (updated.total !== 2) throw new Error(`更新目录失败：${JSON.stringify(updated)}`)
    const downloaded = await page.evaluate(`window.api.downloadAll(${JSON.stringify(entry.id)})`)
    if (downloaded.failedChapters.length > 0) {
      throw new Error(`下载有失败章节：${JSON.stringify(downloaded.failedChapters)}`)
    }
    const converted = await page.evaluate(`window.api.convertToLocal(${JSON.stringify(entry.id)})`)
    if (converted.chapterCount !== 2) throw new Error(`转本地失败：${JSON.stringify(converted)}`)
    const opened = await page.evaluate(`window.api.openBook(${JSON.stringify(entry.id)})`)
    if (opened.contentMode !== 'eager') throw new Error('转本地后仍按懒加载打开')
    console.log('PASS 更新目录 / 下载全本 / 转本地')

    await reload(page)
    const convertedCards = await waitFor(
      page,
      "[...document.querySelectorAll('.card')].map((node) => node.textContent).join('|')",
      '转本地后书架没有卡片'
    )
    if (convertedCards.includes('网络 ·')) throw new Error('转本地后仍显示网络徽标')
    console.log('PASS 转本地后书架状态')

    await page.evaluate("window.api.updateSettings({ network: { enabled: false } })")
    await reload(page)
    await page.evaluate(
      "[...document.querySelectorAll('.toolbar-actions button')].find((button) => button.textContent === '网络搜索').click()"
    )
    // 设置是异步加载的，提示可能在打开页面后才出现；等提示本身，而不是
    // 只等页面存在就立刻断言。
    await waitFor(
      page,
      "!!document.querySelector('.network-search-bar') && document.body.textContent.includes('已关闭「允许联网」')",
      '关闭联网后网络搜索页没有显示提示'
    )
    console.log('PASS 关闭联网提示')
  } finally {
    try {
      if (page) await page.evaluate('window.close()')
    } catch {
      // 窗口可能已经关闭。
    }
    page?.close()
    if (child) await stopApp(child)
    if (fake) {
      try {
        await fake.close()
      } catch {
        // 假书源可能已经关闭。
      }
    }
    if (log) {
      await new Promise((resolve) => log.end(resolve))
    }
    if (tempDir) {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          await rm(tempDir, { recursive: true, force: true })
          break
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 1000))
        }
      }
    }
  }
}

main()
  .then(() => {
    console.log('验收通过')
    process.exit(0)
  })
  .catch((error) => {
    console.error(`FAIL ${error.message}`)
    process.exit(1)
  })
