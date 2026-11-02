import { useLayoutEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'

interface HoverCardProps {
  anchor: { left: number; right: number; top: number }
  children: ReactNode
}

export default function HoverCard({ anchor, children }: HoverCardProps) {
  const ref = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)

  useLayoutEffect(() => {
    const element = ref.current
    if (!element) return
    const { width, height } = element.getBoundingClientRect()
    const gap = 10
    let left = anchor.right + gap
    if (left + width > window.innerWidth - 8) left = anchor.left - width - gap
    left = Math.max(8, Math.min(left, window.innerWidth - width - 8))
    const top = Math.max(8, Math.min(anchor.top, window.innerHeight - height - 8))
    setPosition({ left, top })
  }, [anchor])

  return (
    <div
      ref={ref}
      className="hover-card"
      style={{
        left: position?.left ?? 0,
        top: position?.top ?? 0,
        visibility: position ? 'visible' : 'hidden'
      }}
    >
      {children}
    </div>
  )
}
