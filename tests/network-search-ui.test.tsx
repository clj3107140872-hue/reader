import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import {
  NetworkSearchGroupView,
  NetworkSearchNotice
} from '../src/renderer/src/pages/NetworkSearch'
import type { NetworkSearchGroup } from '../src/core/booksource/model'

const group: NetworkSearchGroup = {
  key: 'a|b', title: '书名', author: '作者', bestSourceId: 's1',
  items: [
    { sourceId: 's1', sourceName: '源A', title: '书名', author: '作者', bookUrl: 'u1', qualityScore: 80, starred: false, inShelf: false },
    { sourceId: 's2', sourceName: '源B', title: '书名', author: '作者', bookUrl: 'u2', qualityScore: 60, starred: false, inShelf: false }
  ]
}

function renderGroup(next: NetworkSearchGroup): string {
  return renderToStaticMarkup(
    <NetworkSearchGroupView
      group={next}
      expanded={false}
      onToggle={() => {}}
      onAdd={() => {}}
      onOpen={() => {}}
      adding={null}
    />
  )
}

describe('NetworkSearchGroupView', () => {
  it('shows the best source first and hides other sources until expanded', () => {
    const html = renderGroup(group)
    expect(html).toContain('源A')
    expect(html).not.toContain('源B')
    expect(html).toContain('其他来源 1')
  })

  it('offers 打开 instead of 加入书架 for a book already on the shelf', () => {
    const shelfGroup: NetworkSearchGroup = {
      ...group,
      items: [
        { ...group.items[0], inShelf: true, shelfId: 'book-1' }
      ]
    }
    const html = renderGroup(shelfGroup)
    expect(html).toContain('打开')
    expect(html).not.toContain('加入书架')
  })

  it('shows a disabled 已在书架 when the shelf id is missing', () => {
    const shelfGroup: NetworkSearchGroup = {
      ...group,
      items: [
        { ...group.items[0], inShelf: true }
      ]
    }
    const html = renderGroup(shelfGroup)
    expect(html).toMatch(/<button[^>]*disabled[^>]*>已在书架<\/button>/)
    expect(html).not.toContain('加入书架')
  })
})

describe('NetworkSearchNotice', () => {
  it('shows an error summary with 重试 and no full search when every source failed', () => {
    const html = renderToStaticMarkup(
      <NetworkSearchNotice
        message="搜索失败：2 个书源都没有返回结果，请检查网络后重试"
        retry
        searchAll={false}
        onRetry={() => {}}
        onSearchAll={() => {}}
      />
    )
    expect(html).toContain('搜索失败：2 个书源都没有返回结果')
    expect(html).toContain('重试')
    expect(html).not.toContain('用全量书源再搜一次')
  })

  it('offers the full search only for a genuine zero-result search', () => {
    const html = renderToStaticMarkup(
      <NetworkSearchNotice
        message="没有找到这本书，可以换全量书源再试"
        retry={false}
        searchAll
        onRetry={() => {}}
        onSearchAll={() => {}}
      />
    )
    expect(html).toContain('用全量书源再搜一次')
    expect(html).not.toContain('重试')
  })
})
