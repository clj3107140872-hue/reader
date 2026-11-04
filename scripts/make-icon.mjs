// Rasterizes build/icon.svg into build/icon.ico (+ build/icon.png) using an
// offscreen Electron window, so icon generation needs no image dependency.
// Run: npx electron scripts/make-icon.mjs
import { app, BrowserWindow, nativeImage } from 'electron'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const buildDir = join(root, 'build')
const logPath = join(buildDir, 'make-icon.log')
const sizes = [16, 24, 32, 48, 64, 128, 256]
// Offscreen windows only render reliably once per process, so draw the SVG
// at 512px and let Electron downsample each ICO entry.
const RENDER_SIZE = 512

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('force-device-scale-factor', '1')
// Destroying the render window would otherwise quit the app before the ICO
// has been written.
app.on('window-all-closed', () => {})

async function log(message) {
  await appendFile(logPath, `${message}\n`)
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function render(svg, size) {
  const win = new BrowserWindow({
    width: size,
    height: size,
    useContentSize: true,
    show: false,
    frame: false,
    transparent: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  try {
    const html = `<!doctype html><html><body style="margin:0;background:transparent;overflow:hidden">
<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"
 style="display:block;width:${size}px;height:${size}px">
</body></html>`
    await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString('base64')}`)
    await wait(500)
    return (await win.webContents.capturePage()).toPNG()
  } finally {
    win.destroy()
  }
}

function buildIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(images.length, 4)

  const entries = Buffer.alloc(16 * images.length)
  let offset = header.length + entries.length
  images.forEach(({ size, png }, index) => {
    const at = index * 16
    entries.writeUInt8(size >= 256 ? 0 : size, at)
    entries.writeUInt8(size >= 256 ? 0 : size, at + 1)
    entries.writeUInt8(0, at + 2)
    entries.writeUInt8(0, at + 3)
    entries.writeUInt16LE(1, at + 4)
    entries.writeUInt16LE(32, at + 6)
    entries.writeUInt32LE(png.length, at + 8)
    entries.writeUInt32LE(offset, at + 12)
    offset += png.length
  })

  return Buffer.concat([header, entries, ...images.map((image) => image.png)])
}

async function main() {
  await log('ready')
  const svg = await readFile(join(buildDir, 'icon.svg'), 'utf8')
  const master = nativeImage.createFromBuffer(await render(svg, RENDER_SIZE))
  if (master.isEmpty()) throw new Error('offscreen capture returned an empty image')
  await log(`rendered ${master.getSize().width}`)

  const images = sizes.map((size) => ({
    size,
    png:
      size === RENDER_SIZE
        ? master.toPNG()
        : master.resize({ width: size, height: size, quality: 'best' }).toPNG()
  }))
  await writeFile(join(buildDir, 'icon.ico'), buildIco(images))
  await writeFile(join(buildDir, 'icon.png'), master.resize({ width: 256, height: 256, quality: 'best' }).toPNG())
  await log(`icon.ico written with sizes ${sizes.join(', ')}`)
}

app.whenReady().then(
  () =>
    main().then(
      () => app.quit(),
      async (error) => {
        await log(`failed: ${error instanceof Error ? error.stack : String(error)}`)
        app.exit(1)
      }
    ),
  async (error) => {
    await log(`whenReady failed: ${String(error)}`)
    app.exit(1)
  }
)
