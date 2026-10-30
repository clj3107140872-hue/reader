import type { AppSettings, ThemeName } from '../../../core/model'
import type { SettingsPatch } from '../../../shared/settings'

interface SettingsPanelProps {
  settings: AppSettings
  onChange: (patch: SettingsPatch) => void
  onClose: () => void
}

const THEMES: { id: ThemeName; label: string }[] = [
  { id: 'light', label: '浅色' },
  { id: 'dark', label: '深色' },
  { id: 'green', label: '护眼绿' },
  { id: 'sepia', label: '羊皮纸' }
]

const FONTS = [
  { label: '系统默认', value: "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif" },
  { label: '宋体', value: "'SimSun', 'Songti SC', serif" },
  { label: '楷体', value: "'KaiTi', 'STKaiti', serif" },
  { label: '仿宋', value: "'FangSong', 'STFangsong', serif" }
]

export default function SettingsPanel({ settings, onChange, onClose }: SettingsPanelProps) {
  const typography = settings.typography
  const fonts = FONTS.some((font) => font.value === typography.fontFamily)
    ? FONTS
    : [{ label: '当前字体', value: typography.fontFamily }, ...FONTS]

  return (
    <aside className="reader-drawer right settings-panel">
      <header className="drawer-header">
        <h2>排版</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭排版设置">
          ×
        </button>
      </header>

      <section className="setting-group">
        <h3>主题</h3>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`theme-swatch ${theme.id} ${settings.theme === theme.id ? 'active' : ''}`}
              onClick={() => onChange({ theme: theme.id })}
            >
              {theme.label}
            </button>
          ))}
        </div>
      </section>

      <section className="setting-group">
        <label className="setting-row">
          <span>字体</span>
          <select
            value={typography.fontFamily}
            onChange={(event) => onChange({ typography: { fontFamily: event.target.value } })}
          >
            {fonts.map((font) => (
              <option key={font.value} value={font.value}>
                {font.label}
              </option>
            ))}
          </select>
        </label>

        <label className="setting-row">
          <span>字号</span>
          <input
            type="range"
            min={14}
            max={30}
            step={1}
            value={typography.fontSize}
            onChange={(event) => onChange({ typography: { fontSize: Number(event.target.value) } })}
          />
          <output>{typography.fontSize}px</output>
        </label>

        <label className="setting-row">
          <span>行距</span>
          <input
            type="range"
            min={1.4}
            max={2.4}
            step={0.1}
            value={typography.lineHeight}
            onChange={(event) => onChange({ typography: { lineHeight: Number(event.target.value) } })}
          />
          <output>{typography.lineHeight.toFixed(1)}</output>
        </label>

        <label className="setting-row">
          <span>段距</span>
          <input
            type="range"
            min={0}
            max={1.6}
            step={0.1}
            value={typography.paragraphSpacing}
            onChange={(event) =>
              onChange({ typography: { paragraphSpacing: Number(event.target.value) } })
            }
          />
          <output>{typography.paragraphSpacing.toFixed(1)}em</output>
        </label>

        <label className="setting-row">
          <span>页边距</span>
          <input
            type="range"
            min={16}
            max={64}
            step={2}
            value={typography.pagePadding}
            onChange={(event) => onChange({ typography: { pagePadding: Number(event.target.value) } })}
          />
          <output>{typography.pagePadding}px</output>
        </label>

        <label className="setting-row">
          <span>最大宽度</span>
          <input
            type="number"
            min={400}
            max={2000}
            step={20}
            disabled={typography.maxContentWidth === null}
            value={typography.maxContentWidth ?? 860}
            onChange={(event) =>
              onChange({ typography: { maxContentWidth: Number(event.target.value) } })
            }
          />
          <label className="inline-check">
            <input
              type="checkbox"
              checked={typography.maxContentWidth === null}
              onChange={(event) =>
                onChange({ typography: { maxContentWidth: event.target.checked ? null : 860 } })
              }
            />
            不限制
          </label>
        </label>
      </section>
    </aside>
  )
}
