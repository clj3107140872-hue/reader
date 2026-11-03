import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { BUILTIN_AD_RULES } from '../../core/cleaning'
import type { AdRule } from '../../core/model'
import { atomicWriteJson, readJsonSync } from './fsUtil'

const MAX_RULES = 200
const MAX_NAME_LENGTH = 40
const MAX_PATTERN_LENGTH = 500

const BUILTIN_IDS = new Set(BUILTIN_AD_RULES.map((rule) => rule.id))

function parseRule(raw: unknown, usedIds: Set<string>): AdRule {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('清洗规则格式不正确')
  }
  const input = raw as Record<string, unknown>

  const name = typeof input.name === 'string' ? input.name.trim() : ''
  if (!name) throw new Error('规则名称不能为空')
  if (name.length > MAX_NAME_LENGTH) throw new Error('规则名称过长')

  const pattern = typeof input.pattern === 'string' ? input.pattern : ''
  if (!pattern.trim()) throw new Error('规则内容不能为空')
  if (pattern.length > MAX_PATTERN_LENGTH) throw new Error('规则内容过长')
  try {
    new RegExp(pattern)
  } catch {
    throw new Error('正则无效')
  }

  if (input.type !== 'line' && input.type !== 'sentence') {
    throw new Error('规则类型不正确')
  }

  let id = typeof input.id === 'string' ? input.id.trim() : ''
  if (!id) id = `user-${randomUUID()}`
  if (BUILTIN_IDS.has(id)) throw new Error('自定义规则编号与内置规则冲突')
  if (usedIds.has(id)) throw new Error('规则编号重复')
  usedIds.add(id)

  return {
    id,
    name,
    type: input.type,
    pattern,
    enabled: typeof input.enabled === 'boolean' ? input.enabled : true
  }
}

/** Validates a full rule list; throws on the first invalid rule. Used before saving. */
export function normalizeUserRules(input: unknown): AdRule[] {
  if (!Array.isArray(input)) throw new Error('清洗规则格式不正确')
  if (input.length > MAX_RULES) throw new Error('规则数量过多')
  const usedIds = new Set<string>()
  return input.map((raw) => parseRule(raw, usedIds))
}

export class RuleRepository {
  constructor(private readonly root: string) {}

  private get file(): string {
    return join(this.root, 'rules', 'user-ads.json')
  }

  async read(): Promise<AdRule[]> {
    return this.readSync()
  }

  /** Broken entries are skipped so one bad rule cannot hide the rest. */
  readSync(): AdRule[] {
    const stored = readJsonSync<unknown>(this.file)
    if (!stored || typeof stored !== 'object') return []
    const list = (stored as { rules?: unknown }).rules
    if (!Array.isArray(list)) return []

    const usedIds = new Set<string>()
    const rules: AdRule[] = []
    for (const raw of list) {
      try {
        rules.push(parseRule(raw, usedIds))
      } catch {
        // Keep the remaining rules readable.
      }
    }
    return rules
  }

  async save(input: unknown): Promise<AdRule[]> {
    const rules = normalizeUserRules(input)
    await atomicWriteJson(this.file, { version: 1, rules })
    return rules
  }
}
