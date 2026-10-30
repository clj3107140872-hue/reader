import { useEffect, useState } from 'react'
import type { AppSettings } from '../../core/model'
import { DEFAULT_SETTINGS, mergeSettings } from '../../shared/settings'
import type { SettingsPatch } from '../../shared/settings'
import Library from './pages/Library'
import Reader from './pages/Reader'

type View = { name: 'library' } | { name: 'reader'; bookId: string }

export default function App() {
  const [view, setView] = useState<View>({ name: 'library' })
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS)

  useEffect(() => {
    void window.api.getSettings().then(setSettings)
  }, [])

  const updateSettings = (patch: SettingsPatch): void => {
    setSettings((current) => mergeSettings(current, patch))
    void window.api.updateSettings(patch).catch(() => undefined)
  }

  if (view.name === 'reader') {
    return (
      <Reader
        bookId={view.bookId}
        settings={settings}
        onSettingsChange={updateSettings}
        onBack={() => setView({ name: 'library' })}
      />
    )
  }

  return <Library onOpen={(bookId) => setView({ name: 'reader', bookId })} />
}
