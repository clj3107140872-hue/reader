import { describe, expect, it } from 'vitest'
import {
  chapterMatchRate,
  normalizeBookTitle,
  planMerge,
  shouldSuspectSameBook
} from '../src/core/sameBook'
import { chapterTitleHash } from '../src/core/chapters'
import { simhash64 } from '../src/core/text'
import type { BookMeta, ChapterMeta, CleanedChapter } from '../src/core/model'

function makeChapter(index: number, title: string, body: string): { meta: ChapterMeta; chapter: CleanedChapter } {
  const meta: ChapterMeta = {
    index,
    title,
    level: 'chapter',
    titleHash: chapterTitleHash(title),
    startLine: index,
    charCount: body.length,
    simhash: simhash64(body),
    flags: {}
  }
  return { meta, chapter: { title, level: 'chapter', startLine: index, paragraphs: [body] } }
}

function makeBook(id: string, titles: string[], bodyFor: (i: number) => string) {
  const metas: ChapterMeta[] = []
  const chapters: CleanedChapter[] = []
  titles.forEach((title, i) => {
    const built = makeChapter(i, title, bodyFor(i))
    metas.push(built.meta)
    chapters.push(built.chapter)
  })
  const meta: BookMeta = { version: 1, id, title: id, encoding: 'utf8', chapters: metas, createdAt: '2026-01-01T00:00:00.000Z' }
  return { meta, chapters }
}

describe('normalizeBookTitle', () => {
  it('strips volume ranges, brackets, site names and quality tags', () => {
    expect(normalizeBookTitle('斗罗大陆_1-500章.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('《斗罗大陆》501-1000章 精校版.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('斗罗大陆[笔趣阁].txt')).toBe('斗罗大陆')
  })
})

describe('chapterMatchRate', () => {
  it('counts matching chapters by title and content', () => {
    const base = makeBook('a', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    const same = makeBook('b', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    expect(chapterMatchRate(base.meta, same.meta)).toBe(1)
  })

  it('returns zero for unrelated books', () => {
    const base = makeBook('a', ['第一章'], () => '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着。')
    const other = makeBook('b', ['第一章'], () => '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中异常平静。')
    expect(chapterMatchRate(base.meta, other.meta)).toBe(0)
  })
})

describe('shouldSuspectSameBook', () => {
  it('suspects by normalized title even without overlapping chapters', () => {
    const first = makeBook('a', ['第一章'], (i) => `第一册内容${i}`)
    const second = makeBook('b', ['第五百零一章'], () => '第二册内容，和第一册没有重叠章节。')
    expect(shouldSuspectSameBook('斗罗大陆', second.meta, '斗罗大陆', first.meta)).toBe(true)
  })

  it('suspects unrelated titles when content overlaps heavily', () => {
    const first = makeBook('a', ['第一章'], (i) => `相同的正文内容${i}，用于指纹匹配。`)
    const second = makeBook('b', ['第一章'], (i) => `相同的正文内容${i}，用于指纹匹配。`)
    expect(shouldSuspectSameBook('甲书', second.meta, '乙书', first.meta)).toBe(true)
  })

  it('does not suspect unrelated titles and content', () => {
    const first = makeBook('a', ['第一章'], () => '萧炎站在广场中央，四周的族人议论纷纷。')
    const second = makeBook('b', ['第一章'], () => '林动抬头望向天空，那里有云层翻涌。')
    expect(shouldSuspectSameBook('甲书', second.meta, '乙书', first.meta)).toBe(false)
  })
})

describe('planMerge', () => {
  it('merges non-overlapping volume ranges in numeric order', () => {
    const first = makeBook('a', ['第一章', '第二章'], (i) => `第一册第${i}章正文`)
    const second = makeBook('b', ['第三章', '第四章'], (i) => `第二册第${i}章正文`)
    const merged = planMerge(first, second)
    expect(merged.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章', '第四章'])
  })

  it('deduplicates overlapping chapters and keeps the longer copy', () => {
    const body = '重叠章节的正文内容足够长，用于验证去重逻辑。'
    const first = makeBook('a', ['第一章', '第二章'], (i) => (i === 1 ? body : `第一册第${i}章正文`))
    const second = makeBook('b', ['第二章', '第三章'], (i) => (i === 0 ? body : `第二册第${i}章正文`))
    const merged = planMerge(first, second)
    expect(merged.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章'])
  })

  it('keeps both chapters when titles match but content differs', () => {
    const first = makeBook('a', ['第一章'], () => '第一本书里第一章的正文，内容和其他书完全不同。')
    const second = makeBook('b', ['第一章'], () => '另一本同名书的第一章，讲的是另一个完全不同的故事。')
    const merged = planMerge(first, second)
    expect(merged).toHaveLength(2)
  })
})
