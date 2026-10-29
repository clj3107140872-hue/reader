import iconv from 'iconv-lite'

export interface RepairResult {
  text: string
  repaired: boolean
  warnings: string[]
}

function mojibakeScore(text: string): number {
  if (!text) return 0
  let latin = 0
  let burned = 0
  let total = 0
  for (const ch of text) {
    const c = ch.codePointAt(0)!
    if (c === 10 || c === 13 || c === 32) continue
    total++
    if (c >= 0x00a0 && c <= 0x00ff) latin++
    if (ch === '锟' || c === 0xfffd) burned++
  }
  if (total === 0) return 0
  return (latin + burned * 3) / total
}

export function repairMojibake(text: string, encoding: string): RepairResult {
  const warnings: string[] = []
  if (!text) return { text, repaired: false, warnings }

  const hadBurned = /[\uFFFD锟]/.test(text)
  let working = text
  if (hadBurned) {
    working = working.replace(/锟斤拷/g, '').replace(/[锟\uFFFD]+/g, '')
    warnings.push('部分乱码内容无法恢复，已清除')
  }

  const before = mojibakeScore(working)
  if (before < 0.05) {
    return { text: working, repaired: hadBurned, warnings }
  }

  const candidates: string[] = []
  if (/[\u00a0-\u00ff]/.test(text) && encoding !== 'utf16le' && encoding !== 'utf16be') {
    const latin = Buffer.from(working, 'latin1')
    candidates.push(iconv.decode(latin, 'utf8'))
    candidates.push(iconv.decode(latin, 'gb18030'))
  }

  let bestText = working
  let bestScore = before
  for (const candidate of candidates) {
    const score = mojibakeScore(candidate)
    if (score < bestScore) {
      bestScore = score
      bestText = candidate
    }
  }

  if (bestText === working) return { text: working, repaired: hadBurned, warnings }

  if (/[\uFFFD锟斤拷]/.test(bestText)) {
    bestText = bestText.replace(/\uFFFD+/g, '').replace(/锟斤拷/g, '')
    warnings.push('部分乱码内容无法恢复，已清除')
  }

  return { text: bestText, repaired: true, warnings }
}
