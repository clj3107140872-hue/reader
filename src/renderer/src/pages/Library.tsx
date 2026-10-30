import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'

type SortMode = 'recent' | 'imported' | 'title'

const SORTERS: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
  recent: (a, b) => (b.lastReadAt ?? b.importedAt).localeCompare(a.lastReadAt ?? a.importedAt),
  imported: (a, b) => b.importedAt.localeCompare(a.importedAt),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
}

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function Library({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName}`)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const handleImport = async (): Promise<void> => {
    setBusy(true)
    setProgress('')
    try {
      const summary = await window.api.chooseAndImport()
      const parts: string[] = []
      if (summary.imported > 0) parts.push(`成功导入 ${summary.imported} 本`)
      if (summary.duplicates.length > 0) parts.push(`已在书库：${summary.duplicates.join('、')}`)
      if (summary.suspects.length > 0) {
        parts.push(
          `疑似同一本书（暂未合并）：${summary.suspects
            .map((item) => `${item.title}，内容重叠 ${(item.overlap * 100).toFixed(0)}%`)
            .join('；')}`
        )
      }
      if (summary.errors.length > 0) parts.push(`失败：${summary.errors.join('；')}`)
      if (summary.warnings.length > 0) parts.push(`提示：${summary.warnings.join('；')}`)
      setToast({
        id: Date.now(),
        text: parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件'
      })
      await refresh()
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const sorted = [...entries].sort(SORTERS[sort])

  return (
    <div className="app">
      <header className="toolbar">
        <h1>我的书架</h1>
        <div className="toolbar-actions">
          <select
            className="sort-select"
            value={sort}
            onChange={(event) => setSort(event.target.value as SortMode)}
            aria-label="排序方式"
          >
            <option value="recent">最近阅读</option>
            <option value="imported">导入时间</option>
            <option value="title">书名</option>
          </select>
          <button onClick={() => void handleImport()} disabled={busy}>
            {busy ? '导入中…' : '导入 TXT'}
          </button>
        </div>
      </header>

      {progress && <p className="hint">{progress}</p>}
      {toast && (
        <div className="toast" role="status">
          {toast.text}
        </div>
      )}

      {entries.length === 0 ? (
        <p className="empty">书架还是空的，点击右上角「导入 TXT」开始阅读。</p>
      ) : (
        <div className="grid">
          {sorted.map((entry) => (
            <button className="card" key={entry.id} onClick={() => onOpen(entry.id)}>
              <div className="cover">{coverInitial(entry.title)}</div>
              <div className="meta">
                <div className="title" title={entry.title}>
                  {entry.title}
                </div>
                <div className="sub">
                  {entry.chapterCount} 章 · {entry.encoding}
                </div>
                <div className="sub">
                  进度 {entry.progressPercent}% · 广告 {entry.stats.adLinesRemoved} 行 · 重复段{' '}
                  {entry.stats.duplicateParagraphsMerged}
                </div>
                {entry.stats.suspectedDuplicateChapters > 0 && (
                  <div className="sub warn">疑似重复章节 {entry.stats.suspectedDuplicateChapters}</div>
                )}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
