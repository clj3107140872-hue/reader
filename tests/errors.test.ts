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
})
