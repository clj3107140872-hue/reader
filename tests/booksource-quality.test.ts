import { describe, expect, it } from 'vitest'
import type { SourceListItem, SourceStats } from '../src/core/booksource/model'
import { computeScore, downloadState, selectQualitySources } from '../src/core/booksource/quality'
import { mergeSearchResults } from '../src/core/booksource/searchResults'
import { diffToc } from '../src/core/booksource/toc'
import type { ChapterMeta } from '../src/core/model'

function stats(partial: Partial<SourceStats> = {}): SourceStats {
  return {
    search: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    info: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    toc: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    content: { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 },
    score: 0,
    lastUsedAt: null,
    ...partial
  }
}

function source(id: string, overrides: Partial<SourceListItem> = {}): SourceListItem {
  return {
    id,
    name: id,
    url: `https://${id}.example.com`,
    group: '',
    enabled: true,
    starred: false,
    blacklisted: false,
    compat: { level: 'full', issues: [] },
    score: 60,
    searchSuccessRate: 0,
    avgMs: 0,
    importedAt: '2026-01-01T00:00:00.000Z',
    customOrder: 0,
    ...overrides
  }
}

describe('quality and search grouping', () => {
  it('uses initial scores and penalises partial sources after stats exist', () => {
    expect(computeScore(stats(), { level: 'full', issues: [] })).toBe(60)
    expect(computeScore(stats(), { level: 'partial', issues: ['JS'] })).toBe(40)
    const perfect = computeScore(
      stats({
        search: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 },
        toc: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 },
        content: { attempts: 10, successes: 10, empties: 0, errors: 0, totalMs: 0 }
      }),
      { level: 'full', issues: [] }
    )
    expect(perfect).toBe(100)
  })

  it('puts all starred sources in the pool and fills to 30', () => {
    const list = [
      ...Array.from({ length: 35 }, (_, i) => source(`s${i}`, { score: 90 - i })),
      source('starred', { starred: true, score: 1 })
    ]
    const pool = selectQualitySources(list)
    expect(pool).toHaveLength(30)
    expect(pool[0].id).toBe('starred')
    expect(pool.some((item) => item.id === 's29')).toBe(false)
  })

  it('groups by normalized title and author and picks the best source', () => {
    const groups = mergeSearchResults([
      { sourceId: 'a', sourceName: 'A', title: ' 斗破  苍穹 ', author: '天蚕土豆', bookUrl: 'u1', qualityScore: 70, starred: false, inShelf: false, avgMs: 100, importedAt: '2026-01-01' },
      { sourceId: 'b', sourceName: 'B', title: '斗破 苍穹', author: '天蚕土豆', bookUrl: 'u2', qualityScore: 80, starred: false, inShelf: false, avgMs: 200, importedAt: '2026-01-02' },
      { sourceId: 'c', sourceName: 'C', title: '斗破苍穹', author: '别人', bookUrl: 'u3', qualityScore: 99, starred: true, inShelf: false, avgMs: 50, importedAt: '2026-01-03' }
    ])
    expect(groups).toHaveLength(2)
    const group = groups.find((item) => item.author === '天蚕土豆')!
    expect(group.bestSourceId).toBe('b')
    expect(group.items).toHaveLength(2)
  })

  it('computes download states and appends toc chapters without reordering', () => {
    expect(downloadState(0, 0)).toBe('complete')
    expect(downloadState(0, 3)).toBe('none')
    expect(downloadState(1, 3)).toBe('partial')
    expect(downloadState(3, 3)).toBe('complete')

    const existing: ChapterMeta[] = [
      { index: 0, title: '第一章', level: 'chapter', titleHash: 'a', startLine: 0, charCount: 0, simhash: '', flags: {}, url: 'u1' }
    ]
    const result = diffToc(existing, [
      { title: '第一章 新标题', url: 'u1', level: 'chapter' },
      { title: '第二章', url: 'u2', level: 'chapter' }
    ])
    expect(result.added).toBe(1)
    expect(result.chapters[0].index).toBe(0)
    expect(result.chapters[0].title).toBe('第一章 新标题')
    expect(result.chapters[1].index).toBe(1)
    expect(result.chapters[1].url).toBe('u2')

    // A chapter that disappeared from the toc stays in place so its cached
    // text and index do not become orphaned.
    const shrunk = diffToc(existing, [{ title: '第三章', url: 'u3', level: 'chapter' }])
    expect(shrunk.chapters[0].url).toBe('u1')
    expect(shrunk.chapters[1].url).toBe('u3')
    expect(shrunk.added).toBe(1)
  })
})
