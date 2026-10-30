export function assertBookId(id: unknown): void {
  if (typeof id !== 'string' || !/^[A-Za-z0-9-]+$/.test(id)) {
    throw new Error('无效的书籍编号')
  }
}
