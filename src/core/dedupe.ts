import { hammingBig, toBig } from './text'

export interface DedupeItem {
  titleHash: string
  simhash: string
  charCount: number
}

export function markDuplicateChapters(items: DedupeItem[]): boolean[] {
  const flags = new Array<boolean>(items.length).fill(false)
  const sims = items.map((item) => toBig(item.simhash))

  const byTitle = new Map<string, number[]>()
  items.forEach((item, index) => {
    const list = byTitle.get(item.titleHash) ?? []
    list.push(index)
    byTitle.set(item.titleHash, list)
  })

  for (const list of byTitle.values()) {
    for (let a = 0; a < list.length; a++) {
      for (let b = a + 1; b < list.length; b++) {
        const i = list[a]
        const j = list[b]
        if (flags[j]) continue
        const ratio = items[i].charCount / Math.max(1, items[j].charCount)
        if (ratio < 0.8 || ratio > 1.25) continue
        if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
      }
    }
  }

  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      if (flags[j]) continue
      const ratio = items[i].charCount / Math.max(1, items[j].charCount)
      if (ratio < 0.8 || ratio > 1.25) continue
      if (hammingBig(sims[i], sims[j]) <= 3) flags[j] = true
    }
  }

  return flags
}
