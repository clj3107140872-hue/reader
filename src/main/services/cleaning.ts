import { BUILTIN_AD_RULES, cleanChapterDetailed, cleanChapters } from '../../core/cleaning'
import type { CleaningRunConfig } from '../../core/cleaning'
import type { AdRule } from '../../core/model'
import { chapterFromLines, chaptersFromLines } from '../../core/reprocess'
import type {
  CleaningChapterDiff,
  CleaningConfig,
  CleaningPreview,
  CleaningRuleHit
} from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'
import { normalizeUserRules } from '../storage/rules'
import type { RuleRepository } from '../storage/rules'
import type { SettingsRepository } from '../storage/settings'

interface ResolvedConfig {
  adCleaning: boolean
  builtinRules: AdRule[]
  userRules: AdRule[]
}

function builtinRulesWithState(disabledIds: readonly string[]): AdRule[] {
  const disabled = new Set(disabledIds)
  return BUILTIN_AD_RULES.map((rule) => ({ ...rule, enabled: !disabled.has(rule.id) }))
}

/** Validates renderer-supplied config and fills in the known built-in rules. */
function coerceConfig(config: CleaningConfig): ResolvedConfig {
  if (!config || typeof config !== 'object') throw new Error('清洗规则格式不正确')

  const userRules = normalizeUserRules(config.userRules ?? [])
  const enabledById = new Map<string, boolean>()
  if (Array.isArray(config.builtinRules)) {
    for (const rule of config.builtinRules) {
      if (rule && typeof rule.id === 'string') enabledById.set(rule.id, rule.enabled !== false)
    }
  }
  const builtinRules = BUILTIN_AD_RULES.map((rule) => ({
    ...rule,
    enabled: enabledById.get(rule.id) ?? rule.enabled
  }))

  return { adCleaning: config.adCleaning !== false, builtinRules, userRules }
}

function toRunConfig(config: ResolvedConfig): CleaningRunConfig {
  return {
    adCleaning: config.adCleaning,
    rules: [...config.builtinRules, ...config.userRules]
  }
}

function ruleHits(
  config: ResolvedConfig,
  hits: Record<string, number>
): CleaningRuleHit[] {
  const list = (rules: AdRule[], scope: CleaningRuleHit['scope']): CleaningRuleHit[] =>
    rules.map((rule) => ({
      id: rule.id,
      name: rule.name,
      type: rule.type,
      scope,
      hits: hits[rule.id] ?? 0
    }))
  return [...list(config.builtinRules, 'builtin'), ...list(config.userRules, 'user')]
}

export class CleaningService {
  constructor(
    private readonly settings: SettingsRepository,
    private readonly rules: RuleRepository,
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async getConfig(): Promise<CleaningConfig> {
    const settings = await this.settings.read()
    return {
      adCleaning: settings.cleaning.enabled,
      builtinRules: builtinRulesWithState(settings.cleaning.disabledBuiltinIds),
      userRules: await this.rules.read()
    }
  }

  getConfigSync(): CleaningConfig {
    const settings = this.settings.readSync()
    return {
      adCleaning: settings.cleaning.enabled,
      builtinRules: builtinRulesWithState(settings.cleaning.disabledBuiltinIds),
      userRules: this.rules.readSync()
    }
  }

  async saveConfig(config: CleaningConfig): Promise<CleaningConfig> {
    const resolved = coerceConfig(config)
    await this.rules.save(resolved.userRules)
    await this.settings.update({
      cleaning: {
        enabled: resolved.adCleaning,
        disabledBuiltinIds: resolved.builtinRules
          .filter((rule) => !rule.enabled)
          .map((rule) => rule.id)
      }
    })
    return this.getConfig()
  }

  /** Snapshot used when actually importing or re-cleaning a book. */
  currentRunConfig(): CleaningRunConfig {
    return toRunConfig(coerceConfig(this.getConfigSync()))
  }

  private async resolveConfig(config?: CleaningConfig): Promise<ResolvedConfig> {
    return coerceConfig(config ?? (await this.getConfig()))
  }

  async preview(bookId: string, config?: CleaningConfig): Promise<CleaningPreview> {
    assertBookId(bookId)
    const resolved = await this.resolveConfig(config)
    const meta = await this.books.readMeta(bookId)
    const source = await this.books.readSource(bookId)
    const chapters = chaptersFromLines(source, meta)
    const run = cleanChapters(chapters, toRunConfig(resolved).rules, {
      adCleaning: resolved.adCleaning
    })
    const entry = (await this.library.list()).find((item) => item.id === bookId)

    return {
      bookId,
      title: meta.title,
      adCleaning: resolved.adCleaning,
      chapterCount: meta.chapters.length,
      paragraphCount: run.chapters.reduce((total, chapter) => total + chapter.paragraphs.length, 0),
      adLinesRemoved: run.adLinesRemoved,
      duplicateParagraphsMerged: run.duplicateParagraphsMerged,
      ruleHits: ruleHits(resolved, run.ruleHits),
      chapters: meta.chapters.map((chapter, index) => ({
        index,
        title: chapter.title,
        adLinesRemoved: run.chapterStats[index]?.adLinesRemoved ?? 0,
        duplicateParagraphsMerged: run.chapterStats[index]?.duplicateParagraphsMerged ?? 0
      })),
      appliedStats: entry?.stats ?? {
        adLinesRemoved: 0,
        duplicateParagraphsMerged: 0,
        suspectedDuplicateChapters: 0
      }
    }
  }

  async chapterDiff(
    bookId: string,
    chapterIndex: number,
    config?: CleaningConfig
  ): Promise<CleaningChapterDiff> {
    assertBookId(bookId)
    if (!Number.isInteger(chapterIndex)) throw new Error('无效的章节编号')
    const meta = await this.books.readMeta(bookId)
    if (chapterIndex < 0 || chapterIndex >= meta.chapters.length) {
      throw new Error('无效的章节编号')
    }

    const resolved = await this.resolveConfig(config)
    const source = await this.books.readSource(bookId)
    const chapter = chapterFromLines(source, meta, chapterIndex)
    const detail = cleanChapterDetailed(chapter, toRunConfig(resolved).rules, {
      adCleaning: resolved.adCleaning
    })

    return {
      index: chapterIndex,
      title: chapter.title,
      lines: detail.lines,
      adLinesRemoved: detail.adLinesRemoved,
      duplicateParagraphsMerged: detail.duplicateParagraphsMerged
    }
  }
}
