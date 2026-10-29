import iconv from 'iconv-lite'
import { COMMON_HANZI } from './encoding'

export interface RepairResult {
  text: string
  repaired: boolean
  warnings: string[]
}

const BURNED_PATTERN = /锟斤拷|�/
const BURNED_GLOBAL = /锟斤拷|�/g
const WHITESPACE = /\s/u
const DETECT_LATIN_RATIO = 0.25
const UNRECOVERABLE_WARNING = '部分乱码内容无法恢复，已清除'
const UNREPAIRED_WARNING = '检测到疑似乱码，但无法可靠还原，已保留原文'

function commonHanRatio(text: string): number {
  let han = 0
  let total = 0
  for (const ch of text) {
    if (WHITESPACE.test(ch)) continue
    total++
    if (COMMON_HANZI.includes(ch)) han++
  }
  return total === 0 ? 0 : han / total
}

function highLatinRatio(text: string): number {
  let latin = 0
  let total = 0
  for (const ch of text) {
    if (WHITESPACE.test(ch)) continue
    total++
    const c = ch.codePointAt(0)!
    if (c >= 0x00c0 && c <= 0x00ff) latin++
  }
  return total === 0 ? 0 : latin / total
}

function stripBurned(text: string, warnings: string[]): string {
  if (!BURNED_PATTERN.test(text)) return text
  const cleaned = text.replace(BURNED_GLOBAL, '')
  if (cleaned !== text && !warnings.includes(UNRECOVERABLE_WARNING)) {
    warnings.push(UNRECOVERABLE_WARNING)
  }
  return cleaned
}

export function repairMojibake(text: string, encoding: string): RepairResult {
  const warnings: string[] = []
  if (!text) return { text, repaired: false, warnings }

  let working = stripBurned(text, warnings)
  const repairedByStrip = working !== text

  if (encoding === 'utf16le' || encoding === 'utf16be') {
    return { text: working, repaired: repairedByStrip, warnings }
  }

  if (highLatinRatio(working) < DETECT_LATIN_RATIO) {
    return { text: working, repaired: repairedByStrip, warnings }
  }

  const bytes = Buffer.from(working, 'latin1')
  const beforeHan = commonHanRatio(working)
  let bestText = working
  let bestHan = beforeHan
  for (const name of ['utf8', 'gb18030'] as const) {
    const candidate = iconv.decode(bytes, name)
    if (candidate.includes('�')) continue
    const han = commonHanRatio(candidate)
    if (han > bestHan) {
      bestText = candidate
      bestHan = han
    }
  }

  if (bestText === working) {
    if (!warnings.includes(UNREPAIRED_WARNING)) warnings.push(UNREPAIRED_WARNING)
    return { text: working, repaired: repairedByStrip, warnings }
  }

  return { text: stripBurned(bestText, warnings), repaired: true, warnings }
}
