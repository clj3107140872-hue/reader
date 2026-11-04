import { useEffect, useState } from 'react'

/** Covers never change for a given book id, so one fetch per book is enough. */
const cache = new Map<string, string | null>()

export function useBookCover(id: string | null): string | null {
  const [cover, setCover] = useState<string | null>(id ? (cache.get(id) ?? null) : null)

  useEffect(() => {
    if (!id) {
      setCover(null)
      return
    }
    if (cache.has(id)) {
      setCover(cache.get(id) ?? null)
      return
    }
    let cancelled = false
    window.api
      .bookCover(id)
      .then((value) => {
        cache.set(id, value)
        if (!cancelled) setCover(value)
      })
      .catch(() => {
        cache.set(id, null)
        if (!cancelled) setCover(null)
      })
    return () => {
      cancelled = true
    }
  }, [id])

  return cover
}
