import type { ChapterMeta, DownloadState } from '../model'
import type { OperationStats, SourceCompat, SourceListItem, SourceStats } from './model'

export const QUALITY_POOL_SIZE = 30

export function emptyOperationStats(): OperationStats {
  return { attempts: 0, successes: 0, empties: 0, errors: 0, totalMs: 0 }
}

export function emptySourceStats(): SourceStats {
  return {
    search: emptyOperationStats(),
    info: emptyOperationStats(),
    toc: emptyOperationStats(),
    content: emptyOperationStats(),
    score: 0,
    lastUsedAt: null
  }
}

export function computeScore(stats: SourceStats, compat: SourceCompat): number {
  const hasAttempts =
    stats.search.attempts > 0 || stats.toc.attempts > 0 || stats.content.attempts > 0
  if (!hasAttempts) return compat.level === 'full' ? 60 : 40

  const searchRate =
    (stats.search.successes + 0.5 * stats.search.empties) / Math.max(1, stats.search.attempts)
  const tocRate = stats.toc.attempts > 0
    ? stats.toc.successes / stats.toc.attempts
    : 0.5
  const contentRate = stats.content.attempts > 0
    ? stats.content.successes / stats.content.attempts
    : 0.5
  const avgMs = stats.search.attempts > 0 ? stats.search.totalMs / stats.search.attempts : 0
  const speedScore = stats.search.attempts > 0 ? 1 - Math.min(avgMs / 10000, 1) : 0.5
  const raw = 35 * searchRate + 20 * tocRate + 30 * contentRate + 15 * speedScore
  const penalty = compat.level === 'partial' ? 10 : 0
  return Math.round(Math.max(0, Math.min(100, raw - penalty)) * 10) / 10
}

function compareSources(a: SourceListItem, b: SourceListItem): number {
  if (a.starred !== b.starred) return a.starred ? -1 : 1
  if (a.score !== b.score) return b.score - a.score
  if (a.customOrder !== b.customOrder) return a.customOrder - b.customOrder
  return a.importedAt.localeCompare(b.importedAt)
}

export function selectQualitySources(sources: SourceListItem[]): SourceListItem[] {
  const candidates = sources.filter((source) => source.enabled && !source.blacklisted)
  const starred = candidates.filter((source) => source.starred).sort(compareSources)
  const normal = candidates
    .filter((source) => !source.starred)
    .sort(compareSources)
    .slice(0, Math.max(0, QUALITY_POOL_SIZE - starred.length))
  return [...starred, ...normal]
}

export function downloadState(cached: number, total: number): DownloadState {
  if (total <= 0 || cached >= total) return 'complete'
  return cached > 0 ? 'partial' : 'none'
}

export function networkCacheFor(
  chapters: ChapterMeta[],
  cached: Set<number>
): { cached: number; total: number } {
  const withUrl = chapters.filter((chapter) => chapter.level !== 'volume' && chapter.url)
  return {
    cached: withUrl.filter((chapter) => cached.has(chapter.index)).length,
    total: withUrl.length
  }
}
