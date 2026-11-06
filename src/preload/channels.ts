import type { ReaderApi } from '../shared/api'

export const INVOKE_CHANNELS = {
  sourceList: 'source:list',
  importSources: 'source:import',
  setSourceFlags: 'source:flags',
  sourceRaw: 'source:raw',
  deleteSource: 'source:delete',
  searchNetwork: 'network:search',
  cancelNetworkSearch: 'network:search-cancel',
  addNetworkBook: 'network:add-book',
  updateToc: 'network:update-toc',
  downloadAll: 'network:download-all',
  cancelDownload: 'network:download-cancel',
  readNetworkChapter: 'network:read-chapter',
  convertToLocal: 'network:convert'
} satisfies Partial<Record<keyof ReaderApi, string>>
