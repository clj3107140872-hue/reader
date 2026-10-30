import { useEffect, useMemo, useRef, useState } from 'react'
import type { AppSettings } from '../../../core/model'
import type { OpenBookPayload } from '../../../shared/api'
import type { SettingsPatch } from '../../../shared/settings'

interface ReaderProps {
  bookId: string
  settings: AppSettings
  onSettingsChange: (patch: SettingsPatch) => void
  onBack: () => void
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
}

export default function Reader({ bookId, onBack }: ReaderProps) {
  const [book, setBook] = useState<OpenBookPayload | null>(null)
  const [error, setError] = useState('')
  const scrollRef = useRef<HTMLElement | null>(null)

  useEffect(() => {
    let alive = true
    setBook(null)
    setError('')
    window.api
      .openBook(bookId)
      .then((payload) => {
        if (alive) setBook(payload)
      })
      .catch((reason: unknown) => {
        if (alive) setError(reason instanceof Error ? reason.message : String(reason))
      })
    return () => {
      alive = false
    }
  }, [bookId])

  const chapters = useMemo(() => {
    if (!book) return []
    return book.meta.chapters.map((meta, index) => ({
      meta,
      paragraphs: splitParagraphs(book.chapters[index] ?? '')
    }))
  }, [book])

  if (error) {
    return (
      <div className="reader-error">
        <p>这本书打不开了：{error}</p>
        <button onClick={onBack}>返回书架</button>
      </div>
    )
  }

  if (!book) {
    return <p className="loading">正在打开…</p>
  }

  return (
    <div className="reader">
      <header className="reader-toolbar">
        <button className="ghost" onClick={onBack}>
          ← 书架
        </button>
        <span className="reader-title" title={book.meta.title}>
          {book.meta.title}
        </span>
      </header>

      <main className="reader-scroll" ref={scrollRef}>
        <article className="reader-page">
          {chapters.map((chapter, chapterIndex) => (
            <section
              key={chapter.meta.index}
              className={`reader-chapter ${chapter.meta.level}`}
              data-chapter-section={chapterIndex}
            >
              <h2 className="chapter-title">{chapter.meta.title}</h2>
              {chapter.paragraphs.map((text, paragraphIndex) => (
                <p
                  key={paragraphIndex}
                  className="reader-paragraph"
                  data-chapter-index={chapterIndex}
                  data-paragraph-index={paragraphIndex}
                >
                  {text}
                </p>
              ))}
            </section>
          ))}
        </article>
      </main>
    </div>
  )
}
