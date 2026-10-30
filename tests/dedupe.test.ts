import { describe, expect, it } from 'vitest'
import { dedupeCrossChapterParagraphs, markDuplicateChapters } from '../src/core/dedupe'
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
