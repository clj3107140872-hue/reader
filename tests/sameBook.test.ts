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

function makeChapter(
  index: number,
  title: string,
  body: string,
  level: ChapterLevel = 'chapter'
): { meta: ChapterMeta; chapter: CleanedChapter } {
  const meta: ChapterMeta = {
    index,
    title,
    level,
    titleHash: chapterTitleHash(title),
    startLine: index,
    charCount: body.length,
    simhash: simhash64(body),
    flags: {}
  }
  return { meta, chapter: { title, level, startLine: index, paragraphs: [body] } }
}

function makeBook(
  id: string,
  titles: string[],
  bodyFor: (i: number) => string,
  levels?: ChapterLevel[]
) {
  const metas: ChapterMeta[] = []
  const chapters: CleanedChapter[] = []
  titles.forEach((title, i) => {
    const built = makeChapter(i, title, bodyFor(i), levels?.[i] ?? 'chapter')
    metas.push(built.meta)
    chapters.push(built.chapter)
  })
  const meta: BookMeta = { version: 1, id, title: id, encoding: 'utf8', chapters: metas, createdAt: '2026-01-01T00:00:00.000Z' }
  return { meta, chapters }
}

function metaWithVolume(id: string, volumeTitle: string, body: string): BookMeta {
  const volume = makeChapter(0, volumeTitle, '', 'volume')
  const chapter = makeChapter(1, '第一章', body)
  return {
    version: 1,
    id,
    title: id,
    encoding: 'utf8',
    chapters: [volume.meta, chapter.meta],
    createdAt: '2026-01-01T00:00:00.000Z'
  }
}

describe('normalizeBookTitle', () => {
  it('strips volume ranges, brackets, site names and quality tags', () => {
    expect(normalizeBookTitle('斗罗大陆_1-500章.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('《斗罗大陆》501-1000章 精校版.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('斗罗大陆[笔趣阁].txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('斗罗大陆１－５００章.txt')).toBe('斗罗大陆')
    expect(normalizeBookTitle('斗罗大陆第1-500章.txt')).toBe('斗罗大陆')
  })
})

describe('chapterMatchRate', () => {
  it('counts matching chapters by title and content', () => {
    const base = makeBook('a', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    const same = makeBook('b', ['第一章', '第二章'], (i) => `第${i}章的正文，内容足够长以便生成稳定的指纹。`)
    expect(chapterMatchRate(base.meta, same.meta)).toBe(1)
  })

  it('uses the smaller book as the denominator', () => {
    const body = '相同的正文内容，用来验证匹配率的分母。'
    const base = makeBook('a', ['第一章'], () => body)
    const other = makeBook('b', ['第一章', '第二章', '第三章'], (i) =>
      i === 0 ? body : `第${i}章的完全不同内容，不会与第一本书匹配。`
    )
    expect(chapterMatchRate(base.meta, other.meta)).toBe(1)
  })

  it('returns zero for unrelated books', () => {
    const base = makeBook('a', ['第一章'], () => '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着。')
    const other = makeBook('b', ['第一章'], () => '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中异常平静。')
    expect(chapterMatchRate(base.meta, other.meta)).toBe(0)
  })

  it('ignores volume headers when comparing content', () => {
    const base = metaWithVolume(
      'a',
      '第一卷 少年',
      '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着。'
    )
    const other = metaWithVolume(
      'b',
      '第一卷 少年',
      '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中异常平静。'
    )
    expect(chapterMatchRate(base, other)).toBe(0)
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
    const base =
      '重叠章节的正文内容足够长，用于验证去重逻辑，并且这一段文字会在另一份文件中出现几乎完全相同的版本，只是长度略有不同。'.repeat(4)
    const longer = base + '补充一句。'
    const first = makeBook('a', ['第一章', '第二章'], (i) => (i === 1 ? base : `第一册第${i}章正文`))
    const second = makeBook('b', ['第二章', '第三章'], (i) => (i === 0 ? longer : `第二册第${i}章正文`))
    const merged = planMerge(first, second)
    expect(merged.map((c) => c.title)).toEqual(['第一章', '第二章', '第三章'])
    expect(merged[1].paragraphs).toEqual([longer])
  })

  it('keeps both chapters when titles match but content differs', () => {
    const first = makeBook('a', ['第一章'], () => '第一本书里第一章的正文，内容和其他书完全不同。')
    const second = makeBook('b', ['第一章'], () => '另一本同名书的第一章，讲的是另一个完全不同的故事。')
    const merged = planMerge(first, second)
    expect(merged).toHaveLength(2)
  })

  it('keeps numeric order when the book starts with a preface', () => {
    const later = makeBook('a', ['前言', '第三章', '第四章'], (i) => `后一册的正文${i}`)
    const earlier = makeBook('b', ['第一章', '第二章'], (i) => `前一册的正文${i}`)
    const merged = planMerge(later, earlier)
    expect(merged.map((c) => c.title)).toEqual(['前言', '第一章', '第二章', '第三章', '第四章'])
  })

  it('keeps volumes together when chapter numbers restart', () => {
    const later = makeBook(
      'a',
      ['第二卷 崛起', '第一章', '第二章'],
      (i) => `林动在第二卷的故事${i}里抬头望向天空，远处山峦起伏。`,
      ['volume', 'chapter', 'chapter']
    )
    const earlier = makeBook(
      'b',
      ['第一卷 少年', '第一章', '第二章'],
      (i) => `萧炎在第一卷的故事${i}里站在广场中央，四周的族人议论纷纷。`,
      ['volume', 'chapter', 'chapter']
    )
    const merged = planMerge(later, earlier)
    expect(merged.map((c) => c.title)).toEqual([
      '第一卷 少年',
      '第一章',
      '第二章',
      '第二卷 崛起',
      '第一章',
      '第二章'
    ])
  })
})
