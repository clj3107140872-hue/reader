import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { ImportSummary } from '../../shared/api'
import type { ImportService, ImportStage } from './import'

export interface ImportQueueOptions {
  largeFileBytes?: number
  confirmLargeFile?: (info: { fileName: string; size: number }) => Promise<boolean>
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatFileSize(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`
  return `${bytes} B`
}

export class ImportQueue {
  constructor(
    private readonly importer: ImportService,
    private readonly options: ImportQueueOptions = {}
  ) {}

  async importFiles(
    files: string[],
    onStage?: (payload: { fileName: string; stage: ImportStage }) => void
  ): Promise<ImportSummary> {
    const summary: ImportSummary = {
      imported: 0,
      duplicates: [],
      suspects: [],
      errors: [],
      warnings: []
    }
    const threshold = this.options.largeFileBytes ?? 50 * 1024 * 1024
    const confirm = this.options.confirmLargeFile ?? (async () => false)

    for (const file of files) {
      const fileName = basename(file)
      if (extname(fileName).toLowerCase() !== '.txt') {
        summary.warnings.push(`${fileName}：只支持 TXT 文件`)
        continue
      }

      let size = 0
      try {
        const info = await stat(file)
        if (!info.isFile()) {
          summary.warnings.push(`${fileName}：不是文件`)
          continue
        }
        size = info.size
      } catch {
        summary.warnings.push(`${fileName}：无法读取文件信息`)
        continue
      }

      if (size > threshold) {
        const accepted = await confirm({ fileName, size })
        if (!accepted) {
          summary.warnings.push(`${fileName}：文件超过 ${formatFileSize(threshold)}，已跳过`)
          continue
        }
      }

      try {
        const outcome = await this.importer.importFile(file, (stage) =>
          onStage?.({ fileName, stage })
        )
        if ('duplicate' in outcome) {
          summary.duplicates.push(outcome.title)
          continue
        }
        summary.imported += 1
        summary.suspects.push(
          ...outcome.suspects.map((suspect) => ({
            ...suspect,
            sourceId: outcome.entry.id,
            sourceTitle: outcome.entry.title
          }))
        )
        for (const warning of outcome.warnings) {
          summary.warnings.push(`${fileName}：${warning}`)
        }
      } catch (error) {
        summary.errors.push(`${fileName}: ${errorMessage(error)}`)
      }
    }

    return summary
  }
}
