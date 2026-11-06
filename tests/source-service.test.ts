import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { SourceStore } from '../src/main/services/network/sourceStore'
import { SourceService } from '../src/main/services/network/sourceService'
import { HttpClient } from '../src/main/services/network/httpClient'
import { LibraryRepository } from '../src/main/storage/library'

let root = ''
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'reader-source-service-')) })
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

describe('SourceService', () => {
  it('keeps object headers when building a parsed source', async () => {
    const store = new SourceStore(root)
    await store.importParsed([{
      definition: {
        bookSourceName: '源A',
        bookSourceUrl: 'https://example.com',
        searchUrl: '/s?q={{key}}',
        header: { 'User-Agent': 'ReaderTest/1.0', Referer: 'https://example.com' },
        ruleSearch: { bookList: '.b', name: '.n', bookUrl: '.l@href' },
        ruleToc: { chapterList: '.c', chapterName: 'a', chapterUrl: 'a@href' },
        ruleContent: { content: '#c' }
      },
      name: '源A',
      url: 'https://example.com',
      group: '',
      searchUrl: '/s?q={{key}}',
      header: {},
      customOrder: 0,
      compat: { level: 'full', issues: [] }
    }])

    const [item] = await store.listItems()
    const service = new SourceService(store, new HttpClient(), new LibraryRepository(root))
    const parsed = await service.require(item.id)
    expect(parsed.header).toEqual({
      'User-Agent': 'ReaderTest/1.0',
      Referer: 'https://example.com'
    })
  })
})
