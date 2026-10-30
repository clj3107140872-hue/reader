export function assertBookId(id: string): void {
  if (!/^[A-Za-z0-9-]+$/.test(id)) throw new Error('无效的书籍编号')
}
