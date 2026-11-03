import type {
  AppSettings,
  BossKeyAction,
  DisguiseStyle,
  ThemeMode,
  ThemeName
} from '../core/model'

export const DEFAULT_SETTINGS: AppSettings = {
  version: 1,
  theme: 'light',
  themeMode: 'day',
  slacking: {
    disguise: 'none',
    opacity: 1,
    alwaysOnTop: false,
    bossKey: 'Ctrl+Shift+H',
    bossKeyAction: 'hide'
  },
  typography: {
    fontFamily: "'Microsoft YaHei UI', 'Microsoft YaHei', sans-serif",
    fontSize: 18,
    lineHeight: 1.8,
    paragraphSpacing: 0.8,
    pagePadding: 32,
    maxContentWidth: 860
  },
  cleaning: { enabled: true, disabledBuiltinIds: [] },
  window: { width: 1200, height: 800, maximized: false }
}

export const FONT_SIZE_MIN = 12
export const FONT_SIZE_MAX = 36

const THEMES: ThemeName[] = ['light', 'dark', 'green', 'sepia']
const THEME_MODES: ThemeMode[] = ['day', 'night', 'system']

export const THEME_MODE_OPTIONS: { id: ThemeMode; label: string }[] = [
  { id: 'day', label: '日间' },
  { id: 'night', label: '夜间' },
  { id: 'system', label: '跟随系统' }
]

export const BOSS_KEY_OPTIONS = [
  { id: 'Ctrl+Shift+H', label: 'Ctrl+Shift+H' },
  { id: 'Ctrl+Shift+J', label: 'Ctrl+Shift+J' },
  { id: 'Alt+Q', label: 'Alt+Q' },
  { id: 'Ctrl+Alt+H', label: 'Ctrl+Alt+H' },
  { id: '', label: '关闭老板键' }
] as const

export const BOSS_KEY_ACTIONS: { id: BossKeyAction; label: string }[] = [
  { id: 'hide', label: '隐藏窗口' },
  { id: 'minimize', label: '最小化窗口' }
]

const DISGUISE_STYLES: DisguiseStyle[] = ['none', 'notepad', 'transparent', 'code']

export const DISGUISE_OPTIONS: { id: DisguiseStyle; label: string; hint: string }[] = [
  { id: 'none', label: '关闭', hint: '正常阅读界面。' },
  { id: 'notepad', label: '记事本', hint: '窗口和正文伪装成记事本；按 Esc 退出。' },
  {
    id: 'transparent',
    label: '透明悬浮',
    hint: '隐藏边框与背景，文字颜色随身后的画面自动切换；按 Esc 退出。'
  },
  { id: 'code', label: '代码注释', hint: '伪装成编辑器：代码固定不动，正文以注释形式滚动；按 Esc 退出。' }
]

/** Accepts the current style strings and migrates the old boolean setting. */
export function normalizeDisguiseStyle(value: unknown): DisguiseStyle {
  if (value === true) return 'notepad'
  if (typeof value === 'string' && DISGUISE_STYLES.includes(value as DisguiseStyle)) {
    return value as DisguiseStyle
  }
  return 'none'
}

export type DisguiseWindowKind = 'normal' | 'transparent' | 'code'

/**
 * Frameless windows only make sense while a book is open; the library always
 * keeps a normal frame so the user can still move and resize it.
 */
export function disguiseWindowKind(style: DisguiseStyle, hasBook: boolean): DisguiseWindowKind {
  if (!hasBook) return 'normal'
  if (style === 'transparent' || style === 'code') return style
  return 'normal'
}

/** Picks the palette that should actually render for the current mode. */
export function resolveTheme(settings: AppSettings, systemPrefersDark: boolean): ThemeName {
  if (settings.themeMode === 'night') return 'dark'
  if (settings.themeMode === 'system' && systemPrefersDark) return 'dark'
  // Older settings may still carry the dark palette as their base theme.
  return settings.theme === 'dark' ? 'light' : settings.theme
}

function normalizeTheme(raw: Partial<AppSettings>): { theme: ThemeName; themeMode: ThemeMode } {
  const requested = THEMES.includes(raw.theme as ThemeName) ? (raw.theme as ThemeName) : undefined
  const requestedMode = THEME_MODES.includes(raw.themeMode as ThemeMode)
    ? (raw.themeMode as ThemeMode)
    : undefined
  // Older versions stored the dark palette directly; keep that choice as night mode.
  if (requested === 'dark') {
    return { theme: DEFAULT_SETTINGS.theme, themeMode: requestedMode ?? 'night' }
  }
  return {
    theme: requested ?? DEFAULT_SETTINGS.theme,
    themeMode: requestedMode ?? DEFAULT_SETTINGS.themeMode
  }
}

