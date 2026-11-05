import { describe, expect, it } from 'vitest'
import {
  dedupeCrossChapterParagraphs,
  markDuplicateChapters,
  removeDuplicateChapters
} from '../src/core/dedupe'
import { simhash64 } from '../src/core/text'

const textA = '萧炎站在广场中央，四周的族人议论纷纷，他的拳头紧紧握着，指甲几乎嵌入掌心。'
const textB = '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中却异常平静。'

describe('markDuplicateChapters', () => {
  it('flags later chapters with identical content and title', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length }
    ])
    expect(flags).toEqual([false, true])
  })

  it('flags near-identical content even when titles differ', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'bbb', simhash: simhash64(textA), charCount: textA.length }
    ])
    expect(flags).toEqual([false, true])
  })

  it('does not flag genuinely different chapters', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'bbb', simhash: simhash64(textB), charCount: textB.length }
    ])
    expect(flags).toEqual([false, false])
  })

  it('does not flag chapters with very different lengths', () => {
    const flags = markDuplicateChapters([
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length },
      { titleHash: 'aaa', simhash: simhash64(textA), charCount: textA.length * 3 }
    ])
    expect(flags).toEqual([false, false])
  })
})

const longDuplicate =
  '这是一段超过五十个字的重复正文，用来验证同书合并时跨章节的完全相同段落只保留一次，避免分卷重叠造成重复阅读。'
const shortDuplicate = '短句。'

const fullBody = [
  '【彼岸】第六层。初圣端坐其中，显化道主真身，一圈又一圈时光之环堆砌，映照无数身形，最后汇作一道巍峨光影。',
  '而在那道光影的背后，一条脐带般的大道深入虚瞑，和茫茫混沌共鸣，榨取养分，一呼一吸间都有无穷伟力加持在他的身上。',
  '初圣心中盘算，千年过后，他就能重归彼岸第七层，这个时间说不上长，但真算起来也不短了，毕竟时局变化太快。'
]
const abridgedBody = [fullBody[0], fullBody[1], '初圣心中盘算，千年过后，他就能重归彼岸第七层。']
const otherBody = [
  '林动抬头望向天空，那里有云层翻涌，远处山峦起伏，他的心中却异常平静，像是暴风雨前最后的宁静。',
  '他缓缓闭上眼睛，感受着体内元力流转，那些曾经遥不可及的境界，如今似乎只隔着一层薄薄的窗户纸。'
]

describe('removeDuplicateChapters', () => {
  it('drops a same-titled copy whose body is mostly contained in a longer one', () => {
    const result = removeDuplicateChapters([
      { title: '第12章 风起', level: 'chapter', startLine: 0, paragraphs: fullBody },
      { title: '第12章 风起', level: 'chapter', startLine: 9, paragraphs: abridgedBody }
    ])
    expect(result.removed).toBe(1)
    expect(result.chapters).toEqual([
      { title: '第12章 风起', level: 'chapter', startLine: 0, paragraphs: fullBody }
    ])
  })

  it('drops an empty same-titled placeholder left by an overlapping source file', () => {
    const result = removeDuplicateChapters([
      { title: '第12章 风起', level: 'chapter', startLine: 0, paragraphs: fullBody },
      { title: '第12章 风起', level: 'chapter', startLine: 9, paragraphs: ['(内容为空)'] }
    ])
    expect(result.removed).toBe(1)
    expect(result.chapters).toHaveLength(1)
  })

  it('keeps same-titled chapters whose bodies are different', () => {
    const result = removeDuplicateChapters([
      { title: '番外', level: 'chapter', startLine: 0, paragraphs: fullBody },
      { title: '番外', level: 'chapter', startLine: 9, paragraphs: otherBody }
    ])
    expect(result.removed).toBe(0)
    expect(result.chapters).toHaveLength(2)
  })

  it('leaves volumes alone', () => {
    const result = removeDuplicateChapters([
      { title: '第一卷 风起', level: 'volume', startLine: 0, paragraphs: fullBody },
      { title: '第一卷 风起', level: 'volume', startLine: 9, paragraphs: abridgedBody }
    ])
    expect(result.removed).toBe(0)
    expect(result.chapters).toHaveLength(2)
  })
})

describe('dedupeCrossChapterParagraphs', () => {
  it('keeps only the first copy of a long paragraph repeated across chapters', () => {
    const result = dedupeCrossChapterParagraphs([
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: [longDuplicate, '第一章正文。'] },
      { title: '第二章', level: 'chapter', startLine: 3, paragraphs: [longDuplicate, '第二章正文。'] }
    ])
    expect(result.chapters[1].paragraphs).toEqual(['第二章正文。'])
    expect(result.removed).toBe(1)
  })

  it('leaves short repeated paragraphs alone', () => {
    const result = dedupeCrossChapterParagraphs([
      { title: '第一章', level: 'chapter', startLine: 0, paragraphs: [shortDuplicate] },
      { title: '第二章', level: 'chapter', startLine: 2, paragraphs: [shortDuplicate] }
    ])
    expect(result.chapters[1].paragraphs).toEqual([shortDuplicate])
    expect(result.removed).toBe(0)
  })
})
