import { useEffect, useState } from 'react'
import type { AppSettings, ThemeName } from '../../../core/model'
import {
  BOSS_KEY_ACTIONS,
  BOSS_KEY_OPTIONS,
  DISGUISE_OPTIONS,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  THEME_MODE_OPTIONS
} from '../../../shared/settings'
import type { SettingsPatch } from '../../../shared/settings'

interface SettingsPanelProps {
  settings: AppSettings
  /** Palette actually rendering after the day/night/system mode is applied. */
  resolvedTheme: ThemeName
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

export default function SettingsPanel({
  settings,
  resolvedTheme,
  onChange,
  onClose
}: SettingsPanelProps) {
  const typography = settings.typography
  const slacking = settings.slacking
  const fonts = FONTS.some((font) => font.value === typography.fontFamily)
    ? FONTS
    : [{ label: '当前字体', value: typography.fontFamily }, ...FONTS]

  const [maxWidthDraft, setMaxWidthDraft] = useState(String(typography.maxContentWidth ?? 860))

  useEffect(() => {
    setMaxWidthDraft(String(typography.maxContentWidth ?? 860))
  }, [typography.maxContentWidth])

  const commitMaxWidth = (): void => {
    const parsed = Number(maxWidthDraft)
    if (maxWidthDraft.trim() === '' || !Number.isFinite(parsed)) {
      setMaxWidthDraft(String(typography.maxContentWidth ?? 860))
      return
    }
    const clamped = Math.min(2000, Math.max(400, Math.round(parsed)))
    setMaxWidthDraft(String(clamped))
    onChange({ typography: { maxContentWidth: clamped } })
  }

  return (
    <aside className="reader-drawer right settings-panel">
      <header className="drawer-header">
        <h2>设置</h2>
        <button className="drawer-close" onClick={onClose} aria-label="关闭设置">
          ×
        </button>
      </header>

      <section className="setting-group">
        <h3>主题</h3>
        <div className="theme-mode" role="group" aria-label="日夜模式">
          {THEME_MODE_OPTIONS.map((mode) => (
            <button
              key={mode.id}
              className={`theme-mode-option ${settings.themeMode === mode.id ? 'active' : ''}`}
              onClick={() => onChange({ themeMode: mode.id })}
            >
              {mode.label}
            </button>
          ))}
        </div>
        <div className="theme-grid">
          {THEMES.map((theme) => (
            <button
              key={theme.id}
              className={`theme-swatch ${theme.id} ${resolvedTheme === theme.id ? 'active' : ''}`}
              onClick={() =>
                onChange(
                  theme.id === 'dark'
                    ? { themeMode: 'night' }
                    : { themeMode: 'day', theme: theme.id }
                )
              }
            >
              {theme.label}
            </button>
          ))}
        </div>
        {settings.themeMode === 'system' && (
          <p className="setting-hint">
            跟随系统：系统为浅色时使用所选日间配色，系统切换到深色时自动使用深色。
          </p>
        )}
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
            min={FONT_SIZE_MIN}
            max={FONT_SIZE_MAX}
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
            value={maxWidthDraft}
            onChange={(event) => setMaxWidthDraft(event.target.value)}
            onBlur={commitMaxWidth}
            onKeyDown={(event) => {
              if (event.key === 'Enter') event.currentTarget.blur()
            }}
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

      <section className="setting-group">
        <h3>摸鱼模式</h3>
        <div className="disguise-grid" role="group" aria-label="伪装样式">
          {DISGUISE_OPTIONS.map((option) => (
            <button
              key={option.id}
              className={`disguise-option ${slacking.disguise === option.id ? 'active' : ''}`}
              onClick={() => onChange({ slacking: { disguise: option.id } })}
            >
              {option.label}
            </button>
          ))}
        </div>
        <p className="setting-hint">
          {DISGUISE_OPTIONS.find((option) => option.id === slacking.disguise)?.hint}
        </p>

        <label className="setting-row">
          <span>不透明度</span>
          <input
            type="range"
            min={0.6}
            max={1}
            step={0.05}
            value={slacking.opacity}
            onChange={(event) =>
              onChange({ slacking: { opacity: Number(event.target.value) } })
            }
          />
          <output>{Math.round(slacking.opacity * 100)}%</output>
        </label>

        <label className="setting-check">
          <input
            type="checkbox"
            checked={slacking.alwaysOnTop}
            onChange={(event) =>
              onChange({ slacking: { alwaysOnTop: event.target.checked } })
            }
          />
          窗口置顶
        </label>

        <label className="setting-row">
          <span>老板键</span>
          <select
            value={slacking.bossKey}
            onChange={(event) => onChange({ slacking: { bossKey: event.target.value } })}
          >
            {BOSS_KEY_OPTIONS.map((option) => (
              <option key={option.id} value={option.id}>
                {option.label}
              </option>
            ))}
          </select>
        </label>

        <label className="setting-row">
          <span>老板键动作</span>
          <select
            value={slacking.bossKeyAction}
            disabled={!slacking.bossKey}
            onChange={(event) =>
              onChange({
                slacking: { bossKeyAction: event.target.value as AppSettings['slacking']['bossKeyAction'] }
              })
            }
          >
            {BOSS_KEY_ACTIONS.map((action) => (
              <option key={action.id} value={action.id}>
                {action.label}
              </option>
            ))}
          </select>
        </label>

        {slacking.bossKey ? (
          <p className="setting-hint">
            按 {slacking.bossKey}
            {slacking.bossKeyAction === 'hide' ? '隐藏窗口' : '最小化窗口'}，再按一次恢复。
          </p>
        ) : (
          <p className="setting-hint">老板键已关闭。</p>
        )}
      </section>
    </aside>
  )
}
