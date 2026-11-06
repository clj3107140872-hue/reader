import { describe, expect, it } from 'vitest'
import { INVOKE_CHANNELS } from '../src/preload/channels'

describe('preload IPC contract', () => {
  it('maps every network method to a channel', () => {
    for (const key of [
      'sourceList', 'importSources', 'setSourceFlags', 'sourceRaw', 'deleteSource',
      'searchNetwork', 'cancelNetworkSearch', 'addNetworkBook', 'updateToc',
      'downloadAll', 'cancelDownload', 'readNetworkChapter', 'convertToLocal'
    ] as const) {
      expect(INVOKE_CHANNELS[key], key).toMatch(/^(source|network):/)
    }
  })
})
