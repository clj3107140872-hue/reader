import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../core/model'

function coverInitial(title: string): string {
  return title.trim().charAt(0) || '书'
}

export default function App() {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName}`)
    })
  }, [])

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
      setMessage(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
      await refresh()
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <h1>我的书架</h1>
        <button onClick={() => void handleImport()} disabled={busy}>
          {busy ? '导入中…' : '导入 TXT'}
        </button>
      </header>

      {progress && <p className="hint">{progress}</p>}
      {message && <p className="hint">{message}</p>}

      {entries.length === 0 ? (
        <p className="empty">书架还是空的，拖入或导入一个 TXT 文件开始阅读。</p>
      ) : (
        <div className="grid">
          {entries.map((entry) => (
            <div className="card" key={entry.id}>
              <div className="cover">{coverInitial(entry.title)}</div>
              <div className="meta">
                <div className="title" title={entry.title}>
                  {entry.title}
                </div>
                <div className="sub">{entry.chapterCount} 章 · {entry.encoding}</div>
                <div className="sub">
                  进度 {entry.progressPercent}% · 广告清理 {entry.stats.adLinesRemoved} 行
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
