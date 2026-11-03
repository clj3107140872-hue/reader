import { useEffect, useState } from 'react'
import type { AppSettings } from '../../core/model'
import { DEFAULT_SETTINGS, mergeSettings, resolveTheme } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import Library from './pages/Library'
import Reader from './pages/Reader'

type View = { name: 'library' } | { name: 'reader'; bookId: string }

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
  const [view, setView] = useState<View>({ name: 'library' })
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)
  const [settingsError, setSettingsError] = useState('')
  const systemPrefersDark = useSystemPrefersDark()
  const theme = resolveTheme(settings, systemPrefersDark)

  useEffect(() => {
    void window.api
      .getSettings()
      .then(setSettings)
      .catch((reason: unknown) => {
        console.error('读取设置失败', reason)
        setSettingsError('读取设置失败，已使用默认设置')
      })
  }, [])

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
      ) : (
        <Library onOpen={(bookId) => setView({ name: 'reader', bookId })} />
      )}
    </>
  )
}
