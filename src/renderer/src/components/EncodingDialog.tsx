import { useEffect, useState } from 'react'
import type { LibraryEntry } from '../../../core/model'
import type { EncodingPreview, ReprocessResult } from '../../../shared/api'
import { ENCODING_OPTIONS, isSupportedEncoding } from '../../../shared/encodings'
import type { SupportedEncoding } from '../../../shared/encodings'
import { errorText } from '../errors'
import Modal from './Modal'

interface EncodingDialogProps {
  entry: LibraryEntry
  notify: (text: string) => void
  onClose: () => void
  onApplied: (result: ReprocessResult) => void
}

function encodingLabel(id: string): string {
  return ENCODING_OPTIONS.find((option) => option.id === id)?.label ?? id
}

export default function EncodingDialog({
  entry,
  notify,
  onClose,
  onApplied
}: EncodingDialogProps) {
  const initial: SupportedEncoding = isSupportedEncoding(entry.encoding) ? entry.encoding : 'utf8'
  const [encoding, setEncoding] = useState<SupportedEncoding>(initial)
  const [preview, setPreview] = useState<EncodingPreview | null>(null)
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [reloadKey, setReloadKey] = useState(0)
  const [attaching, setAttaching] = useState(false)
  const [applying, setApplying] = useState(false)
  const busy = loading || attaching || applying
  const missingOriginal = loadError.includes('缺少原始文件数据')

  useEffect(() => {
    let alive = true
    setLoading(true)
    setPreview(null)
    setLoadError('')
    window.api
      .previewEncoding(entry.id, encoding)
      .then((data) => {
        if (alive) setPreview(data)
      })
      .catch((reason) => {
        if (alive) setLoadError(errorText(reason))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [entry.id, encoding, reloadKey])

  const attachOriginal = async (): Promise<void> => {
    if (attaching) return
    setAttaching(true)
    try {
      const result = await window.api.attachOriginal(entry.id)
      if (!result) return
      notify(`已关联原始文件「${result.fileName}」`)
      setReloadKey((key) => key + 1)
    } catch (reason) {
      notify(`关联原始文件失败：${errorText(reason)}`)
    } finally {
      setAttaching(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (busy || !preview) return
    setApplying(true)
    try {
      const result = await window.api.applyEncoding(entry.id, encoding)
      onApplied(result)
    } catch (reason) {
      notify(`切换编码失败：${errorText(reason)}`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={`切换编码 · ${entry.title}`}
      wide
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button className="modal-button ghost" disabled={busy} onClick={onClose}>
            取消
          </button>
          <button className="modal-button" disabled={busy || !preview} onClick={() => void apply()}>
            {applying ? '解析中…' : '按此编码重新解析'}
          </button>
        </>
      }
    >
      <p className="modal-note">
        如果书里是乱码，多半是导入时判断错了编码。选择正确的编码，确认预览正常后再应用。
        应用后会重新清洗并切分章节，手动标记的章节会保留。
      </p>
      <div className="encoding-toolbar">
        <label htmlFor="encoding-select">读取原始文件时使用的编码</label>
        <select
          id="encoding-select"
          value={encoding}
          disabled={applying}
          onChange={(event) => setEncoding(event.target.value as SupportedEncoding)}
        >
          {ENCODING_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
        <span className="modal-note">当前记录：{encodingLabel(entry.encoding)}</span>
      </div>

      {loadError ? (
        <>
          <p className="modal-error">{loadError}</p>
          {missingOriginal && (
            <>
              <p className="modal-note">
                这本书是在旧版本导入的，没有保存原始字节。选择当初导入的 TXT 文件后即可切换编码。
              </p>
              <button
                className="modal-button ghost"
                disabled={attaching}
                onClick={() => void attachOriginal()}
              >
                {attaching ? '选择中…' : '选择原始 TXT 文件…'}
              </button>
            </>
          )}
        </>
      ) : loading ? (
        <p className="modal-note">正在读取预览…</p>
      ) : preview ? (
        <>
          <div className="marker-summary">
            <span>预览前 {preview.lines.length} 行 · 共 {preview.totalLines} 行</span>
          </div>
          {preview.warnings.length > 0 && (
            <p className="modal-note">提示：{preview.warnings.join('；')}</p>
          )}
          <pre className="encoding-preview">{preview.lines.join('\n')}</pre>
        </>
      ) : null}
    </Modal>
  )
}
