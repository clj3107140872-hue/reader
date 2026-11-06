import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import type { ChapterMeta } from '../../../core/model'
import type { SearchHit, SearchProgress } from '../../../shared/api'

interface SearchPanelProps {
  bookId: string
  chapters: ChapterMeta[]
  cachedOnly?: boolean
  onJump: (chapterIndex: number, paragraphIndex: number) => void
  onClose: () => void
}

export default function SearchPanel({
  bookId,
  chapters,
  cachedOnly = false,
  onJump,
  onClose
}: SearchPanelProps) {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SearchHit[]>([])
  const [progress, setProgress] = useState<SearchProgress | null>(null)
  const [searching, setSearching] = useState(false)
  const [message, setMessage] = useState('')
  const [warnings, setWarnings] = useState<string[]>([])
  const tokenRef = useRef('')
  const inFlightRef = useRef(false)

  useEffect(() => {
    return window.api.onSearchProgress((payload) => {
      if (payload.token === tokenRef.current) setProgress(payload)
    })
  }, [])

  useEffect(() => {
    return () => {
      if (inFlightRef.current) void window.api.cancelSearch(tokenRef.current)
    }
  }, [])

  const run = async (event: FormEvent): Promise<void> => {
    event.preventDefault()
    const text = query.trim()
    if (!text || searching) return
    const token = crypto.randomUUID()
    tokenRef.current = token
    inFlightRef.current = true
    setSearching(true)
    setHits([])
    setMessage('')
    setWarnings([])
    setProgress({ token, scanned: 0, total: chapters.length })
    try {
      const result = await window.api.searchBook(bookId, text, token)
      if (tokenRef.current !== token) return
      setHits(result.hits)
      setWarnings(result.warnings)
      if (result.cancelled) setMessage('已取消搜索')
      else if (result.hits.length === 0) {
        setMessage(result.cachedOnly ? '已缓存章节里没有找到匹配内容' : '没有找到匹配内容')
      } else if (result.truncated) setMessage('结果超过 300 条，已截断')
      else if (result.cachedOnly) {
        setMessage(`仅搜索已缓存章节，还有 ${result.skippedUncached} 章未缓存`)
      }
    } catch (reason) {
      if (tokenRef.current === token) {
        setMessage(reason instanceof Error ? reason.message : String(reason))
      }
    } finally {
      if (tokenRef.current === token) {
        inFlightRef.current = false
        setSearching(false)
      }
    }
  }

  const cancel = async (): Promise<void> => {
    if (!searching || !tokenRef.current) return
    await window.api.cancelSearch(tokenRef.current)
  }

  const scannedPercent =
    progress && progress.total > 0 ? Math.round((progress.scanned / progress.total) * 100) : 0

  return (
    <aside className="reader-drawer right search-panel">
      <header className="drawer-header">
        <h2>全书搜索</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭搜索">
          ×
        </button>
      </header>

      <form className="search-form" onSubmit={(event) => void run(event)}>
        <input
          type="search"
          value={query}
          placeholder="输入要查找的文字"
          autoFocus
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="submit" disabled={searching || !query.trim()}>
          {searching ? '搜索中' : '搜索'}
        </button>
        {searching && (
          <button type="button" className="ghost" onClick={() => void cancel()}>
            取消
          </button>
        )}
      </form>

      {searching && (
        <div className="search-progress">
          <div className="search-progress-track">
            <div className="search-progress-fill" style={{ width: `${scannedPercent}%` }} />
          </div>
          <span>
            {progress?.scanned ?? 0} / {progress?.total ?? chapters.length} 章
          </span>
        </div>
      )}

      {message && <p className="search-message">{message}</p>}
      {warnings.length > 0 && <p className="search-warning">{warnings.join('；')}</p>}

      <ul className="search-results">
        {hits.map((hit, index) => (
          <li key={`${hit.chapterIndex}-${hit.paragraphIndex}-${index}`}>
            <button
              className="search-hit"
              onClick={() => {
                onJump(hit.chapterIndex, hit.paragraphIndex)
                onClose()
              }}
            >
              <span className="search-chapter">{chapters[hit.chapterIndex]?.title ?? ''}</span>
              <span className="search-excerpt">{hit.excerpt}</span>
            </button>
          </li>
        ))}
      </ul>
    </aside>
  )
}
