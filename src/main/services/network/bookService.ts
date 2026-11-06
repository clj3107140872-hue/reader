import { createHash, randomUUID } from 'node:crypto'
import { promises as fs } from 'node:fs'
import { join } from 'node:path'
import { cleanChapters } from '../../../core/cleaning'
import type { CleaningRunConfig } from '../../../core/cleaning'
import { buildBookDocuments } from '../../../core/compose'
import { downloadState, networkCacheFor } from '../../../core/booksource/quality'
import type {
  DownloadDone,
  DownloadFailedChapter,
  DownloadProgress,
  TocChapter,
  UpdateTocResult
} from '../../../core/booksource/model'
import type { ParsedBookInfo } from '../../../core/booksource/parse'
import { diffToc } from '../../../core/booksource/toc'
import type { BookMeta, ChapterMeta, CleanedChapter, LibraryEntry } from '../../../core/model'
import { chapterTitleHash } from '../../../core/chapters'
import { buildChapterMetas } from '../../../core/pipeline'
import { normalizeBookTitle } from '../../../core/sameBook'
import type {
  AddNetworkBookInput,
  AddNetworkBookResult,
  ConvertToLocalResult
} from '../../../shared/api'
import type { BookRepository } from '../../storage/book'
import type { LibraryRepository } from '../../storage/library'
import type { NetworkBookRepository } from '../../storage/networkBook'
import { assertBookId } from '../../bookId'
import { userFacingNetworkError } from './errors'
import type { SourceReader } from './sourceReader'
import type { SourceService } from './sourceService'
import type { OperationOutcome, SourceOperation } from './sourceStore'
import { KeyedLocks, Semaphore } from './limits'

type FetchOrigin = 'read' | 'download'

export interface NetworkBookDeps {
  root: string
  sources: SourceService
  reader: SourceReader
  networkBooks: NetworkBookRepository
  books: BookRepository
  library: LibraryRepository
  cleaning: () => CleaningRunConfig
  /** False when the user turned networking off; cached chapters stay readable. */
  allowNetwork?: () => boolean
}

