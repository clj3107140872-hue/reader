import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { NetworkSearchGroupView } from '../src/renderer/src/pages/NetworkSearch'
import type { NetworkSearchGroup } from '../src/core/booksource/model'

const group: NetworkSearchGroup = {
  key: 'a|b', title: '书名', author: '作者', bestSourceId: 's1',
  items: [
    { sourceId: 's1', sourceName: '源A', title: '书名', author: '作者', bookUrl: 'u1', qualityScore: 80, starred: false, inShelf: false },
    { sourceId: 's2', sourceName: '源B', title: '书名', author: '作者', bookUrl: 'u2', qualityScore: 60, starred: false, inShelf: false }
  ]
}

describe('NetworkSearchGroupView', () => {
  it('shows the best source first and hides other sources until expanded', () => {
    const html = renderToStaticMarkup(
      <NetworkSearchGroupView group={group} expanded={false} onToggle={() => {}} onAdd={() => {}} adding={null} />
    )
    expect(html).toContain('源A')
    expect(html).not.toContain('源B')
    expect(html).toContain('其他来源 1')
  })
})
