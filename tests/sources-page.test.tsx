import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Sources from '../src/renderer/src/pages/Sources'
import { DEFAULT_SETTINGS } from '../src/shared/settings'

describe('Sources page', () => {
  it('renders the two network settings checkboxes from the app settings', () => {
    const html = renderToStaticMarkup(
      <Sources
        settings={{ ...DEFAULT_SETTINGS, network: { enabled: false, autoCheckOnOpen: true } }}
        onSettingsChange={() => {}}
        onBack={() => {}}
      />
    )
    expect(html).toContain('网络设置')
    expect(html).toContain('打开网络书时自动检查更新')
    const enabled = html.match(/<input type="checkbox"([^>]*)>允许联网/)
    const autoCheck = html.match(/<input type="checkbox"([^>]*)>打开网络书时自动检查更新/)
    expect(enabled?.[1] ?? '').not.toContain('checked')
    expect(autoCheck?.[1] ?? '').toContain('checked')
  })
})
