import { useEffect, useRef, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'
import type { ImportSummary, ImportSuspect } from '../../../shared/api'
import BookCard from '../components/BookCard'
import Modal from '../components/Modal'
import { useFileDrop } from '../hooks/useFileDrop'

type SortMode = 'recent' | 'imported' | 'title'

type Dialog =
  | { kind: 'source'; entry: LibraryEntry }
  | { kind: 'delete'; entry: LibraryEntry }
  | { kind: 'reclean'; entry: LibraryEntry }
  | { kind: 'resplit'; entry: LibraryEntry }

const SORTERS: Record<SortMode, (a: LibraryEntry, b: LibraryEntry) => number> = {
  recent: (a, b) => (b.lastReadAt ?? b.importedAt).localeCompare(a.lastReadAt ?? a.importedAt),
  imported: (a, b) => b.importedAt.localeCompare(a.importedAt),
  title: (a, b) => a.title.localeCompare(b.title, 'zh-Hans-CN')
}

const STAGE_LABELS: Record<string, string> = {
  reading: '读取中',
  parsing: '解析中',
  writing: '写入中',
  done: '完成'
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
  const [mergeQueue, setMergeQueue] = useState<ImportSuspect[]>([])
  const busyRef = useRef(false)

  const notify = (text: string): void => setToast({ id: Date.now(), text })

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName} · ${STAGE_LABELS[payload.stage] ?? payload.stage}`)
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

  const applySummary = async (summary: ImportSummary): Promise<void> => {
    if (summary.canceled) return
    const parts: string[] = []
    if (summary.imported > 0) parts.push(`成功导入 ${summary.imported} 本`)
    if (summary.duplicates.length > 0) parts.push(`已在书库：${summary.duplicates.join('、')}`)
    if (summary.errors.length > 0) parts.push(`失败：${summary.errors.join('；')}`)
    if (summary.warnings.length > 0) parts.push(`提示：${summary.warnings.join('；')}`)
    notify(parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件')
    if (summary.suspects.length > 0) setMergeQueue(summary.suspects)
    await refresh()
  }

  const runImport = async (task: () => Promise<ImportSummary>): Promise<void> => {
    if (busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setProgress('')
    try {
      await applySummary(await task())
    } catch (reason) {
      notify(`导入失败：${errorText(reason)}`)
    } finally {
      busyRef.current = false
      setBusy(false)
      setProgress('')
    }
  }

  const handleImport = (): Promise<void> => runImport(() => window.api.chooseAndImport())

  const pendingMerge = mergeQueue[0] ?? null

  const confirmMerge = async (): Promise<void> => {
    if (!pendingMerge) return
    setActionBusy(true)
    try {
      const result = await window.api.mergeBooks(pendingMerge.id, pendingMerge.sourceId)
      setMergeQueue((queue) => queue.filter((item) => item.sourceId !== pendingMerge.sourceId))
      notify(
        `已合并为《${result.title}》，共 ${result.chapterCount} 章${
          result.warning ? `；${result.warning}` : ''
        }`
      )
      await refresh()
    } catch (reason) {
      notify(`合并失败：${errorText(reason)}`)
    } finally {
      setActionBusy(false)
    }
  }

  const skipMerge = (): void => setMergeQueue((queue) => queue.slice(1))

  const importPaths = async (paths: string[]): Promise<void> => {
    if (busyRef.current) {
      notify('正在导入，请稍候')
      return
    }
    await runImport(() => window.api.importPaths(paths))
  }

  const dragging = useFileDrop((paths) => {
    if (dialog || pendingMerge) return
    void importPaths(paths)
  })

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

  const confirmReprocess = async (
    entry: LibraryEntry,
    kind: 'reclean' | 'resplit'
  ): Promise<void> => {
    setActionBusy(true)
    try {
      const result =
        kind === 'reclean'
          ? await window.api.recleanBook(entry.id)
          : await window.api.resplitBook(entry.id)
      setDialog(null)
      const label = kind === 'reclean' ? '重新清洗' : '重新切章'
      const detail =
        kind === 'reclean'
          ? `移除广告 ${result.stats.adLinesRemoved} 行，合并重复段 ${result.stats.duplicateParagraphsMerged} 处`
          : `共 ${result.chapterCount} 章`
      notify(
        `已${label}《${entry.title}》：${detail}${result.warning ? `；${result.warning}` : ''}`
      )
      await refresh()
    } catch (reason) {
      notify(`${kind === 'reclean' ? '重新清洗' : '重新切章'}失败：${errorText(reason)}`)
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
      {dragging && !dialog && !pendingMerge && (
        <div className="drop-overlay">松开鼠标，导入 TXT</div>
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
              onClick={() => {
                setDialog({ kind: 'reclean', entry: menu.entry })
                setMenu(null)
              }}
            >
              重新清洗
            </button>
            <button
              onClick={() => {
                setDialog({ kind: 'resplit', entry: menu.entry })
                setMenu(null)
              }}
            >
              重新切章
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

      {pendingMerge && (
        <Modal
          title="可能是同一本书"
          onClose={skipMerge}
          footer={
            <>
              <button className="modal-button ghost" onClick={skipMerge}>
                先不合并
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmMerge()}
              >
                {actionBusy ? '合并中…' : `合并到《${pendingMerge.title}》`}
              </button>
            </>
          }
        >
          <p>
            《{pendingMerge.sourceTitle}》与《{pendingMerge.title}》有{' '}
            {(pendingMerge.overlap * 100).toFixed(0)}% 的章节内容重叠，可能是一本书的不同分卷。
          </p>
          <p className="modal-note">合并后会保留阅读进度和书签，并自动备份原书数据。</p>
        </Modal>
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

      {dialog?.kind === 'reclean' && (
        <Modal
          title="重新清洗"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmReprocess(dialog.entry, 'reclean')}
              >
                {actionBusy ? '处理中…' : '重新清洗'}
              </button>
            </>
          }
        >
          <p>将按当前内置清洗规则重新处理《{dialog.entry.title}》。</p>
          <p className="modal-note">原数据会自动备份，阅读进度和书签保留。</p>
        </Modal>
      )}

      {dialog?.kind === 'resplit' && (
        <Modal
          title="重新切章"
          onClose={() => setDialog(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDialog(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmReprocess(dialog.entry, 'resplit')}
              >
                {actionBusy ? '处理中…' : '重新切章'}
              </button>
            </>
          }
        >
          <p>将重新识别源文件中的章节标题并切分《{dialog.entry.title}》。</p>
          <p className="modal-note">
            识别不到至少 3 个章节标题时会保持原样。原数据会自动备份，阅读进度和书签保留。
          </p>
        </Modal>
      )}
    </div>
  )
}
