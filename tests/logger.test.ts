import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Logger } from '../src/main/services/logger'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-logger-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('Logger', () => {
  it('rotates app.log when it reaches the size limit', async () => {
    const logger = new Logger(root, 60)
    logger.info('a'.repeat(80))
    logger.info('b'.repeat(80))

    const files = (await readdir(join(root, 'logs'))).sort()
    expect(files).toEqual(['app.log', 'app.log.1'])
    expect(await readFile(join(root, 'logs', 'app.log.1'), 'utf8')).toContain('a')
    const current = await readFile(join(root, 'logs', 'app.log'), 'utf8')
    expect(current).toContain('b')
    expect(current).not.toContain('a')
  })

  it('writes error stacks as indented lines', async () => {
    const logger = new Logger(root)
    logger.error('uncaught', new Error('boom'))

    const text = await readFile(join(root, 'logs', 'app.log'), 'utf8')
    expect(text).toContain('ERROR uncaught: Error: boom')
    expect(text).toMatch(/\n\s+at /)
  })
})
