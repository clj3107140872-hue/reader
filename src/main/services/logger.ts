import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const MAX_BYTES = 1024 * 1024
const KEEP = 3

/**
 * Append-only application log under `data/logs/app.log`. Rotation keeps the
 * current file plus three generations. Logging must never take the app down,
 * so every filesystem error is swallowed.
 */
export class Logger {
  private readonly dir: string
  private readonly file: string

  constructor(
    root: string,
    private readonly maxBytes = MAX_BYTES
  ) {
    this.dir = join(root, 'logs')
    this.file = join(this.dir, 'app.log')
  }

  info(message: string): void {
    this.write('INFO', message)
  }

  error(scope: string, reason: unknown): void {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    this.write('ERROR', `${scope}: ${detail}`)
  }

  private write(level: string, message: string): void {
    try {
      mkdirSync(this.dir, { recursive: true })
      this.rotate()
      const text = message.replace(/\r?\n/g, '\n    ')
      appendFileSync(this.file, `[${new Date().toISOString()}] ${level} ${text}\n`, 'utf8')
    } catch {
      // A broken log directory is not worth crashing over.
    }
  }

  private rotate(): void {
    try {
      if (!existsSync(this.file) || statSync(this.file).size < this.maxBytes) return
      for (let index = KEEP; index >= 1; index--) {
        const from = index === 1 ? this.file : `${this.file}.${index - 1}`
        const to = `${this.file}.${index}`
        if (!existsSync(from)) continue
        rmSync(to, { force: true })
        renameSync(from, to)
      }
    } catch {
      // Keep logging to the current file even if rotation fails.
    }
  }
}
