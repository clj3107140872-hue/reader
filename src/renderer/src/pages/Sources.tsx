import { useEffect, useState } from 'react'
import type { ImportSourcesResult, SourceListItem } from '../../../core/booksource/model'
import Modal from '../components/Modal'
import SourceImportDialog from '../components/SourceImportDialog'
import SourceList from '../components/SourceList'
import { errorText } from '../errors'

export default function Sources({ onBack }: { onBack: () => void }) {
  const [sources, setSources] = useState<SourceListItem[]>([])
  const [importing, setImporting] = useState(false)
  const [raw, setRaw] = useState<{ source: SourceListItem; json: string } | null>(null)
  const [deleting, setDeleting] = useState<SourceListItem | null>(null)
  const [toast, setToast] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const refresh = async (): Promise<void> => {
    setSources(await window.api.sourceList())
    setError('')
  }

  useEffect(() => {
    void refresh()
      .catch((reason) => setError(errorText(reason)))
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const onImported = (result: ImportSourcesResult): void => {
    setToast(`新增 ${result.added} 个，更新 ${result.updated} 个`)
    void refresh().catch((reason) => setToast(`刷新列表失败：${errorText(reason)}`))
  }

  const onFlags = async (
    source: SourceListItem,
    flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }
  ): Promise<void> => {
    try {
      setSources(await window.api.setSourceFlags(source.id, flags))
    } catch (reason) {
      setToast(`保存失败：${errorText(reason)}`)
    }
  }

  const onRaw = async (source: SourceListItem): Promise<void> => {
    try {
      const definition = await window.api.sourceRaw(source.id)
      if (!definition) {
        setToast('读取失败：找不到这个书源')
        return
      }
      setRaw({ source, json: JSON.stringify(definition, null, 2) })
    } catch (reason) {
      setToast(`读取失败：${errorText(reason)}`)
    }
  }

  const onDelete = async (): Promise<void> => {
    if (!deleting) return
    try {
      await window.api.deleteSource(deleting.id)
      setDeleting(null)
      setToast('书源已删除；已加入书架的书仍可读已缓存章节')
    } catch (reason) {
      setToast(`删除失败：${errorText(reason)}`)
      return
    }
    try {
      await refresh()
    } catch (reason) {
      setToast(`刷新列表失败：${errorText(reason)}`)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="ghost" onClick={onBack}>← 书架</button>
        <h1>书源</h1>
        <div className="toolbar-actions">
          <button onClick={() => setImporting(true)}>导入书源</button>
        </div>
      </header>
      {error && <p className="modal-error">{error}</p>}
      {loading ? (
        <p className="empty">加载中…</p>
      ) : (
        <SourceList sources={sources} onFlags={(source, flags) => void onFlags(source, flags)} onRaw={(source) => void onRaw(source)} onDelete={setDeleting} />
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
      {importing && (
        <SourceImportDialog onClose={() => setImporting(false)} onImported={onImported} />
      )}
      {raw && (
        <Modal title={`书源 JSON：${raw.source.name}`} onClose={() => setRaw(null)}>
          <pre className="source-json-view">{raw.json}</pre>
        </Modal>
      )}
      {deleting && (
        <Modal
          title="删除书源"
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button className="modal-button ghost" onClick={() => setDeleting(null)}>取消</button>
              <button className="modal-button danger" onClick={() => void onDelete()}>删除</button>
            </>
          }
        >
          <p>删除「{deleting.name}」后，已加入书架的书不会删除，但未缓存章节将无法继续下载。</p>
        </Modal>
      )}
    </div>
  )
}
