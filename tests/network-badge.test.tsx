import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import NetworkBookBadge from '../src/renderer/src/components/NetworkBookBadge'
import type { LibraryEntry } from '../src/core/model'

const entry: LibraryEntry = {
  id: 'b1', title: '书', format: 'network', sourceId: 's1', sourceName: '源A',
  normalizedTitle: '书', sourceFileName: '书.txt', fileHash: 'x', encoding: 'utf-8',
  importedAt: '2026-01-01', lastReadAt: null, chapterCount: 3,
  progressPercent: 0, stats: { adLinesRemoved: 0, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 },
  networkCache: { cached: 1, total: 3 }, downloadState: 'partial'
}

describe('NetworkBookBadge', () => {
  it('shows source name and download state', () => {
    const html = renderToStaticMarkup(<NetworkBookBadge entry={entry} />)
    expect(html).toContain('网络 · 源A')
    expect(html).toContain('1/3')
    expect(html).toContain('未下载完')
  })

  it('shows deleted source', () => {
    const html = renderToStaticMarkup(<NetworkBookBadge entry={entry} sourceMissing />)
    expect(html).toContain('书源已删除')
  })
})
