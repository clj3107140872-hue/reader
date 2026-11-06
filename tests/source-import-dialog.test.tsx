import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import SourceImportDialog from '../src/renderer/src/components/SourceImportDialog'

describe('SourceImportDialog', () => {
  it('renders all three import methods and the unsupported warning', () => {
    const html = renderToStaticMarkup(
      <SourceImportDialog onClose={() => {}} onImported={() => {}} />
    )
    expect(html).toContain('粘贴 JSON')
    expect(html).toContain('选择文件')
    expect(html).toContain('从链接导入')
    expect(html).toContain('JS')
  })
})
