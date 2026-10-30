import { basename } from 'node:path'
import type { ImportSummary } from '../../shared/api'
import type { ImportService } from './import'

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export class ImportQueue {
  constructor(private readonly importer: ImportService) {}

  async importFiles(files: string[]): Promise<ImportSummary> {
    const summary: ImportSummary = {
      imported: 0,
      duplicates: [],
      suspects: [],
      errors: [],
      warnings: []
    }

    for (const file of files) {
      const fileName = basename(file)
      try {
        const outcome = await this.importer.importFile(file)
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
