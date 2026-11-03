export const ENCODING_OPTIONS = [
  { id: 'utf8', label: 'UTF-8' },
  { id: 'gb18030', label: 'GBK / GB18030（简体）' },
  { id: 'big5', label: 'Big5（繁体）' },
  { id: 'utf16le', label: 'UTF-16 LE' },
  { id: 'utf16be', label: 'UTF-16 BE' }
] as const

export type SupportedEncoding = (typeof ENCODING_OPTIONS)[number]['id']

const ENCODING_IDS = new Set<string>(ENCODING_OPTIONS.map((item) => item.id))

export function isSupportedEncoding(value: unknown): value is SupportedEncoding {
  return typeof value === 'string' && ENCODING_IDS.has(value)
}
