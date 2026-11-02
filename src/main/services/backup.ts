import type { LibraryEntry } from '../../core/model'
import type { BackupInfo, RestoreBackupResult } from '../../shared/api'
import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export class BackupService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async list(id: string): Promise<BackupInfo[]> {
    assertBookId(id)
    const entry = (await this.library.list()).find((item) => item.id === id)
    if (!entry) throw new Error('找不到这本书，可能已被删除')
    const backups = await this.books.listBackups(id)
    return backups.map((backup) => ({
      name: backup.name,
      createdAt: backup.createdAt,
      chapterCount: backup.chapterCount,
      reason: backup.reason,
      sourceTitle: backup.sourceTitle
    }))
  }

  async restore(id: string, name: string): Promise<RestoreBackupResult> {
    assertBookId(id)
    return this.library.runExclusive(async () => {
      const entries = await this.library.list()
      const current = entries.find((entry) => entry.id === id)
      if (!current) throw new Error('找不到这本书，可能已被删除')

      const backup = await this.books.readBackup(id, name)
      if (backup.files.meta.id !== id) throw new Error('备份数据不完整，无法恢复')

      const manifest = backup.manifest
      const sourceEntry: LibraryEntry | undefined =
        manifest?.reason === 'merge' ? manifest.sourceEntry : undefined
      if (sourceEntry && backup.sourceBookDir) {
        if (entries.some((entry) => entry.id === sourceEntry.id)) {
          throw new Error('合并前的源书已存在，无法恢复')
        }
      }

      // writeBook keeps the pre-restore state as a new backup, so a restore
      // can itself be undone by choosing the newer entry.
      await this.books.writeBook(backup.files)
      await this.books.writeProgress(id, backup.progress)

      const chapterCount = backup.files.meta.chapters.length
      const restoredEntry: LibraryEntry = manifest
        ? { ...manifest.targetEntry, chapterCount }
        : {
            ...current,
            chapterCount,
            stats: {
              ...current.stats,
              suspectedDuplicateChapters: backup.files.meta.chapters.filter(
                (chapter) => chapter.flags.suspectedDuplicate
              ).length
            }
          }

      let restoredSource = false
      if (sourceEntry && backup.sourceBookDir) {
        await this.books.restoreSource(sourceEntry, backup.sourceBookDir)
        restoredSource = true
      }

      const nextEntries = entries.map((entry) =>
        entry.id === id ? restoredEntry : entry
      )
      if (restoredSource && sourceEntry) nextEntries.push(sourceEntry)
      await this.library.save(nextEntries)

      return { id, chapterCount, restoredSource }
    })
  }
}
