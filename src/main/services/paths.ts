import { app } from 'electron'
import { dirname, join } from 'node:path'

export function resolveDataDir(): string {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    return join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
  }
  if (app.isPackaged) {
    return join(dirname(app.getPath('exe')), 'data')
  }
  return join(process.cwd(), 'data')
}
