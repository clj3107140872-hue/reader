import { describe, expect, it } from 'vitest'
import { errorText } from '../src/renderer/src/errors'

describe('errorText', () => {
  it('keeps known application messages after stripping the IPC wrapper', () => {
    expect(
      errorText(
        new Error("Error invoking remote method 'book:open': Error: 找不到这本书，可能已被删除")
      )
    ).toBe('找不到这本书，可能已被删除')
  })

  it('does not pass unrelated messages that merely contain 找不到', () => {
    expect(errorText(new Error('找不到临时目录'))).toBe('操作失败，请稍后重试')
  })

  it('keeps network and source-import messages added by the final fix wave', () => {
    expect(errorText(new Error('《源A》拒绝访问（403），可能需要登录或更换书源'))).toContain('拒绝访问')
    expect(errorText(new Error('《源A》站点暂时不可用（503），请稍后再试'))).toContain('站点暂时不可用')
    expect(
      errorText(new Error('转为本地书失败，原书快照已保留在 .convert 目录，请稍后重试'))
    ).toContain('.convert')
    expect(errorText(new Error('目录获取失败，换一个书源试试'))).toBe('目录获取失败，换一个书源试试')
    expect(errorText(new Error('只支持书源分享链接（legado://import/bookSource）'))).toContain(
      'legado://'
    )
  })
})
