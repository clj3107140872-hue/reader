import { useState } from 'react'
import type { ImportSourcesResult } from '../../../core/booksource/model'
import Modal from './Modal'
import { errorText } from '../errors'

type Tab = 'json' | 'file' | 'url'

export default function SourceImportDialog({
  onClose,
  onImported
}: {
  onClose: () => void
  onImported: (result: ImportSourcesResult) => void
}) {
  const [tab, setTab] = useState<Tab>('json')
  const [json, setJson] = useState('')
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [result, setResult] = useState<ImportSourcesResult | null>(null)

  const run = async (request: Parameters<typeof window.api.importSources>[0]): Promise<void> => {
    setBusy(true)
    setError('')
    setResult(null)
    try {
      const next = await window.api.importSources(request)
      setResult(next)
      onImported(next)
    } catch (reason) {
      setError(errorText(reason))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Modal
      title="导入书源"
      onClose={onClose}
      footer={
        <>
          <button className="modal-button ghost" onClick={onClose}>关闭</button>
          <button
            className="modal-button"
            disabled={busy || (tab === 'json' && !json.trim()) || (tab === 'url' && !url.trim())}
            onClick={() => {
              if (tab === 'file') void run({ kind: 'file' })
              else if (tab === 'json') void run({ kind: 'json', json })
              else void run({ kind: 'url', url: url.trim() })
            }}
          >
            {busy ? '导入中…' : '导入'}
          </button>
        </>
      }
    >
      <div className="tabs" role="tablist">
        {([
          ['json', '粘贴 JSON'],
          ['file', '选择文件'],
          ['url', '从链接导入']
        ] as const).map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={tab === id}
            className={tab === id ? 'active' : ''}
            onClick={() => setTab(id)}
          >
            {label}
          </button>
        ))}
      </div>
      {tab === 'json' && (
        <textarea
          className="source-json"
          value={json}
          onChange={(event) => setJson(event.target.value)}
          placeholder='粘贴「阅读」书源 JSON，支持单个对象或数组。'
          spellCheck={false}
        />
      )}
      {tab === 'file' && (
        <p className="hint">选择一个「阅读」书源 JSON 文件（只支持文字书源）。</p>
      )}
      {tab === 'url' && (
        <input
          className="source-url"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          placeholder="https://example.com/sources.json"
        />
      )}
      <p className="hint">
        只支持文字书源；使用 JS、XPath、WebView 或登录规则的书源会标记为「部分兼容」。不内置、不推荐任何书源。
      </p>
      {error && <p className="modal-error">{error}</p>}
      {result && (
        <div className="import-result">
          <p>新增 {result.added} 个，更新 {result.updated} 个。</p>
          {result.rejected.length > 0 && (
            <details>
              <summary>{result.rejected.length} 个未导入</summary>
              <ul>
                {result.rejected.map((item, index) => (
                  <li key={index}>{item.name ?? item.url ?? '未命名'}：{item.reason}</li>
                ))}
              </ul>
            </details>
          )}
          {result.warnings.length > 0 && (
            <ul className="warn">{result.warnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul>
          )}
        </div>
      )}
    </Modal>
  )
}
