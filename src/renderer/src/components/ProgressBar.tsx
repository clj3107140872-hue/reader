interface ProgressBarProps {
  percent: number
  chapterIndex: number
  chapterCount: number
  remainingMinutes: number
  onSeek: (percent: number) => void
}

export default function ProgressBar({
  percent,
  chapterIndex,
  chapterCount,
  remainingMinutes,
  onSeek
}: ProgressBarProps) {
  return (
    <footer className="progress-bar">
      <span className="progress-chapter">
        第 {Math.min(chapterIndex + 1, chapterCount)} / {chapterCount} 章
      </span>
      <input
        className="progress-range"
        type="range"
        min={0}
        max={100}
        step={0.1}
        value={percent}
        onChange={(event) => onSeek(Number(event.target.value))}
        aria-label="阅读进度"
      />
      <span className="progress-percent">{percent.toFixed(1)}%</span>
      <span className="progress-remaining">约剩 {remainingMinutes} 分钟</span>
    </footer>
  )
}