function clamp(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(min, value))
}

export interface SettingsPatch {
  theme?: ThemeName
  themeMode?: ThemeMode
  slacking?: Partial<AppSettings['slacking']>
  typography?: Partial<AppSettings['typography']>
  cleaning?: Partial<AppSettings['cleaning']>
  window?: Partial<AppSettings['window']>
}

export function normalizeSettings(input: unknown): AppSettings {
  const raw = (input && typeof input === 'object' ? input : {}) as Partial<AppSettings>
  const typography = (raw.typography ?? {}) as Partial<AppSettings['typography']>
  const cleaning = (raw.cleaning ?? {}) as Partial<AppSettings['cleaning']>
  const windowState = (raw.window ?? {}) as Partial<AppSettings['window']>
  const slacking = (raw.slacking ?? {}) as Partial<AppSettings['slacking']>
  const maxWidth = typography.maxContentWidth
  const { theme, themeMode } = normalizeTheme(raw)

  return {
    version: 1,
    theme,
    themeMode,
    slacking: {
      disguise: normalizeDisguiseStyle(slacking.disguise),
      opacity: clamp(slacking.opacity, 0.6, 1, DEFAULT_SETTINGS.slacking.opacity),
      alwaysOnTop: slacking.alwaysOnTop === true,
      bossKey: BOSS_KEY_OPTIONS.some((option) => option.id === slacking.bossKey)
        ? (slacking.bossKey as string)
        : DEFAULT_SETTINGS.slacking.bossKey,
      bossKeyAction: BOSS_KEY_ACTIONS.some((action) => action.id === slacking.bossKeyAction)
        ? (slacking.bossKeyAction as BossKeyAction)
        : DEFAULT_SETTINGS.slacking.bossKeyAction
    },
    typography: {
      fontFamily:
        typeof typography.fontFamily === 'string' && typography.fontFamily.trim()
          ? typography.fontFamily
          : DEFAULT_SETTINGS.typography.fontFamily,
      fontSize: clamp(
        typography.fontSize,
        FONT_SIZE_MIN,
        FONT_SIZE_MAX,
        DEFAULT_SETTINGS.typography.fontSize
      ),
      lineHeight: clamp(typography.lineHeight, 1.2, 2.5, DEFAULT_SETTINGS.typography.lineHeight),
      paragraphSpacing: clamp(
        typography.paragraphSpacing,
        0,
        2,
        DEFAULT_SETTINGS.typography.paragraphSpacing
      ),
      pagePadding: clamp(typography.pagePadding, 0, 120, DEFAULT_SETTINGS.typography.pagePadding),
      maxContentWidth:
        maxWidth === null
          ? null
          : clamp(maxWidth, 400, 2400, DEFAULT_SETTINGS.typography.maxContentWidth ?? 860)
    },
    cleaning: {
      enabled: typeof cleaning.enabled === 'boolean' ? cleaning.enabled : DEFAULT_SETTINGS.cleaning.enabled,
      disabledBuiltinIds: Array.isArray(cleaning.disabledBuiltinIds)
        ? [
            ...new Set(
              cleaning.disabledBuiltinIds.filter(
                (id): id is string => typeof id === 'string' && id.length > 0
              )
            )
          ]
        : DEFAULT_SETTINGS.cleaning.disabledBuiltinIds
    },
    window: {
      width: clamp(windowState.width, 800, 3840, DEFAULT_SETTINGS.window.width),
      height: clamp(windowState.height, 600, 2160, DEFAULT_SETTINGS.window.height),
      x:
        typeof windowState.x === 'number' && Number.isFinite(windowState.x)
          ? windowState.x
          : undefined,
      y:
        typeof windowState.y === 'number' && Number.isFinite(windowState.y)
          ? windowState.y
          : undefined,
      maximized: typeof windowState.maximized === 'boolean' ? windowState.maximized : false
    }
  }
}

export function mergeSettings(base: AppSettings, patch: SettingsPatch): AppSettings {
  return normalizeSettings({
    ...base,
    ...patch,
    slacking: { ...base.slacking, ...patch.slacking },
    typography: { ...base.typography, ...patch.typography },
    cleaning: { ...base.cleaning, ...patch.cleaning },
    window: { ...base.window, ...patch.window }
  })
}
