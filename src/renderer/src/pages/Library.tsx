import { useEffect, useRef, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'
import type {
  BackupInfo,
  FindMergesResult,
  ImportSummary,
  ImportSuspect,
  MergeCandidate,
  ReprocessResult
} from '../../../shared/api'
import BookCard from '../components/BookCard'
import BookInfo from '../components/BookInfo'
import CleaningDialog from '../components/CleaningDialog'
import HoverCard from '../components/HoverCard'
import Modal from '../components/Modal'
import { errorText } from '../errors'
import { useFileDrop } from '../hooks/useFileDrop'

type SortMode = 'recent' | 'imported' | 'title'

interface MergeTally {
  merged: number
  skipped: number
  failed: number
  warnings: string[]
}

type BatchKind = 'delete' | 'reclean' | 'resplit'

const BATCH_LABELS: Record<BatchKind, string> = {
  delete: '删除',
  reclean: '重新清洗',
  resplit: '重新切章'
}

function limitedJoin(items: string[], limit = 3): string {
  if (items.length <= limit) return items.join('；')
  return `${items.slice(0, limit).join('；')}；另 ${items.length - limit} 项`
}

function filesText(files: string[]): string {
  return files.length > 0 ? files.join('、') : '未知文件'
}

function backupReasonLabel(backup: BackupInfo): string {
  if (backup.reason === 'merge') return '合并前'
  if (backup.reason === 'reclean') return '重新清洗前'
  if (backup.reason === 'resplit') return '重新切章前'
  return '自动备份'
}

function backupTime(iso: string): string {
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString('zh-CN', { hour12: false })
}

type Dialog =
  | { kind: 'source'; entry: LibraryEntry }
  | { kind: 'delete'; entry: LibraryEntry }
  | { kind: 'reclean'; entry: LibraryEntry }
  | { kind: 'resplit'; entry: LibraryEntry }
  | { kind: 'cleaning'; bookId: string | null; tab: 'report' | 'rules' }

interface ToastAction {
  label: string
  run: () => void
}

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

function clampMenu(x: number, y: number): { x: number; y: number } {
  return {
    x: Math.max(8, Math.min(x, window.innerWidth - 168)),
    y: Math.max(8, Math.min(y, window.innerHeight - 232))
  }
}

export default function Library({ onOpen }: { onOpen: (bookId: string) => void }) {
  const [entries, setEntries] = useState<LibraryEntry[]>([])
  const [toast, setToast] = useState<{ id: number; text: string; action?: ToastAction } | null>(null)
  const [busy, setBusy] = useState(false)
  const [progress, setProgress] = useState('')
  const [sort, setSort] = useState<SortMode>('recent')
  const [menu, setMenu] = useState<{ entry: LibraryEntry; x: number; y: number } | null>(null)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const [actionBusy, setActionBusy] = useState(false)
  const [mergeQueue, setMergeQueue] = useState<ImportSuspect[]>([])
  const [hovered, setHovered] = useState<{ entry: LibraryEntry; rect: DOMRect } | null>(null)
  const [selectionMode, setSelectionMode] = useState(false)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [batchConfirm, setBatchConfirm] = useState<BatchKind | null>(null)
  const [batch, setBatch] = useState<{ kind: BatchKind; total: number; done: number } | null>(null)
  const [mergeCandidates, setMergeCandidates] = useState<MergeCandidate[]>([])
  const [mergeTally, setMergeTally] = useState<MergeTally>({
    merged: 0,
    skipped: 0,
    failed: 0,
    warnings: []
  })
  const [findingMerges, setFindingMerges] = useState(false)
  const [mergeTotal, setMergeTotal] = useState(0)
  const [backups, setBackups] = useState<BackupInfo[]>([])
  const [backupConfirm, setBackupConfirm] = useState<string | null>(null)
  const [backupBusy, setBackupBusy] = useState(false)
  const hoverTimer = useRef<number | null>(null)
  const busyRef = useRef(false)

  const notify = (text: string, action?: ToastAction): void =>
    setToast({ id: Date.now(), text, action })

  const clearHoverTimer = (): void => {
    if (hoverTimer.current !== null) {
      window.clearTimeout(hoverTimer.current)
      hoverTimer.current = null
    }
  }

  const startHover = (entry: LibraryEntry, rect: DOMRect): void => {
    clearHoverTimer()
    hoverTimer.current = window.setTimeout(() => {
      hoverTimer.current = null
      setHovered({ entry, rect })
    }, 350)
  }

  const endHover = (): void => {
    clearHoverTimer()
    setHovered(null)
  }

  const enterSelection = (): void => {
    endHover()
    setMenu(null)
    setSelectionMode(true)
    setSelected(new Set())
  }

  const exitSelection = (): void => {
    setSelectionMode(false)
    setSelected(new Set())
    setMergeCandidates([])
    setMergeTotal(0)
    setMergeTally({ merged: 0, skipped: 0, failed: 0, warnings: [] })
  }

  const toggleSelected = (id: string): void => {
    if (actionBusy) return
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const allSelected = entries.length > 0 && entries.every((entry) => selected.has(entry.id))

  const toggleSelectAll = (): void => {
    setSelected(allSelected ? new Set() : new Set(entries.map((entry) => entry.id)))
  }

  const selectedEntries = entries.filter((entry) => selected.has(entry.id))

  const runBatch = async (kind: BatchKind): Promise<void> => {
    const targets = selectedEntries
    if (targets.length === 0) return
    if (busyRef.current) {
      notify('正在导入，请稍候')
      return
    }
    if (actionBusy) return
    setBatchConfirm(null)
    setActionBusy(true)
    let done = 0
    const failures: string[] = []
    const kept: string[] = []

    for (let index = 0; index < targets.length; index++) {
      const entry = targets[index]
      setBatch({ kind, total: targets.length, done: index + 1 })
      try {
        if (kind === 'delete') {
          await window.api.removeBook(entry.id)
        } else {
          const result =
            kind === 'reclean'
              ? await window.api.recleanBook(entry.id)
              : await window.api.resplitBook(entry.id)
          if (result.warning) kept.push(entry.title)
        }
        done += 1
      } catch (reason) {
        failures.push(`《${entry.title}》：${errorText(reason)}`)
      }
    }

    setBatch(null)
    setActionBusy(false)
    const keptText =
      kept.length > 0
        ? `；保持原样 ${kept.length} 本：${limitedJoin(kept.map((title) => `《${title}》`))}`
        : ''
    const failureText =
      failures.length > 0
        ? `；失败 ${failures.length} 本：${limitedJoin(failures)}`
        : ''
    const summary =
      failures.length > 0
        ? `${BATCH_LABELS[kind]}完成 ${done} 本${keptText}${failureText}`
        : `${BATCH_LABELS[kind]}完成，共 ${done} 本${keptText}`
    notify(summary)
    if (kind === 'delete') exitSelection()
    try {
      await refresh()
    } catch (reason) {
      notify(`${summary}；书架刷新失败：${errorText(reason)}`)
    }
  }

  const finishMerge = (remaining: MergeCandidate[], tally: MergeTally): void => {
    setMergeCandidates(remaining)
    if (remaining.length > 0) return
    setMergeTotal(0)
    const warnings = tally.warnings.length > 0 ? `；${limitedJoin(tally.warnings)}` : ''
    const summary = `判断合并完成：合并 ${tally.merged} 对、跳过 ${tally.skipped} 对、失败 ${tally.failed} 对${warnings}`
    notify(summary)
    setMergeTally({ merged: 0, skipped: 0, failed: 0, warnings: [] })
    void refresh().catch((reason) =>
      notify(`${summary}；书架刷新失败：${errorText(reason)}`)
    )
  }

  const findMerges = async (): Promise<void> => {
    if (selected.size < 2) {
      notify('请至少勾选 2 本书')
      return
    }
    if (busyRef.current) {
      notify('正在导入，请稍候')
      return
    }
    setActionBusy(true)
    setFindingMerges(true)
    try {
      const result: FindMergesResult = await window.api.findMerges([...selected])
      if (result.candidates.length === 0) {
        notify(
          result.warnings.length > 0
            ? `${limitedJoin(result.warnings)}；没有发现可能是同一本书的候选`
            : '没有发现可能是同一本书的候选'
        )
        return
      }
      if (result.warnings.length > 0) notify(limitedJoin(result.warnings))
      setMergeTally({ merged: 0, skipped: 0, failed: 0, warnings: [] })
      setMergeTotal(result.candidates.length)
      setMergeCandidates(result.candidates)
    } catch (reason) {
      notify(`判断合并失败：${errorText(reason)}`)
    } finally {
      setFindingMerges(false)
      setActionBusy(false)
    }
  }

  const skipCandidate = (): void => {
    if (actionBusy) return
    if (mergeCandidates.length === 0) return
    const tally = { ...mergeTally, skipped: mergeTally.skipped + 1 }
    setMergeTally(tally)
    finishMerge(mergeCandidates.slice(1), tally)
  }

  const confirmCandidate = async (): Promise<void> => {
    const candidate = mergeCandidates[0]
    if (!candidate) return
    setActionBusy(true)
    try {
      const existing = new Set((await window.api.libraryList()).map((entry) => entry.id))
      if (!existing.has(candidate.targetId) || !existing.has(candidate.sourceId)) {
        notify(`《${candidate.targetTitle}》或《${candidate.sourceTitle}》已不在书架，已跳过这一对`)
        const tally = { ...mergeTally, skipped: mergeTally.skipped + 1 }
        setMergeTally(tally)
        finishMerge(mergeCandidates.slice(1), tally)
        return
      }

      const result = await window.api.mergeBooks(candidate.targetId, candidate.sourceId)
      setSelected((current) => {
        const next = new Set(current)
        next.delete(candidate.sourceId)
        return next
      })
      const warnings = result.warning
        ? [...mergeTally.warnings, result.warning]
        : mergeTally.warnings
      const tally = { ...mergeTally, merged: mergeTally.merged + 1, warnings }
      setMergeTally(tally)
      finishMerge(mergeCandidates.slice(1), tally)
    } catch (reason) {
      notify(`合并失败：${errorText(reason)}`)
      const tally = { ...mergeTally, failed: mergeTally.failed + 1 }
      setMergeTally(tally)
      finishMerge(mergeCandidates.slice(1), tally)
    } finally {
      setActionBusy(false)
    }
  }

  const refresh = async (): Promise<void> => {
    setEntries(await window.api.libraryList())
  }

  useEffect(() => {
    void refresh()
    void window.api
      .getStartupNotice()
      .then((notice) => {
        if (notice.libraryRestored) notify('书库索引损坏，已从备份恢复')
      })
      .catch(() => {})
    return window.api.onImportProgress((payload) => {
      setProgress(`正在处理：${payload.fileName} · ${STAGE_LABELS[payload.stage] ?? payload.stage}`)
    })
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), toast.action ? 8000 : 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  useEffect(() => {
    return () => {
      if (hoverTimer.current !== null) window.clearTimeout(hoverTimer.current)
    }
  }, [])

  useEffect(() => {
    const hide = (): void => {
      if (hoverTimer.current !== null) {
        window.clearTimeout(hoverTimer.current)
        hoverTimer.current = null
      }
      setHovered(null)
    }
    window.addEventListener('scroll', hide, true)
    window.addEventListener('resize', hide)
    return () => {
      window.removeEventListener('scroll', hide, true)
      window.removeEventListener('resize', hide)
    }
  }, [])

  useEffect(() => {
    if (!menu) return
    const handleKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setMenu(null)
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [menu])

  useEffect(() => {
    if (!selectionMode) return
    const handleKey = (event: KeyboardEvent): void => {
      if (actionBusy) return
      if (event.key !== 'Escape') return
      if (dialog || mergeQueue.length > 0 || batchConfirm || mergeCandidates.length > 0) return
      exitSelection()
    }
    window.addEventListener('keydown', handleKey)
    return () => window.removeEventListener('keydown', handleKey)
  }, [selectionMode, actionBusy, dialog, batchConfirm, mergeQueue.length, mergeCandidates.length])

  const applySummary = async (summary: ImportSummary): Promise<void> => {
    if (summary.canceled) return
    const parts: string[] = []
    if (summary.imported > 0) parts.push(`成功导入 ${summary.imported} 本`)
    if (summary.duplicates.length > 0) parts.push(`已在书库：${limitedJoin(summary.duplicates)}`)
    if (summary.errors.length > 0) parts.push(`失败：${limitedJoin(summary.errors)}`)
    if (summary.warnings.length > 0) parts.push(`提示：${limitedJoin(summary.warnings)}`)
    const latest = summary.importedBooks[summary.importedBooks.length - 1]
    notify(
      parts.length > 0 ? parts.join(' ｜ ') : '没有导入任何文件',
      latest
        ? {
            label: '查看清洗报告',
            run: () => setDialog({ kind: 'cleaning', bookId: latest.id, tab: 'report' })
          }
        : undefined
    )
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

  const skipMerge = (): void => {
    if (actionBusy) return
    setMergeQueue((queue) => queue.slice(1))
  }

  const stopMerge = (): void => {
    if (actionBusy) return
    finishMerge([], mergeTally)
  }

  const importPaths = async (paths: string[]): Promise<void> => {
    if (busyRef.current) {
      notify('正在导入，请稍候')
      return
    }
    await runImport(() => window.api.importPaths(paths))
  }

  const dragging = useFileDrop((paths) => {
    if (selectionMode) {
      notify('选择模式下不能导入，请先退出选择')
      return
    }
    if (dialog || pendingMerge || batchConfirm || mergeCandidates.length > 0 || actionBusy) return
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

  const openSource = async (entry: LibraryEntry): Promise<void> => {
    setDialog({ kind: 'source', entry })
    setBackups([])
    setBackupConfirm(null)
    try {
      setBackups(await window.api.listBackups(entry.id))
    } catch (reason) {
      setBackups([])
      notify(`读取备份失败：${errorText(reason)}`)
    }
  }

  const closeSource = (): void => {
    if (backupBusy) return
    setBackupConfirm(null)
    setDialog(null)
  }

  const confirmRestore = async (entry: LibraryEntry, name: string): Promise<void> => {
    if (backupBusy) return
    setBackupBusy(true)
    try {
      const result = await window.api.restoreBackup(entry.id, name)
      setBackupConfirm(null)
      setDialog(null)
      await refresh().catch(() => {})
      notify(result.restoredSource ? '已恢复备份，被合并的源书也已恢复' : '已恢复到所选备份')
    } catch (reason) {
      notify(`恢复失败：${errorText(reason)}`)
    } finally {
      setBackupBusy(false)
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

  const handleCleaningApplied = (result: ReprocessResult): void => {
    setDialog(null)
    const title = entries.find((entry) => entry.id === result.id)?.title ?? '这本书'
    notify(
      `已清洗《${title}》：移除广告 ${result.stats.adLinesRemoved} 行，合并重复段 ${result.stats.duplicateParagraphsMerged} 处`
    )
    void refresh().catch((reason) => notify(`书架刷新失败：${errorText(reason)}`))
  }

  const sorted = [...entries].sort(SORTERS[sort])
  const mergePosition = mergeTotal > 0 ? mergeTotal - mergeCandidates.length + 1 : 0
  const confirmBackup = backupConfirm
    ? backups.find((backup) => backup.name === backupConfirm)
    : null

  return (
    <div className="app">
      <header className="toolbar">
        <h1>{selectionMode ? `已选 ${selected.size} 本` : '我的书架'}</h1>
        <div className="toolbar-actions">
          {selectionMode ? (
            <>
              <button className="ghost" onClick={toggleSelectAll} disabled={actionBusy}>
                {allSelected ? '取消全选' : '全选'}
              </button>
              <button className="ghost" onClick={exitSelection} disabled={actionBusy}>
                退出选择
              </button>
            </>
          ) : (
            <>
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
              <button
                className="ghost"
                disabled={busy}
                onClick={() => setDialog({ kind: 'cleaning', bookId: null, tab: 'rules' })}
              >
                清洗规则
              </button>
              <button onClick={() => void handleImport()} disabled={busy}>
                {busy ? '导入中…' : '导入 TXT'}
              </button>
              {entries.length > 0 && (
                <button className="ghost" onClick={enterSelection}>
                  选择
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {selectionMode && (
        <div className="batch-bar">
          <button disabled={selected.size === 0 || actionBusy || busy} onClick={() => void findMerges()}>
            {findingMerges ? '判断中…' : '判断合并'}
          </button>
          <button
            disabled={selected.size === 0 || actionBusy || busy}
            onClick={() => setBatchConfirm('reclean')}
          >
            重新清洗
          </button>
          <button
            disabled={selected.size === 0 || actionBusy || busy}
            onClick={() => setBatchConfirm('resplit')}
          >
            重新切章
          </button>
          <button
            className="danger"
            disabled={selected.size === 0 || actionBusy || busy}
            onClick={() => setBatchConfirm('delete')}
          >
            删除
          </button>
        </div>
      )}

      {progress && <p className="hint">{progress}</p>}
      {batch && (
        <p className="hint">
          {BATCH_LABELS[batch.kind]} 第 {batch.done}/{batch.total} 本
        </p>
      )}
      {toast && (
        <div className="toast" role="status">
          <span>{toast.text}</span>
          {toast.action && (
            <button
              className="toast-action"
              onClick={() => {
                const action = toast.action
                setToast(null)
                action?.run()
              }}
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
      {dragging && !dialog && !pendingMerge && !selectionMode && (
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
              onHoverStart={startHover}
              onHoverEnd={endHover}
              selectable={selectionMode}
              selected={selected.has(entry.id)}
              onToggle={() => toggleSelected(entry.id)}
              onOpen={() => {
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                if (actionBusy) return
                endHover()
                onOpen(entry.id)
              }}
              onMenu={(target, x, y) => {
                if (selectionMode) return
                if (busyRef.current) {
                  notify('正在导入，请稍候')
                  return
                }
                if (actionBusy) return
                endHover()
                setMenu({ entry: target, ...clampMenu(x, y) })
              }}
            />
          ))}
        </div>
      )}

      {hovered && (
        <HoverCard anchor={hovered.rect}>
          <BookInfo entry={hovered.entry} compact />
        </HoverCard>
      )}

      {menu && (
        <>
          <div className="card-menu-backdrop" onClick={() => setMenu(null)} />
          <div className="card-menu" style={{ left: menu.x, top: menu.y }} role="menu">
            <button
              onClick={() => {
                void openSource(menu.entry)
                setMenu(null)
              }}
            >
              查看来源
            </button>
            <button
              onClick={() => {
                setDialog({ kind: 'cleaning', bookId: menu.entry.id, tab: 'report' })
                setMenu(null)
              }}
            >
              清洗报告…
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
              <button className="modal-button ghost" disabled={actionBusy} onClick={skipMerge}>
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
          <dl className="info-list">
            <dt>源书</dt>
            <dd>
              {filesText(pendingMerge.sourceFiles)}（{pendingMerge.sourceChapterCount} 章）
            </dd>
            <dt>目标书</dt>
            <dd>
              {filesText(pendingMerge.targetFiles)}（{pendingMerge.targetChapterCount} 章）
            </dd>
          </dl>
          <p className="modal-note">合并后会保留阅读进度和书签，并自动备份原书数据。</p>
        </Modal>
      )}

      {mergeCandidates[0] && (
        <Modal
          title={mergeTotal > 0 ? `判断合并（第 ${mergePosition}/${mergeTotal} 对）` : '判断合并'}
          onClose={skipCandidate}
          footer={
            <>
              <button className="modal-button ghost" disabled={actionBusy} onClick={stopMerge}>
                停止判断
              </button>
              <button className="modal-button ghost" disabled={actionBusy} onClick={skipCandidate}>
                跳过
              </button>
              <button
                className="modal-button"
                disabled={actionBusy}
                onClick={() => void confirmCandidate()}
              >
                {actionBusy ? '合并中…' : `合并到《${mergeCandidates[0].targetTitle}》`}
              </button>
            </>
          }
        >
          <p>
            《{mergeCandidates[0].targetTitle}》 ⇄ 《{mergeCandidates[0].sourceTitle}》 · 章节重叠{' '}
            {(mergeCandidates[0].overlap * 100).toFixed(0)}%
          </p>
          <dl className="info-list">
            <dt>源书</dt>
            <dd>
              {filesText(mergeCandidates[0].sourceFiles)}（{mergeCandidates[0].sourceChapterCount}{' '}
              章）
            </dd>
            <dt>目标书</dt>
            <dd>
              {filesText(mergeCandidates[0].targetFiles)}（{mergeCandidates[0].targetChapterCount}{' '}
              章）
            </dd>
          </dl>
          <p>
            将《{mergeCandidates[0].sourceTitle}》合并到《{mergeCandidates[0].targetTitle}》。
          </p>
          <p className="modal-note">合并后会保留阅读进度和书签，并自动备份原书数据。</p>
        </Modal>
      )}

      {dialog?.kind === 'cleaning' && (
        <CleaningDialog
          key={dialog.bookId ?? 'rules'}
          bookId={dialog.bookId}
          initialTab={dialog.tab}
          notify={notify}
          onClose={() => setDialog(null)}
          onApplied={handleCleaningApplied}
        />
      )}

      {dialog?.kind === 'source' && (
        <Modal
          title="来源信息"
          onClose={closeSource}
          footer={
            <button className="modal-button" disabled={backupBusy} onClick={closeSource}>
              关闭
            </button>
          }
        >
          <BookInfo entry={dialog.entry} />
          <h3 className="backup-heading">可恢复的备份</h3>
          {backups.length === 0 ? (
            <p className="modal-note">没有可恢复的备份。合并、重新清洗或重新切章后会自动留一份。</p>
          ) : (
            <ul className="backup-list">
              {backups.map((backup) => (
                <li key={backup.name}>
                  <div>
                    <strong>
                      {backupReasonLabel(backup)}
                      {backup.sourceTitle ? ` · 含《${backup.sourceTitle}》` : ''}
                    </strong>
                    <span>
                      {backupTime(backup.createdAt)} · {backup.chapterCount} 章
                    </span>
                  </div>
                  <button
                    className="modal-button ghost"
                    disabled={backupBusy}
                    onClick={() => setBackupConfirm(backup.name)}
                  >
                    恢复
                  </button>
                </li>
              ))}
            </ul>
          )}
          {confirmBackup && (
            <div className="backup-confirm">
              <p>
                恢复到 {backupTime(confirmBackup.createdAt)} 的备份？当前章节、进度和书签会被覆盖；
                当前状态也会自动留一份备份。
              </p>
              <div className="backup-confirm-actions">
                <button
                  className="modal-button ghost"
                  disabled={backupBusy}
                  onClick={() => setBackupConfirm(null)}
                >
                  取消
                </button>
                <button
                  className="modal-button danger"
                  disabled={backupBusy}
                  onClick={() => void confirmRestore(dialog.entry, confirmBackup.name)}
                >
                  {backupBusy ? '恢复中…' : '确认恢复'}
                </button>
              </div>
            </div>
          )}
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

      {batchConfirm === 'delete' && (
        <Modal
          title="批量删除"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button danger"
                disabled={actionBusy || busy}
                onClick={() => void runBatch('delete')}
              >
                删除
              </button>
            </>
          }
        >
          <p>
            将删除 {selectedEntries.length} 本书：
            {selectedEntries
              .slice(0, 3)
              .map((entry) => `《${entry.title}》`)
              .join('、')}
            {selectedEntries.length > 3 ? ' 等' : ''}。
          </p>
          <p className="modal-note">
            会移除书架记录、软件内的书籍数据和备份；你导入的原始 TXT 文件不会被删除。
          </p>
        </Modal>
      )}

      {batchConfirm === 'reclean' && (
        <Modal
          title="批量重新清洗"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy || busy}
                onClick={() => void runBatch('reclean')}
              >
                重新清洗
              </button>
            </>
          }
        >
          <p>将按当前内置清洗规则重新处理选中的 {selectedEntries.length} 本书。</p>
          <p className="modal-note">原数据会自动备份，阅读进度和书签保留。</p>
        </Modal>
      )}

      {batchConfirm === 'resplit' && (
        <Modal
          title="批量重新切章"
          onClose={() => setBatchConfirm(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setBatchConfirm(null)}>
                取消
              </button>
              <button
                className="modal-button"
                disabled={actionBusy || busy}
                onClick={() => void runBatch('resplit')}
              >
                重新切章
              </button>
            </>
          }
        >
          <p>将重新识别源文件中的章节标题并切分选中的 {selectedEntries.length} 本书。</p>
          <p className="modal-note">
            识别不到至少 3 个章节标题的书会保持原样。原数据会自动备份，阅读进度和书签保留。
          </p>
        </Modal>
      )}
    </div>
  )
}
