import { useEffect, useRef, useState } from 'react'
import type { ReactElement } from 'react'
import type { NetworkSearchGroup, NetworkSearchItem } from '../../../core/booksource/model'
import type { NetworkSearchPayload } from '../../../shared/api'
import { errorText } from '../errors'

export function NetworkSearchGroupView({
  group,
  expanded,
  onToggle,
  onAdd,
  adding
}: {
  group: NetworkSearchGroup
  expanded: boolean
  onToggle: () => void
  onAdd: (item: NetworkSearchItem) => void
  adding: string | null
}) {
  const best = group.items.find((item) => item.sourceId === group.bestSourceId) ?? group.items[0]
  const others = group.items.filter((item) => item !== best)
  const renderItem = (item: NetworkSearchItem): ReactElement => (
    <div key={item.sourceId} className="network-result">
      <div className="network-result-main">
        <div className="network-result-title">
          {item.title}
          {item.author && <span className="network-result-author">{item.author}</span>}
          {item.starred && <span className="tag star">标星</span>}
          {item.inShelf && <span className="tag">已在书架</span>}
        </div>
        <div className="network-result-sub">
          来源：{item.sourceName} · 评分 {item.qualityScore.toFixed(1)}
          {item.lastChapter ? ` · 最新：${item.lastChapter}` : ''}
        </div>
        {item.intro && <p className="network-result-intro">{item.intro}</p>}
      </div>
      <button
        className="network-add"
        disabled={adding === `${item.sourceId}:${item.bookUrl}`}
        onClick={() => onAdd(item)}
      >
        {adding === `${item.sourceId}:${item.bookUrl}` ? '加入中…' : '加入书架'}
      </button>
    </div>
  )
  return (
    <article className="network-group">
      {renderItem(best)}
      {others.length > 0 && (
        <>
          <button className="network-others" onClick={onToggle}>
            {expanded ? '收起其他来源' : `其他来源 ${others.length}`}
          </button>
          {expanded && others.map(renderItem)}
        </>
      )}
    </article>
  )
}

