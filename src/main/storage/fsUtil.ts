import {
  copyFileSync,
  existsSync,
  mkdirSync,
  promises as fs,
  readFileSync,
  renameSync,
  writeFileSync
} from 'node:fs'
import { dirname } from 'node:path'

export async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true })
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path)
    return true
  } catch {
    return false
  }
}

export async function atomicWriteJson(path: string, value: unknown, backup = true): Promise<void> {
  await ensureDir(dirname(path))
  const tmp = `${path}.tmp`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  if (backup && (await pathExists(path))) {
    await fs.copyFile(path, `${path}.bak`)
  }
  await fs.rename(tmp, path)
}

export async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(path, 'utf8')) as T
  } catch {
    return null
  }
}

export function atomicWriteJsonSync(path: string, value: unknown, backup = true): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8')
  if (backup && existsSync(path)) {
    copyFileSync(path, `${path}.bak`)
  }
  renameSync(tmp, path)
}

export function readJsonSync<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T
  } catch {
    return null
  }
}
