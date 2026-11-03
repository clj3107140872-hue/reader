import { useEffect, useMemo, useState } from 'react'
import type { ChapterLinesPayload, ReprocessResult } from '../../../shared/api'
import { errorText } from '../errors'
import Modal from './Modal'

interface ChapterMarkerDialogProps {
  bookId: string
  title: string
  notify: (text: string) => void
  onClose: () => void
  onApplied: (result: ReprocessResult) => void
}

const ROW_HEIGHT = 28
const LIST_HEIGHT = 420
const OVERSCAN = 8

export default function ChapterMarkerDialog({
  bookId,
  title,
  notify,
  onClose,
  onApplied
}: ChapterMarkerDialogProps) {
  const [payload, setPayload] = useState<ChapterLinesPayload | null>(null)
  const [starts, setStarts] = useState<Set<number>>(new Set())
  const [pattern, setPattern] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const [loadError, setLoadError] = useState('')
  const [applying, setApplying] = useState(false)

  useEffect(() => {
    let alive = true
    window.api
      .chapterLines(bookId)
      .then((data) => {
        if (!alive) return
        setPayload(data)
        setStarts(new Set(data.starts))
      })
      .catch((reason) => {
        if (alive) setLoadError(errorText(reason))
      })
    return () => {
      alive = false
    }
  }, [bookId])

  const lines = payload?.lines ?? []
  const total = lines.length
  const first = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN)
  const visibleCount = Math.ceil(LIST_HEIGHT / ROW_HEIGHT) + OVERSCAN * 2
  const last = Math.min(total, first + visibleCount)

  const rows = useMemo(() => {
    return lines.slice(first, last).map((line, offset) => {
      const index = first + offset
      return { index, line, blank: line.trim() === '' }
    })
  }, [lines, first, last])

  const toggleLine = (index: number): void => {
    if (!lines[index]?.trim()) return
    setStarts((current) => {
      const next = new Set(current)
      if (next.has(index)) next.delete(index)
      else next.add(index)
      return next
    })
  }

  const markMatches = (): void => {
    if (pattern.trim() === '') {
      notify('请输入要匹配的正则')
      return
    }
    let regex: RegExp
    try {
      regex = new RegExp(pattern)
    } catch {
      notify('正则无效，请检查匹配内容')
      return
    }
    const matches: number[] = []
    lines.forEach((line, index) => {
      if (line.trim() !== '' && regex.test(line)) matches.push(index)
    })
    setStarts((current) => {
      const next = new Set(current)
      matches.forEach((index) => next.add(index))
      return next
    })
    notify(matches.length > 0 ? `已标记 ${matches.length} 行` : '没有匹配的行')
  }

  const apply = async (): Promise<void> => {
    if (applying) return
    if (starts.size === 0) {
      notify('请至少标记一个章节标题')
      return
    }
    setApplying(true)
    try {
      const result = await window.api.applyChapterStarts(
        bookId,
        [...starts].sort((a, b) => a - b)
      )
      onApplied(result)
    } catch (reason) {
      notify(`应用章节标记失败：${errorText(reason)}`)
    } finally {
      setApplying(false)
    }
  }

  return (
    <Modal
      title={`标记章节标题 · ${title}`}
      wide
      onClose={applying ? () => {} : onClose}
      footer={
        <>
          <button className="modal-button ghost" disabled={applying} onClick={onClose}>
            取消
          </button>
          <button
            className="modal-button"
            disabled={applying || !payload || starts.size === 0}
            onClick={() => void apply()}
          >
            {applying ? '切分中…' : `按标记切分（${starts.size} 章）`}
          </button>
        </>
      }
    >
      {loadError ? (
        <p className="modal-error">{loadError}</p>
      ) : !payload ? (
        <p className="modal-note">正在读取源文件…</p>
      ) : (
        <>
          <p className="modal-note">
            勾选章节标题所在的那一行。第一处标记之前的内容会成为「前言」；应用后标记会保留，
            以后重新清洗仍按这些标记切分。
          </p>
          <div className="marker-toolbar">
            <input
              type="text"
              value={pattern}
              placeholder="输入正则批量标记，如 ^第.+章"
              onChange={(event) => setPattern(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') markMatches()
              }}
            />
            <button className="modal-button ghost" onClick={markMatches}>
              批量标记
            </button>
            <button
              className="modal-button ghost"
              disabled={starts.size === 0}
              onClick={() => setStarts(new Set())}
            >
              清除标记
            </button>
          </div>
          <div className="marker-summary">
            <span>共 {total} 行</span>
            <span>已标记 {starts.size} 行</span>
          </div>
          <div
            className="marker-list"
            style={{ height: LIST_HEIGHT }}
            onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
          >
            <div style={{ height: first * ROW_HEIGHT }} />
            {rows.map((row) => (
              <label
                key={row.index}
                className={`marker-row${starts.has(row.index) ? ' on' : ''}${
                  row.blank ? ' blank' : ''
                }`}
                style={{ height: ROW_HEIGHT }}
              >
                <input
                  type="checkbox"
                  checked={starts.has(row.index)}
                  disabled={row.blank}
                  onChange={() => toggleLine(row.index)}
                />
                <span className="marker-no">{row.index + 1}</span>
                <span className="marker-text">{row.blank ? '（空行）' : row.line}</span>
              </label>
            ))}
            <div style={{ height: Math.max(0, total - last) * ROW_HEIGHT }} />
          </div>
        </>
      )}
    </Modal>
  )
}
