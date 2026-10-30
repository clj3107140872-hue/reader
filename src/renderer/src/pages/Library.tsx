import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'
import BookCard from '../components/BookCard'
import Modal from '../components/Modal'

type SortMode = 'recent' | 'imported' | 'title'

type Dialog =
  | { kind: 'source'; entry: LibraryEntry }
  | { kind: 'delete'; entry: LibraryEntry }

const SORTERS: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
  recent: (a, b) => (b.lastReadAt ?? b.importedAt).localeCompare(a.lastReadAt ?? a.importedAt),
  imported: (a, b) => b.importedAt.localeCompare(a.importedAt),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
}

function formatTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString('zh-CN', { hour12: false })
}

function errorText(reason: unknown): string {
  const message = reason instanceof Error ? reason.message : String(reason)
  return message.replace(/^Error invoking remote method '[^']+': (?:Error: )?/, '')
}

function clampMenu(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 168)),
    y: Math.max(8, Math.min(y, window.innerHeight - 196))
  }
}

export default function Library({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ entry: LibraryEntry; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [actionBusy, setActionBusy] = useState(false)

  const notify = (text: string): void => setToast({ id: Date.now(), text })

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

  useEffect(() => {
    if (!menu) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [menu])

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
      notify(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
      await refresh()
    } catch (reason) {
      notify(`导入失败：${errorText(reason)}`)
    } finally {
      setBusy(false)
      setProgress('')
    }
  }

  const confirmDelete = async (entry: LibraryEntry): Promise<void> => {
    setActionBusy(true)
    try {
      await window.api.removeBook(entry.id)
      setDialog(null)
      notify(`已删除《${entry.title}》`)
      await refresh()
    } catch (reason) {
      notify(`删除失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
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
            <BookCard
              key={entry.id}
              entry={entry}
              onOpen={() => onOpen(entry.id)}
              onMenu={(target, x, y) => setMenu({ entry: target, ...clampMenu(x, y) })}
            />
          ))}
        </div>
      )}

      {menu && (
        <>
          <div className="card-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="card-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              onClick={() => {
                setDialog({ kind: 'source', entry: menu.entry })
                setMenu(null)
              }}
            >
              查看来源
            </button>
            <button
              className="danger"
              onClick={() => {
                setDialog({ kind: 'delete', entry: menu.entry })
                setMenu(null)
              }}
            >
              删除
            </button>
          </div>
        </>
      )}

      {dialog?.kind === 'source' && (
        <Modal title="来源信息" onClose={() => setDialog(null)}>
          <dl className="info-list">
            <dt>书名</dt>
            <dd>{dialog.entry.title}</dd>
            <dt>源文件</dt>
            <dd>{(dialog.entry.sourceFileNames ?? [dialog.entry.sourceFileName]).join('、')}</dd>
            <dt>编码</dt>
            <dd>{dialog.entry.encoding}</dd>
            <dt>导入时间</dt>
            <dd>{formatTime(dialog.entry.importedAt)}</dd>
            <dt>章节</dt>
            <dd>{dialog.entry.chapterCount} 章</dd>
            <dt>清洗</dt>
            <dd>
              广告 {dialog.entry.stats.adLinesRemoved} 行 · 合并重复段{' '}
              {dialog.entry.stats.duplicateParagraphsMerged} 处
            </dd>
          </dl>
        </Modal>
      )}

      {dialog?.kind === 'delete' && (
        <Modal
          title="删除书籍"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button danger"
                disabled={actionBusy}
                onClick={() => void confirmDelete(dialog.entry)}
              >
                {actionBusy ? '删除中…' : '删除'}
              </button>
            </>
          }
        >
          <p>确定删除《{dialog.entry.title}》吗？</p>
          <p className="modal-note">
            会移除书架记录和软件内的书籍数据；你导入的原始 TXT 文件不会被删除。
          </p>
        </Modal>
      )}
    </div>
  )
}
