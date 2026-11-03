import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { BUILTIN_AD_RULES } from '../src/core/cleaning'
import type { CleanedChapter } from '../src/core/model'
import { buildChapterMetas } from '../src/core/pipeline'
import { CleaningService } from '../src/main/services/cleaning'
import { BookRepository } from '../src/main/storage/book'
import { LibraryRepository } from '../src/main/storage/library'
import { RuleRepository } from '../src/main/storage/rules'
import { SettingsRepository } from '../src/main/storage/settings'

let root = ''
let library: LibraryRepository
let books: BookRepository
let settings: SettingsRepository
let rules: RuleRepository
let service: CleaningService

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-cleaning-'))
  library = new LibraryRepository(root)
  books = new BookRepository(root)
  settings = new SettingsRepository(root)
  rules = new RuleRepository(root)
  service = new CleaningService(settings, rules, library, books)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const SOURCE =
  '第一章\n正文。\n请记住本站\n第二章\n更多正文。\n请记住本站\n第三章\n结尾。\n请记住本站'
const CHAPTERS: CleanedChapter[] = [
  { title: '第一章', level: 'chapter', startLine: 0, paragraphs: ['正文。', '请记住本站'] },
  { title: '第二章', level: 'chapter', startLine: 3, paragraphs: ['更多正文。', '请记住本站'] },
  { title: '第三章', level: 'chapter', startLine: 6, paragraphs: ['结尾。', '请记住本站'] }
]

async function seed(): Promise<void> {
  await books.writeBook({
    meta: {
      version: 1,
      id: 'book-1',
      title: '测试书',
      encoding: 'utf8',
      chapters: buildChapterMetas(CHAPTERS),
      createdAt: '2026-01-01T00:00:00.000Z'
    },
    sourceText: SOURCE,
    chapters: CHAPTERS
  })
  await library.add({
    id: 'book-1',
    title: '测试书',
    normalizedTitle: '测试书',
    sourceFileName: '测试书.txt',
    fileHash: 'hash',
    encoding: 'utf8',
    importedAt: '2026-01-01T00:00:00.000Z',
    lastReadAt: null,
    chapterCount: 3,
    progressPercent: 0,
    stats: { adLinesRemoved: 99, duplicateParagraphsMerged: 0, suspectedDuplicateChapters: 0 }
  })
}

describe('CleaningService', () => {
  it('saves the switch and disabled built-ins, then reports them back', async () => {
    const config = await service.getConfig()
    const saved = await service.saveConfig({
      adCleaning: false,
      builtinRules: config.builtinRules.map((rule) =>
        rule.id === 'url' ? { ...rule, enabled: false } : rule
      ),
      userRules: [{ id: 'user-1', name: '我的广告', type: 'line', pattern: '广告', enabled: true }]
    })

    expect(saved.adCleaning).toBe(false)
    expect(saved.builtinRules.find((rule) => rule.id === 'url')?.enabled).toBe(false)
    expect(saved.builtinRules.find((rule) => rule.id === 'site')?.enabled).toBe(true)
    expect((await settings.read()).cleaning).toEqual({
      enabled: false,
      disabledBuiltinIds: ['url']
    })
    expect(service.currentRunConfig().adCleaning).toBe(false)
    expect(service.currentRunConfig().rules.map((rule) => rule.id)).toContain('user-1')
  })

  it('previews hits and per-chapter stats without touching the book', async () => {
    await seed()
    const preview = await service.preview('book-1')

    expect(preview.adLinesRemoved).toBe(3)
    expect(preview.duplicateParagraphsMerged).toBe(0)
    expect(preview.paragraphCount).toBe(3)
    expect(preview.chapterCount).toBe(3)
    expect(preview.chapters[0]).toMatchObject({ index: 0, title: '第一章', adLinesRemoved: 1 })
    expect(preview.ruleHits.find((hit) => hit.id === 'sentence')).toMatchObject({
      scope: 'builtin',
      hits: 3
    })
    expect(preview.appliedStats.adLinesRemoved).toBe(99)
    expect(await books.readChapter('book-1', 0)).toContain('请记住本站')
  })

  it('previews a draft config without saving it', async () => {
    await seed()
    const preview = await service.preview('book-1', {
      adCleaning: false,
      builtinRules: BUILTIN_AD_RULES,
      userRules: []
    })

    expect(preview.adLinesRemoved).toBe(0)
    expect(preview.paragraphCount).toBe(6)
    expect((await settings.read()).cleaning.enabled).toBe(true)
  })

  it('marks the removed sentence in a per-chapter diff', async () => {
    await seed()
    const diff = await service.chapterDiff('book-1', 0)

    expect(diff.title).toBe('第一章')
    expect(diff.adLinesRemoved).toBe(1)
    expect(diff.lines[0]).toMatchObject({ original: '正文。', removed: null })
    expect(diff.lines[1]).toMatchObject({ original: '请记住本站', cleaned: '', removed: 'sentence' })
    expect(diff.lines[1].segments[0]).toMatchObject({ removed: true, kind: 'sentence' })
  })

  it('rejects an out-of-range chapter', async () => {
    await seed()
    await expect(service.chapterDiff('book-1', 9)).rejects.toThrow('无效的章节编号')
  })
})
