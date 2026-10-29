import { promises as fs } from 'node:fs'
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