export default function NetworkSearch({
  networkEnabled,
  onBack,
  onAdded
}: {
  networkEnabled: boolean
  onBack: () => void
  onAdded: () => void
}) {
  const [keyword, setKeyword] = useState('')
  const [scope, setScope] = useState<'quality' | 'all'>('quality')
  const [payload, setPayload] = useState<NetworkSearchPayload | null>(null)
  const [sourceEvents, setSourceEvents] = useState<Record<string, string>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [searching, setSearching] = useState(false)
  const [adding, setAdding] = useState<string | null>(null)
  const [message, setMessage] = useState('')
  const [toast, setToast] = useState('')
  const requestRef = useRef('')
  const scopeRef = useRef<'quality' | 'all'>('quality')

  useEffect(() => {
    const offSource = window.api.onNetworkSearchSource((event) => {
      if (event.requestId !== requestRef.current) return
      setSourceEvents((current) => ({
        ...current,
        [event.sourceId]:
          event.status === 'error'
            ? `${event.sourceName}：失败（${event.message ?? '未知错误'}）`
            : `${event.sourceName}：${event.count} 条`
      }))
    })
    const offResults = window.api.onNetworkSearchResults((next) => {
      if (next.requestId === requestRef.current) setPayload(next)
    })
    const offDone = window.api.onNetworkSearchDone((done) => {
      if (done.requestId !== requestRef.current) return
      setSearching(false)
      setPayload((current) =>
        current
          ? { ...current, groups: done.groups }
          : {
              requestId: done.requestId,
              groups: done.groups,
              searched: done.searched,
              succeeded: done.succeeded,
              empty: done.empty,
              failed: done.failed,
              remaining: 0,
              scope: scopeRef.current
            }
      )
      if (done.cancelled) setMessage('已取消搜索')
      else if (done.groups.length === 0) setMessage('没有找到这本书，可以换全量书源再试')
    })
    const offError = window.api.onNetworkSearchError((event) => {
      if (event.requestId !== requestRef.current) return
      setSearching(false)
      setMessage(`搜索失败：${event.message}`)
    })
    return () => { offSource(); offResults(); offDone(); offError() }
  }, [])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(''), 2000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const run = async (nextScope: 'quality' | 'all'): Promise<void> => {
    const text = keyword.trim()
    if (!text || searching) return
    if (!networkEnabled) {
      setMessage('已关闭「允许联网」，请先在设置 → 网络里打开')
      return
    }
    const requestId = crypto.randomUUID()
    requestRef.current = requestId
    scopeRef.current = nextScope
    setScope(nextScope)
    setSearching(true)
    setPayload(null)
    setSourceEvents({})
    setExpanded(new Set())
    setMessage('')
    try {
      const done = await window.api.searchNetwork({ requestId, keyword: text, scope: nextScope })
      if (requestId === requestRef.current) setPayload((current) => current ? { ...current, groups: done.groups } : current)
    } catch (reason) {
      if (requestId === requestRef.current) setMessage(`搜索失败：${errorText(reason)}`)
    } finally {
      if (requestId === requestRef.current) setSearching(false)
    }
  }

  const add = async (item: NetworkSearchItem): Promise<void> => {
    const key = `${item.sourceId}:${item.bookUrl}`
    setAdding(key)
    try {
      await window.api.addNetworkBook({
        sourceId: item.sourceId,
        bookUrl: item.bookUrl,
        title: item.title,
        author: item.author
      })
      setToast(`已加入书架：${item.title}`)
      onAdded()
    } catch (reason) {
      setToast(`加入失败：${errorText(reason)}`)
    } finally {
      setAdding(null)
    }
  }

  return (
    <div className="app">
      <header className="toolbar">
        <button className="ghost" onClick={onBack}>← 书架</button>
        <h1>网络搜索</h1>
        <div className="toolbar-actions">
          <select value={scope} onChange={(event) => setScope(event.target.value as 'quality' | 'all')} aria-label="搜索范围">
            <option value="quality">优质书源</option>
            <option value="all">全量书源</option>
          </select>
        </div>
      </header>
      <form className="network-search-bar" onSubmit={(event) => { event.preventDefault(); void run(scope) }}>
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="输入书名或作者"
          autoFocus
        />
        <button type="submit" disabled={searching || !keyword.trim()}>{searching ? '搜索中…' : '搜索'}</button>
        {searching && <button type="button" className="ghost" onClick={() => void window.api.cancelNetworkSearch(requestRef.current)}>取消</button>}
        {!searching && payload && <button type="button" className="ghost" onClick={() => void run('all')}>用全量书源再搜一次</button>}
      </form>
      {!networkEnabled && <p className="hint">已关闭「允许联网」，搜索和下载不可用；已缓存章节仍可阅读。</p>}
      {message && <p className="hint">{message}</p>}
      {searching && (
        <p className="hint">
          已搜索 {payload?.searched ?? 0} 个来源，成功 {payload?.succeeded ?? 0} 个，空 {payload?.empty ?? 0} 个，失败 {payload?.failed ?? 0} 个
        </p>
      )}
      {Object.values(sourceEvents).length > 0 && (
        <details className="network-progress">
          <summary>搜索明细</summary>
          <ul>{Object.entries(sourceEvents).map(([id, text]) => <li key={id}>{text}</li>)}</ul>
        </details>
      )}
      <div className="network-results">
        {payload?.groups.map((group) => (
          <NetworkSearchGroupView
            key={group.key}
            group={group}
            expanded={expanded.has(group.key)}
            onToggle={() => setExpanded((current) => {
              const next = new Set(current)
              if (next.has(group.key)) next.delete(group.key)
              else next.add(group.key)
              return next
            })}
            onAdd={(item) => void add(item)}
            adding={adding}
          />
        ))}
      </div>
      {!searching && payload && payload.groups.length === 0 && !message && (
        <p className="empty">没有结果。</p>
      )}
      {toast && <div className="toast" role="status">{toast}</div>}
    </div>
  )
}
