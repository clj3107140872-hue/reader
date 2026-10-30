import { assertBookId } from '../bookId'
import type { BookRepository } from '../storage/book'
import type { LibraryRepository } from '../storage/library'

export class LibraryService {
  constructor(
    private readonly library: LibraryRepository,
    private readonly books: BookRepository
  ) {}

  async remove(id: string): Promise<void> {
    assertBookId(id)
    let removed = false
    await this.library.runExclusive(async () => {
      const entries = await this.library.list()
      if (!entries.some((entry) => entry.id === id)) return
      removed = true
      await this.library.save(entries.filter((entry) => entry.id !== id))
    })
    if (removed) await this.books.remove(id)
  }
}
