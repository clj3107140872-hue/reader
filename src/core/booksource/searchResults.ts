import type { NetworkSearchGroup, NetworkSearchItem } from './model'

export function normalizeSearchTitle(value: string): string {
  return value
    .trim()
    .replace(/　/g, ' ')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

export function normalizeSearchAuthor(value: string): string {
  return normalizeSearchTitle(value)
}

export function searchGroupKey(title: string, author: string): string {
  return `${normalizeSearchTitle(title)}|${normalizeSearchAuthor(author)}`
}

function compareItems(a: NetworkSearchItem, b: NetworkSearchItem): number {
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  if (a.qualityScore !== b.qualityScore) return b.qualityScore - a.qualityScore
  const avg = (a.avgMs ?? Number.MAX_SAFE_INTEGER) - (b.avgMs ?? Number.MAX_SAFE_INTEGER)
  if (avg !== 0) return avg
  return (a.importedAt ?? '').localeCompare(b.importedAt ?? '')
}

export function mergeSearchResults(items: NetworkSearchItem[]): NetworkSearchGroup[] {
  const groups = new Map<string, NetworkSearchItem[]>()
  for (const item of items) {
    const key = searchGroupKey(item.title, item.author)
    const list = groups.get(key) ?? []
    if (!list.some((existing) => existing.sourceId === item.sourceId)) list.push(item)
    groups.set(key, list)
  }
  return [...groups.entries()]
    .map(([key, list]) => {
      const sorted = [...list].sort(compareItems)
      return {
        key,
        title: sorted[0].title,
        author: sorted[0].author,
        items: sorted,
        bestSourceId: sorted[0].sourceId
      }
    })
    .sort((a, b) => compareItems(a.items[0], b.items[0]))
}
