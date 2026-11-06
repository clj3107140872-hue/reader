import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { OpenBookPayload } from '../../../shared/api'
import { errorText } from '../errors'

export function needsLoad(
  index: number,
  enabled: boolean,
  texts: Set<number>,
  requested: Set<number>
): boolean {
  return enabled && !texts.has(index) && !requested.has(index)
}

export function mergeChapterText(
  current: Record<number, string>,
  index: number,
  text: string
): Record<number, string> {
  return { ...current, [index]: text }
}

export interface ChapterLoadState {
  loading: boolean
  error?: string
}

function loadedIndexes(texts: Record<number, string>): Set<number> {
  return new Set(Object.keys(texts).map(Number))
}

/**
 * Fetches the visible chapters of a network book on demand. Resolved text is
 * kept in a ref as well as in state so a chapter is never requested twice,
 * even when the effect that asks for it runs again before React re-renders.
 */
export function useChapterTexts(
  book: OpenBookPayload | null,
  indexes: number[]
): {
  texts: Record<number, string>
  states: Record<number, ChapterLoadState>
  retry: (index: number) => void
} {
  const [texts, setTexts] = useState<Record<number, string>>({})
  const [states, setStates] = useState<Record<number, ChapterLoadState>>({})
  const textsRef = useRef<Record<number, string>>({})
  const requested = useRef(new Set<number>())
  const aliveRef = useRef(true)
  const bookId = book?.meta.id ?? ''

  useEffect(() => {
    aliveRef.current = true
    textsRef.current = {}
    setTexts({})
    setStates({})
    requested.current = new Set()
    return () => {
      aliveRef.current = false
    }
  }, [bookId])

  const load = useCallback(
    (index: number): void => {
      if (!book || book.contentMode !== 'lazy') return
      if (!needsLoad(index, true, loadedIndexes(textsRef.current), requested.current)) return
      requested.current.add(index)
      setStates((current) => ({ ...current, [index]: { loading: true } }))
      void window.api
        .readNetworkChapter(book.meta.id, index)
        .then((payload) => {
          if (!aliveRef.current) return
          textsRef.current = mergeChapterText(textsRef.current, index, payload.text)
          setTexts(textsRef.current)
          setStates((current) => ({ ...current, [index]: { loading: false } }))
        })
        .catch((reason: unknown) => {
          if (!aliveRef.current) return
          setStates((current) => ({
            ...current,
            [index]: {
              loading: false,
              error: errorText(reason)
            }
          }))
        })
        .finally(() => {
          requested.current.delete(index)
        })
    },
    [book]
  )

  const key = useMemo(() => indexes.join(','), [indexes])

  useEffect(() => {
    if (!book || book.contentMode !== 'lazy') return
    const loaded = loadedIndexes(textsRef.current)
    for (const index of key ? key.split(',').map(Number) : []) {
      if (!Number.isInteger(index) || index < 0) continue
      if (needsLoad(index, true, loaded, requested.current)) load(index)
    }
  }, [book, key, load])

  const retry = useCallback(
    (index: number): void => {
      requested.current.delete(index)
      load(index)
    },
    [load]
  )

  return { texts, states, retry }
}
