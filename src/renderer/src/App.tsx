import { useEffect, useLayoutEffect, useState } from 'react'
import type { AppSettings, DisguiseStyle, ReadingMode } from '../../core/model'
import {
  DEFAULT_SETTINGS,
  mergeSettings,
  normalizeDisguiseStyle,
  resolveTheme
} from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import Library from './pages/Library'
import NetworkSearch from './pages/NetworkSearch'
import Reader from './pages/Reader'
import Sources from './pages/Sources'

type View =
  | { name: 'library' }
  | { name: 'reader'; bookId: string }
  | { name: 'sources' }
  | { name: 'network-search' }

// A disguise window is created with the book and style in its URL, so the
// first paint already looks right instead of flashing the normal reader.
const initialParams = new URLSearchParams(window.location.search)
const initialBookId = initialParams.get('bookId')
const initialStyle: DisguiseStyle = initialBookId
  ? normalizeDisguiseStyle(initialParams.get('style'))
  : 'none'
const initialMode: ReadingMode = initialParams.get('mode') === 'paged' ? 'paged' : 'scroll'

function seededSettings(style: DisguiseStyle, mode: ReadingMode): AppSettings {
  return {
    ...DEFAULT_SETTINGS,
    readingMode: mode,
    slacking: { ...DEFAULT_SETTINGS.slacking, disguise: style }
  }
}

function useSystemPrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  )

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const update = (event: MediaQueryListEvent): void => setDark(event.matches)
    setDark(query.matches)
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])

  return dark
}

export default function App() {
  const [view, setView] = useState<View>(() =>
    initialBookId ? { name: 'reader', bookId: initialBookId } : { name: 'library' }
  )
  const [settings, setSettings] = useState<AppSettings>(() =>
    seededSettings(initialStyle, initialMode)
  )
  const [settingsError, setSettingsError] = useState('')
  const systemPrefersDark = useSystemPrefersDark()
  const theme = resolveTheme(settings, systemPrefersDark)
  // Day/night paints the app chrome (library, dialogs, toasts). The reading
  // page keeps its own background palette; the two never share a variable.
  const appTheme = theme === 'dark' ? 'night' : 'day'
  const viewBookId = view.name === 'reader' ? view.bookId : null
  const activeStyle: DisguiseStyle =
    view.name === 'reader' ? settings.slacking.disguise : 'none'

  useEffect(() => {
    void window.api
      .getSettings()
      .then(setSettings)
      .catch((reason: unknown) => {
        console.error('读取设置失败', reason)
        setSettingsError('读取设置失败，已使用默认设置')
      })
  }, [])

  // The main process swaps the window when the disguise needs a different
  // frame; it needs to know whether a book is on screen at all.
  useEffect(() => {
    void window.api.setViewState(viewBookId).catch((reason: unknown) => {
      console.error('同步阅读状态失败', reason)
    })
  }, [viewBookId])

  useLayoutEffect(() => {
    document.documentElement.dataset.appTheme = appTheme
  }, [appTheme])

  // The window itself is transparent in this mode, so the page background must
  // be too, or the "transparent" window would still show a beige rectangle.
  useLayoutEffect(() => {
    if (activeStyle === 'transparent' || activeStyle === 'code') {
      document.body.dataset.slacking = activeStyle
    } else {
      delete document.body.dataset.slacking
    }
    return () => {
      delete document.body.dataset.slacking
    }
  }, [activeStyle])

  useEffect(() => {
    if (!settingsError) return
    const timer = window.setTimeout(() => setSettingsError(''), 5000)
    return () => window.clearTimeout(timer)
  }, [settingsError])

  const updateSettings = (patch: SettingsPatch): void => {
    setSettings((current) => mergeSettings(current, patch))
    void window.api.updateSettings(patch).catch((reason: unknown) => {
      console.error('保存设置失败', reason)
      setSettingsError('保存设置失败，请稍后重试')
    })
  }

  return (
    <>
      {settingsError && (
        <div className="toast" role="status">
          {settingsError}
        </div>
      )}
      {view.name === 'reader' ? (
        <Reader
          bookId={view.bookId}
          settings={settings}
          theme={theme}
          onSettingsChange={updateSettings}
          onBack={() => setView({ name: 'library' })}
        />
      ) : view.name === 'sources' ? (
        <Sources onBack={() => setView({ name: 'library' })} />
      ) : view.name === 'network-search' ? (
        <NetworkSearch
          networkEnabled={settings.network.enabled}
          onBack={() => setView({ name: 'library' })}
          onAdded={() => setView({ name: 'library' })}
        />
      ) : (
        <Library
          networkEnabled={settings.network.enabled}
          onOpen={(bookId) => setView({ name: 'reader', bookId })}
          onOpenSources={() => setView({ name: 'sources' })}
          onOpenNetworkSearch={() => setView({ name: 'network-search' })}
        />
      )}
    </>
  )
}