function safeFileName(title: string): string {
  const base = title.replace(/[\\/:*?"<>|\r\n]/g, '_').trim().slice(0, 80) || '网络书'
  return `${base}.txt`
}

function cancellationError(reason?: 'source-deleted' | 'source-disabled'): Error {
  if (reason === 'source-deleted') return new Error('书源已删除')
  if (reason === 'source-disabled') return new Error('书源已停用')
  return new Error('更新目录已取消')
}

function chapterFromToc(
  title: string,
  url: string,
  level: 'chapter' | 'volume',
  index: number
): ChapterMeta {
  return {
    index,
    title,
    level,
    titleHash: chapterTitleHash(title),
    startLine: 0,
    charCount: 0,
    simhash: '',
    flags: {},
    ...(url ? { url } : {})
  }
}

export class NetworkBookService {
  readonly sources: SourceService
  private readonly reader: SourceReader
  private readonly networkBooks: NetworkBookRepository
  private readonly books: BookRepository
  private readonly library: LibraryRepository
  private readonly cleaning: () => CleaningRunConfig
  private readonly allowNetwork: () => boolean
  private readonly root: string
  private readonly locks = new KeyedLocks()
  /**
   * 并发模型（spec 8.1 / 8.3）：读章全局 6、下载全局 4，每本书读写合计 2，
   * 下载请求同一书源再限 2。获取顺序固定为
   *   读章：globalRead -> perBook
   *   下载：globalDownload -> perBook -> perSource
   * 两种来源共用 perBook，且都先拿全局再拿书级，所以不会形成等待环；
   * 交互阅读只受每本书 2 个的限制，不会排在下载队列后面。
   */
  private readonly readSemaphore = new Semaphore(6)
  private readonly downloadSemaphore = new Semaphore(4)
  private readonly bookSemaphores = new Map<string, Semaphore>()
  private readonly sourceSemaphores = new Map<string, Semaphore>()
  private readonly chapterRequests = new Map<
    string,
    Promise<{ text: string; warnings: string[] }>
  >()
  /** 同一个 sourceId + bookUrl 的并发加入复用同一个请求。 */
  private readonly addRequests = new Map<string, Promise<AddNetworkBookResult>>()
  private readonly converting = new Set<string>()
  /** 正在拉取目录请求的 controller，删除/停用书源时按书中止。 */
  private readonly tocControllers = new Map<string, AbortController>()
  /** 目录请求被书源级取消时的原因；普通中止（如删书）不写这里。 */
  private readonly tocCancelReasons = new Map<string, 'source-deleted' | 'source-disabled'>()
  private readonly downloadJobs = new Map<
    string,
    {
      controller: AbortController
      done: Promise<unknown>
      /** 书源被删除/停用时记录原因，用于把剩余章节记为失败。 */
      reason?: 'source-deleted' | 'source-disabled'
    }
  >()

  constructor(deps: NetworkBookDeps) {
    this.root = deps.root
    this.sources = deps.sources
    this.reader = deps.reader
    this.networkBooks = deps.networkBooks
    this.books = deps.books
    this.library = deps.library
    this.cleaning = deps.cleaning
    this.allowNetwork = deps.allowNetwork ?? (() => true)
  }

  private ensureNetwork(): void {
    if (!this.allowNetwork()) {
      throw new Error('已关闭联网功能，请到设置里打开后再搜索/更新/下载')
    }
  }

  private semaphoreFor(map: Map<string, Semaphore>, key: string): Semaphore {
    let semaphore = map.get(key)
    if (!semaphore) {
      semaphore = new Semaphore(2)
      map.set(key, semaphore)
    }
    return semaphore
  }

  /** 全局配额先于每本书配额获取，避免两种来源交错拿锁形成等待环。 */
  private withFetchGates<T>(
    id: string,
    origin: FetchOrigin,
    task: () => Promise<T>
  ): Promise<T> {
    const global = origin === 'download' ? this.downloadSemaphore : this.readSemaphore
    return global.run(() => this.semaphoreFor(this.bookSemaphores, id).run(task))
  }

  private recordOperation(
    sourceId: string,
    operation: SourceOperation,
    outcome: OperationOutcome,
    started: number,
    message?: string
  ): Promise<void> {
    return this.sources
      .recordOperation(sourceId, operation, outcome, Date.now() - started, message)
      .catch(() => undefined)
  }

  /** spec 7.6：同一 sourceId + bookUrl 已存在时直接返回书架条目。 */
  private async findShelfBook(sourceId: string, bookUrl: string): Promise<LibraryEntry | null> {
    for (const entry of await this.library.list()) {
      if (entry.format !== 'network' || entry.sourceId !== sourceId) continue
      if (entry.bookUrl === bookUrl) return entry
      if (!entry.bookUrl) {
        // 旧条目没有 bookUrl，退回书籍元数据匹配。
        try {
          const meta = await this.networkBooks.readMeta(entry.id)
          if (meta.network?.bookUrl === bookUrl) return entry
        } catch {
          // 损坏的书不参与查重。
        }
      }
    }
    return null
  }

  async add(input: AddNetworkBookInput): Promise<AddNetworkBookResult> {
    this.ensureNetwork()
    const existing = await this.findShelfBook(input.sourceId, input.bookUrl)
    if (existing) return { entry: existing, warnings: [] }
    const key = `${input.sourceId}|${input.bookUrl}`
    const running = this.addRequests.get(key)
    if (running) return running
    const request = this.addOnce(input)
    this.addRequests.set(key, request)
    try {
      return await request
    } finally {
      if (this.addRequests.get(key) === request) this.addRequests.delete(key)
    }
  }

  private async addOnce(input: AddNetworkBookInput): Promise<AddNetworkBookResult> {
    const source = await this.sources.require(input.sourceId)
    const warnings: string[] = []
    const infoStarted = Date.now()
    let info: ParsedBookInfo & { bookUrl: string }
    try {
      info = await this.reader.info(source, input.bookUrl)
      await this.recordOperation(
        input.sourceId,
        'info',
        info.title ? 'success' : 'empty',
        infoStarted
      )
    } catch (error) {
      // spec 7.6：书信息失败不阻断加入，书名/作者等用搜索结果补齐，缺失留空。
      const message = userFacingNetworkError(error, source.name)
      console.warn(`[network] 书籍信息获取失败，已用搜索结果补齐（${source.name}）：${message}`)
      await this.recordOperation(input.sourceId, 'info', 'error', infoStarted, message)
      warnings.push(`书籍信息获取失败，已用搜索结果补齐：${message}`)
      info = {
        title: input.title?.trim() ?? '',
        author: input.author?.trim() ?? '',
        kind: input.kind?.trim() ?? '',
        intro: input.intro?.trim() ?? '',
        coverUrl: '',
        lastChapter: input.lastChapter?.trim() ?? '',
        tocUrl: input.bookUrl,
        bookUrl: input.bookUrl
      }
    }
    const title = (info.title || input.title || '').trim()
    if (!title) throw new Error('没有从书源拿到书名')
    const tocStarted = Date.now()
    let toc
    try {
      toc = await this.reader.toc(source, {
        bookUrl: info.bookUrl,
        tocUrl: info.tocUrl || info.bookUrl
      })
    } catch (error) {
      await this.recordOperation(
        input.sourceId,
        'toc',
        'error',
        tocStarted,
        userFacingNetworkError(error, source.name)
      )
      throw new Error('目录获取失败，换一个书源试试')
    }
    await this.recordOperation(
      input.sourceId,
      'toc',
      toc.chapters.length > 0 ? 'success' : 'empty',
      tocStarted
    )
    warnings.push(...toc.warnings)
    const chapters = toc.chapters.map((chapter, index) =>
      chapterFromToc(chapter.title, chapter.url, chapter.level, index)
    )
    if (chapters.length === 0) throw new Error('目录获取失败，换一个书源试试')
    const contentChapterCount = chapters.filter(
      (chapter) => chapter.level !== 'volume' && chapter.url
    ).length
    if (contentChapterCount === 0) throw new Error('书源没有返回可读章节')
    const author = (info.author || input.author || '').trim()
    const intro = (info.intro || input.intro || '').trim()
    const kind = (info.kind || input.kind || '').trim()
    const lastChapter = (info.lastChapter || input.lastChapter || '').trim()
    const id = randomUUID()
    const now = new Date().toISOString()
    const meta: BookMeta = {
      version: 1,
      id,
      title,
      encoding: 'utf-8',
      format: 'network',
      chapters,
      createdAt: now,
      ...(author ? { author } : {}),
      ...(intro ? { intro } : {}),
      ...(kind ? { kind } : {}),
      network: {
        sourceId: input.sourceId,
        sourceUrl: source.url,
        sourceName: source.name,
        bookUrl: info.bookUrl,
        tocUrl: info.tocUrl || info.bookUrl,
        ...(lastChapter ? { lastChapter } : {}),
        lastTocAt: now,
        lastCheckAt: now,
        lastDownloadAt: null
      }
    }
    await this.networkBooks.create(meta)
    // v1 不下载网络封面：封面区显示书名首字，避免引入二进制响应处理。
    const entry: LibraryEntry = {
      id,
      title,
      format: 'network',
      ...(meta.author ? { author: meta.author } : {}),
      ...(meta.intro ? { intro: meta.intro } : {}),
      ...(meta.kind ? { kind: meta.kind } : {}),
      sourceId: input.sourceId,
      sourceName: source.name,
      bookUrl: input.bookUrl,
      normalizedTitle: normalizeBookTitle(safeFileName(title)),
      sourceFileName: safeFileName(title),
      fileHash: createHash('sha256').update(`network:${input.sourceId}:${input.bookUrl}`).digest('hex'),
      encoding: 'utf-8',
      importedAt: now,
      lastReadAt: null,
      chapterCount: chapters.length,
      progressPercent: 0,
      stats: {
        adLinesRemoved: 0,
        duplicateParagraphsMerged: 0,
        suspectedDuplicateChapters: 0
      },
      networkCache: { cached: 0, total: contentChapterCount },
      downloadState: 'none',
      lastUpdateAt: now
    }
    await this.library.add(entry)
    return { entry, warnings }
  }

  async readChapter(
    id: string,
    index: number,
    origin: FetchOrigin = 'read'
  ): Promise<{ text: string; cached: boolean; warnings?: string[] }> {
    assertBookId(id)
    if (this.converting.has(id)) throw new Error('正在转为本地书，请稍候')
    if (!Number.isInteger(index) || index < 0) throw new Error('章节不存在')
    const cached = await this.networkBooks.readChapterText(id, index)
    if (cached) return { text: cached, cached: true }
    // spec 8.1：卷标题没有正文，在联网检查和任何并发配额之前直接返回。
    const initial = await this.networkBooks.readMeta(id)
    if (initial.format !== 'network' || !initial.network) throw new Error('这不是网络书')
    const initialChapter = initial.chapters[index]
    if (!initialChapter) throw new Error('章节不存在')
    if (initialChapter.level === 'volume') return { text: '', cached: true }
    this.ensureNetwork()
    const key = `${id}:${index}`
    const existing = this.chapterRequests.get(key)
    if (existing) {
      const result = await existing
      return {
        text: result.text,
        cached: false,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
      }
    }
    const request = this.locks.run(key, () =>
      this.withFetchGates(id, origin, async () => {
        const again = await this.networkBooks.readChapterText(id, index)
        if (again) return { text: again, warnings: [] }
        // 这个请求可能在外层检查之后才登记到 chapterRequests，转换开始前
        // 再查一次，避免转换期间往旧目录写章节。
        if (this.converting.has(id)) throw new Error('正在转为本地书，请稍候')
        const meta = await this.networkBooks.readMeta(id)
        if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
        const chapter = meta.chapters[index]
        if (!chapter) throw new Error('章节不存在')
        if (chapter.level === 'volume') return { text: '', warnings: [] }
        if (!chapter.url) throw new Error('这一章没有正文地址')
        const sourceId = meta.network.sourceId
        const source = await this.sources.require(sourceId)
        const started = Date.now()
        const fetchOnce = (): Promise<{ text: string; warnings: string[] }> =>
          this.reader.content(source, {
            chapterUrl: chapter.url!,
            chapterName: chapter.title,
            bookUrl: meta.network!.bookUrl
          })
        let content: { text: string; warnings: string[] }
        try {
          // 下载时同一书源再限 2 个请求；交互阅读不占书源配额。
          content =
            origin === 'download'
              ? await this.semaphoreFor(this.sourceSemaphores, sourceId).run(fetchOnce)
              : await fetchOnce()
        } catch (error) {
          const message = userFacingNetworkError(error, source.name)
          await this.recordOperation(sourceId, 'content', 'error', started, message)
          throw new Error(message)
        }
        await this.recordOperation(
          sourceId,
          'content',
          content.text.trim() ? 'success' : 'empty',
          started
        )
        if (!content.text.trim()) throw new Error('书源返回了空正文')
        const warnings = [...content.warnings]
        const cleaning = this.cleaning()
        const cleaned = cleanChapters(
          [
            {
              title: chapter.title,
              level: 'chapter',
              startLine: 0,
              paragraphs: content.text.split(/\n{2,}/)
            }
          ],
          cleaning.rules,
          { adCleaning: cleaning.adCleaning }
        ).chapters[0]
        let text = cleaned.paragraphs.join('\n\n')
        if (!text.trim()) {
          // spec 8.1：整章都被清洗规则移除时保留原文；缓存文件不能为空，
          // 否则这一章永远算未缓存，下载无法完成、转本地也会被卡住。
          text = content.text.trim()
          warnings.push('清洗后正文为空，已回退显示原始正文')
        }
        await this.networkBooks.writeChapter(id, index, content.text, text)
        const info = await this.cacheInfo(id, meta)
        await this.library.update(id, {
          networkCache: info,
          downloadState: downloadState(info.cached, info.total)
        })
        return { text, warnings }
      })
    )
    this.chapterRequests.set(key, request)
    try {
      const result = await request
      return {
        text: result.text,
        cached: false,
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {})
      }
    } finally {
      this.chapterRequests.delete(key)
    }
  }

  async convertToLocal(id: string): Promise<ConvertToLocalResult> {
    assertBookId(id)
    if (this.converting.has(id)) throw new Error('正在转为本地书，请稍候')
    this.converting.add(id)
    this.cancelBookTasks(id)
    try {
      // 等正在读的章节落盘；之后新的读章请求会被 converting 挡住。
      const pendingReads = [...this.chapterRequests.entries()]
        .filter(([key]) => key.startsWith(`${id}:`))
        .map(([, request]) => request.catch(() => undefined))
      await Promise.all(pendingReads)

      return await this.locks.run(`book:${id}`, async () => {
        const meta = await this.networkBooks.readMeta(id)
        if (meta.format !== 'network') throw new Error('这本书已经是本地书')
        const cache = await this.cacheInfo(id, meta)
        if (cache.total === 0 || cache.cached < cache.total) {
          throw new Error('未下载全本，无法转为本地书')
        }
        const progress = await this.books.readProgress(id)
        const entry = await this.entryFor(id)
        const bookDir = join(this.root, 'books', id)
        const snapshot = join(this.root, '.convert', `${id}-${Date.now()}`)
        const warnings: string[] = []
        let writeStarted = false
        let keepSnapshot = false
        try {
          await fs.mkdir(join(this.root, '.convert'), { recursive: true })
          await fs.cp(bookDir, snapshot, { recursive: true })
          // spec 8.4：source.txt 每章都写标题行（即使本地切章器不认识这个
          // TOC 标题），再写 raw 段落，章间空行；卷章节只写标题。
          const sourceChapters: CleanedChapter[] = []
          const cleanedChapters: CleanedChapter[] = []
          const sourceLines: string[] = []
          let line = 0
          for (const chapter of meta.chapters) {
            const startLine = line
            sourceLines.push(chapter.title)
            line++
            if (chapter.level === 'volume') {
              sourceLines.push('')
              line++
              const volume: CleanedChapter = {
                title: chapter.title,
                level: 'volume',
                startLine,
                paragraphs: []
              }
              sourceChapters.push(volume)
              cleanedChapters.push({ ...volume })
              continue
            }
            const raw = await this.networkBooks.readRawChapter(id, chapter.index)
            const cleaned = (await this.networkBooks.readChapterText(id, chapter.index)) ?? ''
            if (!raw) {
              warnings.push(`第 ${chapter.index + 1} 章《${chapter.title}》缺少原始正文，已用清洗后正文替代`)
            }
            const sourceParagraphs = (raw ?? cleaned)
              .split(/\r?\n/)
              .map((part) => part.trim())
              .filter(Boolean)
            if (sourceParagraphs[0] === chapter.title) sourceParagraphs.shift()
            for (const paragraph of sourceParagraphs) {
              sourceLines.push(paragraph, '')
              line += 2
            }
            sourceChapters.push({
              title: chapter.title,
              level: chapter.level,
              startLine,
              paragraphs: sourceParagraphs
            })
            cleanedChapters.push({
              title: chapter.title,
              level: chapter.level,
              startLine,
              paragraphs: cleaned.split(/\n{2,}/).map((part) => part.trim()).filter(Boolean)
            })
          }

          // startLine 与 source.txt 由上面的显式拼装保证一致；charCount/
          // simhash 必须用清洗后正文，保证同书合并与重复章节检测正常。
          const documents = buildBookDocuments({
            id,
            title: meta.title,
            encoding: 'utf-8',
            createdAt: meta.createdAt,
            chapters: sourceChapters,
            sourceText: sourceLines.join('\n'),
            format: 'txt',
            ...(meta.author ? { author: meta.author } : {}),
            ...(meta.cover ? { cover: meta.cover } : {})
          })
          const cleanedMetas = buildChapterMetas(cleanedChapters)
          const localMeta: BookMeta = {
            ...documents.meta,
            chapters: documents.meta.chapters.map((chapter, index) => ({
              ...chapter,
              charCount: cleanedMetas[index].charCount,
              simhash: cleanedMetas[index].simhash,
              flags: cleanedMetas[index].flags
            })),
            ...(meta.intro ? { intro: meta.intro } : {}),
            ...(meta.kind ? { kind: meta.kind } : {})
          }

          writeStarted = true
          await this.books.writeBook(
            { meta: localMeta, sourceText: documents.sourceText, chapters: cleanedChapters },
            { backup: false }
          )
          await this.books.writeProgress(id, progress)
          await this.library.update(id, {
            format: 'txt',
            sourceId: undefined,
            bookUrl: undefined,
            networkCache: undefined,
            downloadState: undefined,
            stats: {
              ...entry.stats,
              suspectedDuplicateChapters: localMeta.chapters.filter(
                (chapter) => chapter.flags.suspectedDuplicate
              ).length
            }
          })
          return {
            id,
            chapterCount: localMeta.chapters.length,
            warnings
          }
        } catch (reason) {
          // writeBook 会删掉原网络书目录；快照是唯一副本，恢复失败时必须保留。
          if (writeStarted) {
            try {
              await fs.rm(bookDir, { recursive: true, force: true })
              await fs.rename(snapshot, bookDir)
            } catch {
              keepSnapshot = true
              throw new Error('转为本地书失败，原书快照已保留在 .convert 目录，请稍后重试')
            }
          }
          throw reason
        } finally {
          if (!keepSnapshot) await fs.rm(snapshot, { recursive: true, force: true })
        }
      })
    } finally {
      this.converting.delete(id)
    }
  }

  async updateToc(id: string): Promise<UpdateTocResult> {
    assertBookId(id)
    this.ensureNetwork()
    return this.locks.run(`book:${id}`, async () => {
      const meta = await this.networkBooks.readMeta(id)
      if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
      const source = await this.sources.require(meta.network.sourceId)
      const controller = new AbortController()
      this.tocControllers.set(id, controller)
      try {
        const tocStarted = Date.now()
        let toc: { chapters: TocChapter[]; warnings: string[] }
        try {
          toc = await this.reader.toc(
            source,
            {
              bookUrl: meta.network.bookUrl,
              tocUrl: meta.network.tocUrl
            },
            controller.signal
          )
        } catch (error) {
          // 用户取消或书源被删除/停用不算书源失败，不写统计。
          if (controller.signal.aborted || this.tocCancelReasons.has(id)) {
            throw cancellationError(this.tocCancelReasons.get(id))
          }
          const message = userFacingNetworkError(error, source.name)
          await this.recordOperation(meta.network.sourceId, 'toc', 'error', tocStarted, message)
          throw new Error(message)
        }
        if (controller.signal.aborted || this.tocCancelReasons.has(id)) {
          throw cancellationError(this.tocCancelReasons.get(id))
        }
        await this.recordOperation(
          meta.network.sourceId,
          'toc',
          toc.chapters.length > 0 ? 'success' : 'empty',
          tocStarted
        )
        const previousCount = meta.chapters.length
        const result = diffToc(meta.chapters, toc.chapters)
        meta.chapters = result.chapters
        meta.network.lastTocAt = new Date().toISOString()
        meta.network.lastCheckAt = meta.network.lastTocAt
        if (result.lastChapter) meta.network.lastChapter = result.lastChapter
        await this.networkBooks.writeMeta(id, meta)
        const cache = await this.cacheInfo(id, meta)
        const addedContent = result.chapters
          .slice(previousCount)
          .some((chapter) => chapter.level !== 'volume')
        await this.library.update(id, {
          chapterCount: meta.chapters.length,
          networkCache: cache,
          downloadState: downloadState(cache.cached, cache.total),
          ...(addedContent ? { lastUpdateAt: meta.network.lastTocAt } : {})
        })
        return {
          added: result.added,
          total: meta.chapters.length,
          warnings: toc.warnings,
          ...(result.lastChapter ? { lastChapter: result.lastChapter } : {})
        }
      } catch (error) {
        if (this.tocCancelReasons.has(id)) {
          throw cancellationError(this.tocCancelReasons.get(id))
        }
        throw error
      } finally {
        if (this.tocControllers.get(id) === controller) this.tocControllers.delete(id)
        this.tocCancelReasons.delete(id)
      }
    })
  }

  downloadAll(
    id: string,
    onProgress: (event: DownloadProgress) => void
  ): Promise<DownloadDone> {
    assertBookId(id)
    this.ensureNetwork()
    const existing = this.downloadJobs.get(id)
    if (existing) return existing.done as Promise<DownloadDone>
    const controller = new AbortController()
    // 先把任务放进 map，取消请求才能看到它。
    const done = this.runDownload(id, controller, onProgress).finally(() => {
      this.downloadJobs.delete(id)
    })
    this.downloadJobs.set(id, { controller, done })
    return done
  }

  private async runDownload(
    id: string,
    controller: AbortController,
    onProgress: (event: DownloadProgress) => void
  ): Promise<DownloadDone> {
    // 下载、更新目录、转本地共用每本书的锁，互斥执行。
    return this.locks.run(`book:${id}`, async () => {
      const meta = await this.networkBooks.readMeta(id)
      if (meta.format !== 'network' || !meta.network) throw new Error('这不是网络书')
      const pending = meta.chapters.filter(
        (chapter) => chapter.level !== 'volume' && chapter.url
      )
      const cached = new Set(await this.networkBooks.listCachedChapters(id))
      const todo = pending.filter((chapter) => !cached.has(chapter.index))
      const failedChapters: DownloadFailedChapter[] = []
      let done = pending.length - todo.length
      onProgress({ bookId: id, done, total: pending.length, failed: 0 })

      // 4 个 worker 是下载上限；真正发请求时每本书再限 2、每个书源再限 2，
      // 全局下载配额 4 由 readChapter 的 origin = 'download' 统一获取。
      const queue = [...todo]
      const workers = Array.from({ length: Math.min(4, queue.length) }, async () => {
        while (queue.length > 0) {
          if (controller.signal.aborted) return
          const chapter = queue.shift()
          if (!chapter) return
          try {
            await this.readChapter(id, chapter.index, 'download')
            done++
          } catch (error) {
            if (controller.signal.aborted) return
            failedChapters.push({
              index: chapter.index,
              title: chapter.title,
              message: error instanceof Error ? error.message : '下载失败'
            })
          } finally {
            onProgress({ bookId: id, done, total: pending.length, failed: failedChapters.length })
          }
        }
      })
      await Promise.all(workers)

      // spec 8.3：书源在下载途中被删除或停用，剩余章节记为失败并结束，
      // 已缓存章节保留。这种中止不算用户取消。
      const reason = this.downloadJobs.get(id)?.reason
      if (reason) {
        const cachedNow = new Set(await this.networkBooks.listCachedChapters(id))
        const failedIndexes = new Set(failedChapters.map((item) => item.index))
        for (const chapter of todo) {
          if (cachedNow.has(chapter.index) || failedIndexes.has(chapter.index)) continue
          failedChapters.push({
            index: chapter.index,
            title: chapter.title,
            message: reason === 'source-deleted' ? '书源已删除' : '书源已停用'
          })
        }
      }

      const cache = await this.cacheInfo(id, meta)
      const state = downloadState(cache.cached, cache.total)
      await this.library.update(id, {
        networkCache: cache,
        downloadState: state,
        ...(state === 'complete' ? { lastUpdateAt: new Date().toISOString() } : {})
      })
      if (state === 'complete') {
        meta.network.lastDownloadAt = new Date().toISOString()
        await this.networkBooks.writeMeta(id, meta)
      }
      return {
        bookId: id,
        done,
        total: pending.length,
        failedChapters,
        cancelled: controller.signal.aborted && !reason
      }
    })
  }

  cancelDownload(id: string): void {
    this.cancelBookTasks(id)
  }

  async networkCacheOf(id: string): Promise<{ cached: number; total: number }> {
    const meta = await this.networkBooks.readMeta(id)
    return this.cacheInfo(id, meta)
  }

  private async cacheInfo(id: string, meta: BookMeta): Promise<{ cached: number; total: number }> {
    const cached = await this.networkBooks.listCachedChapters(id)
    return networkCacheFor(meta.chapters, new Set(cached))
  }

  async entryFor(id: string): Promise<LibraryEntry> {
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书')
    return entry
  }

  /** 只中止这本书的下载任务（取消下载、删书共用）。 */
  cancelBookTasks(id: string, reason?: 'source-deleted' | 'source-disabled'): void {
    const job = this.downloadJobs.get(id)
    if (!job) return
    if (reason) job.reason = reason
    job.controller.abort()
  }

  /** 中止这本书正在进行的目录更新；删书这类普通中止不写 reason。 */
  cancelBookUpdate(id: string, reason?: 'source-deleted' | 'source-disabled'): void {
    const toc = this.tocControllers.get(id)
    if (!toc) return
    if (reason) this.tocCancelReasons.set(id, reason)
    toc.abort()
  }

  /** 书源被删除/停用：中止仍指向该来源的所有网络书的下载和目录更新。 */
  async cancelSourceTasks(
    sourceId: string,
    reason: 'source-deleted' | 'source-disabled'
  ): Promise<void> {
    for (const entry of await this.library.list()) {
      if (entry.format === 'network' && entry.sourceId === sourceId) {
        this.cancelBookTasks(entry.id, reason)
        this.cancelBookUpdate(entry.id, reason)
      }
    }
  }

  async relinkSources(): Promise<void> {
    const sources = await this.sources.list()
    const byUrl = new Map(sources.map((source) => [source.url, source]))
    for (const entry of await this.library.list()) {
      if (entry.format !== 'network' || !entry.sourceId) continue
      let meta: BookMeta
      try {
        meta = await this.networkBooks.readMeta(entry.id)
      } catch {
        // One damaged book must not stop the rest from being relinked.
        continue
      }
      if (!meta.network) continue
      if (sources.some((source) => source.id === meta.network!.sourceId)) continue
      const replacement = byUrl.get(meta.network.sourceUrl)
      if (!replacement) continue
      meta.network.sourceId = replacement.id
      meta.network.sourceName = replacement.name
      await this.networkBooks.writeMeta(entry.id, meta)
      await this.library.update(entry.id, {
        sourceId: replacement.id,
        sourceName: replacement.name
      })
    }
  }
}
