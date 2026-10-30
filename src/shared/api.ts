import type { LibraryEntry } from '../core/model'

export interface ImportSummary {
  imported: number
  duplicates: string[]
  suspects: { id: string; title: string; overlap: number }[]
  errors: string[]
  warnings: string[]
}

export interface ReaderApi {
  ping(): Promise<string>
  libraryList(): Promise<LibraryEntry[]>
  chooseAndImport(): Promise<ImportSummary>
  /** Development builds only; rejects in packaged builds. */
  debugImport(paths: string[]): Promise<ImportSummary>
  onImportProgress(cb: (payload: { fileName: string; stage: string }) => void): () => void
}
