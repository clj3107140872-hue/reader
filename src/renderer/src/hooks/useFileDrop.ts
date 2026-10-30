import { useEffect, useRef, useState } from 'react'

export function useFileDrop(onPaths: (paths: string[]) => void): boolean {
  const [dragging, setDragging] = useState(false)
  const callbackRef = useRef(onPaths)
  callbackRef.current = onPaths

  useEffect(() => {
    let depth = 0
    const hasFiles = (event: DragEvent): boolean =>
      Array.from(event.dataTransfer?.types ?? []).includes('Files')

    const handleEnter = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      depth += 1
      setDragging(true)
    }
    const handleOver = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault()
    }
    const handleLeave = (): void => {
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const handleDrop = (event: DragEvent): void => {
      if (!hasFiles(event)) return
      event.preventDefault()
      depth = 0
      setDragging(false)
      const paths = Array.from(event.dataTransfer?.files ?? [])
        .map((file) => window.api.pathForFile(file))
        .filter((path) => Boolean(path))
      if (paths.length > 0) callbackRef.current(paths)
    }

    window.addEventListener('dragenter', handleEnter)
    window.addEventListener('dragover', handleOver)
    window.addEventListener('dragleave', handleLeave)
    window.addEventListener('drop', handleDrop)
    return () => {
      window.removeEventListener('dragenter', handleEnter)
      window.removeEventListener('dragover', handleOver)
      window.removeEventListener('dragleave', handleLeave)
      window.removeEventListener('drop', handleDrop)
    }
  }, [])

  return dragging
}
