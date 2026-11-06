import type { SourceListItem } from '../../../core/booksource/model'

function scoreClass(score: number): string {
  return score >= 70 ? 'good' : score >= 40 ? 'mid' : 'bad'
}

export default function SourceList({
  sources,
  onFlags,
  onRaw,
  onDelete
}: {
  sources: SourceListItem[]
  onFlags: (source: SourceListItem, flags: { enabled?: boolean; starred?: boolean; blacklisted?: boolean }) => void
  onRaw: (source: SourceListItem) => void
  onDelete: (source: SourceListItem) => void
}) {
  if (sources.length === 0) return <p className="empty">还没有书源，先导入一个。</p>
  return (
    <div className="source-list">
      {sources.map((source) => (
        <article key={source.id} className={`source-row ${source.enabled ? '' : 'disabled'}`}>
          <div className="source-main">
            <div className="source-title">
              <strong>{source.name}</strong>
              {source.starred && <span className="tag star">标星</span>}
              {source.blacklisted && <span className="tag black">拉黑</span>}
              {source.compat.level === 'partial' && <span className="tag partial">部分兼容</span>}
            </div>
            <div className="source-sub">{source.group || '未分组'} · {source.url}</div>
            <div className="source-sub">
              评分 <span className={`score ${scoreClass(source.score)}`}>{source.score.toFixed(1)}</span>
              {' · '}搜索成功率 {(source.searchSuccessRate * 100).toFixed(0)}%
              {' · '}平均 {source.avgMs} ms
              {' · '}书架 {source.bookCount ?? 0} 本
            </div>
            {source.compat.issues.length > 0 && (
              <div className="source-sub warn">{source.compat.issues.join('、')}</div>
            )}
            {source.lastError && (
              <div className="source-sub warn">
                最近失败：{source.lastError.operation} · {source.lastError.message}
              </div>
            )}
          </div>
          <div className="source-actions">
            <label>
              <input type="checkbox" checked={source.enabled} onChange={(event) => onFlags(source, { enabled: event.target.checked })} />
              启用
            </label>
            <label>
              <input type="checkbox" checked={source.starred} onChange={(event) => onFlags(source, { starred: event.target.checked })} />
              标星
            </label>
            <label>
              <input type="checkbox" checked={source.blacklisted} onChange={(event) => onFlags(source, { blacklisted: event.target.checked })} />
              拉黑
            </label>
            <button className="ghost" onClick={() => onRaw(source)}>查看 JSON</button>
            <button className="danger" onClick={() => onDelete(source)}>删除</button>
          </div>
        </article>
      ))}
    </div>
  )
}
