import { useEffect, useState } from 'react'
import type { CleanLineDetail } from '../../../core/cleaning'
import type { AdRule } from '../../../core/model'
import type {
  CleaningChapterDiff,
  CleaningConfig,
  CleaningPreview,
  ReprocessResult
} from '../../../shared/api'
import { errorText } from '../errors'
import Modal from './Modal'

type Tab = 'report' | 'rules'

interface CleaningDialogProps {
  bookId: string | null
  initialTab: Tab
  notify: (text: string) => void
  onClose: () => void
  onApplied: (result: ReprocessResult) => void
}

interface RuleFormState {
  id: string | null
  name: string
  type: AdRule['type']
  pattern: string
}

const EMPTY_FORM: RuleFormState = { id: null, name: '', type: 'line', pattern: '' }

function escapeKeyword(keyword: string): string {
  return keyword.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Turns "笔趣阁 顶点小说" into "笔趣阁|顶点小说" for non-technical users. */
function keywordsToPattern(input: string): string {
  return input
    .split(/[\s,，、;；|]+/)
    .map((word) => word.trim())
    .filter(Boolean)
    .map(escapeKeyword)
    .join('|')
}

function draftRuleId(): string {
  return `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

function lineClass(line: CleanLineDetail): string {
  if (line.removed === 'duplicate') return 'diff-line duplicate'
  if (line.removed === 'line' || (line.removed === 'sentence' && !line.cleaned)) {
    return 'diff-line removed'
  }
  return 'diff-line kept'
}

export default function CleaningDialog({
  bookId,
  initialTab,
  notify,
  onClose,
  onApplied
}: CleaningDialogProps) {
  const [tab, setTab] = useState<Tab>(initialTab)
  const [config, setConfig] = useState<CleaningConfig | null>(null)
  const [saving, setSaving] = useState(false)
  const [applying, setApplying] = useState(false)
  const [preview, setPreview] = useState<CleaningPreview | null>(null)
  const [previewLoading, setPreviewLoading] = useState(false)
  const [previewDirty, setPreviewDirty] = useState(false)
  const [chapterIndex, setChapterIndex] = useState<number | null>(null)
  const [diff, setDiff] = useState<CleaningChapterDiff | null>(null)
  const [diffLoading, setDiffLoading] = useState(false)
  const [form, setForm] = useState<RuleFormState | null>(null)
  const [keyword, setKeyword] = useState('')
  const [onlyChanged, setOnlyChanged] = useState(true)
  const busy = saving || applying

  useEffect(() => {
    let alive = true
    const load = async (): Promise<void> => {
      try {
        const loaded = await window.api.getCleaningConfig()
        if (!alive) return
        setConfig(loaded)
        if (!bookId) return
        setPreviewLoading(true)
        try {
          const result = await window.api.previewCleaning(bookId, loaded)
          if (alive) setPreview(result)
        } catch (reason) {
          if (alive) notify(`预览失败：${errorText(reason)}`)
        } finally {
          if (alive) setPreviewLoading(false)
        }
      } catch (reason) {
        if (alive) notify(`读取清洗规则失败：${errorText(reason)}`)
      }
    }
    void load()
    return () => {
      alive = false
    }
    // Runs once for the book this dialog was opened for.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const changeConfig = (next: CleaningConfig): void => {
    setConfig(next)
    setPreviewDirty(true)
  }

  const toggleRule = (scope: 'builtin' | 'user', id: string): void => {
    if (!config) return
    const update = (rules: AdRule[]): AdRule[] =>
      rules.map((rule) => (rule.id === id ? { ...rule, enabled: !rule.enabled } : rule))
    changeConfig(
      scope === 'builtin'
        ? { ...config, builtinRules: update(config.builtinRules) }
        : { ...config, userRules: update(config.userRules) }
    )
  }

  const startEdit = (rule: AdRule): void => {
    setForm({ id: rule.id, name: rule.name, type: rule.type, pattern: rule.pattern })
    setKeyword('')
  }

  const submitForm = (): void => {
    if (!config || !form) return
    const name = form.name.trim()
    const pattern = form.pattern.trim()
    if (!name) {
      notify('规则名称不能为空')
      return
    }
    if (!pattern) {
      notify('规则内容不能为空')
      return
    }
    try {
      new RegExp(pattern)
    } catch {
      notify('正则无效，请检查匹配内容')
      return
    }

    const existing = form.id ? config.userRules.find((rule) => rule.id === form.id) : undefined
    const rule: AdRule = {
      id: form.id ?? draftRuleId(),
      name,
      type: form.type,
      pattern,
      enabled: existing?.enabled ?? true
    }
    changeConfig({
      ...config,
      userRules: form.id
        ? config.userRules.map((item) => (item.id === form.id ? rule : item))
        : [...config.userRules, rule]
    })
    setForm(null)
    setKeyword('')
  }

  const removeRule = (id: string): void => {
    if (!config) return
    changeConfig({ ...config, userRules: config.userRules.filter((rule) => rule.id !== id) })
    if (form?.id === id) setForm(null)
  }

  const saveRules = async (): Promise<CleaningConfig | null> => {
    if (!config) return null
    setSaving(true)
    try {
      const saved = await window.api.saveCleaningConfig(config)
      setConfig(saved)
      setPreviewDirty(true)
      return saved
    } catch (reason) {
      notify(`保存规则失败：${errorText(reason)}`)
      return null
    } finally {
      setSaving(false)
    }
  }

  const runPreview = async (): Promise<void> => {
    if (!bookId || !config || previewLoading) return
    setPreviewLoading(true)
    try {
      const result = await window.api.previewCleaning(bookId, config)
      setPreview(result)
      setPreviewDirty(false)
      setChapterIndex(null)
      setDiff(null)
    } catch (reason) {
      notify(`预览失败：${errorText(reason)}`)
    } finally {
      setPreviewLoading(false)
    }
  }

  const apply = async (): Promise<void> => {
    if (!bookId || !config || applying) return
    setApplying(true)
    try {
      // Save first so a later re-clean reproduces this result.
      const saved = await window.api.saveCleaningConfig(config)
      setConfig(saved)
      setPreviewDirty(false)
      const result = await window.api.recleanBook(bookId)
      onApplied(result)
    } catch (reason) {
      notify(`应用清洗失败：${errorText(reason)}`)
    } finally {
      setApplying(false)
    }
  }

  const showDiff = async (index: number): Promise<void> => {
    if (!bookId || !config) return
    if (chapterIndex === index && diff) {
      setChapterIndex(null)
      setDiff(null)
      return
    }
    setChapterIndex(index)
    setDiff(null)
    setDiffLoading(true)
    try {
      setDiff(await window.api.cleaningChapterDiff(bookId, index, config))
    } catch (reason) {
      notify(`读取章节差异失败：${errorText(reason)}`)
      setChapterIndex(null)
    } finally {
      setDiffLoading(false)
    }
  }

  const close = (): void => {
    if (!busy) onClose()
  }

  const footer =
    bookId && tab === 'report' ? (
      <>
        <button className="modal-button ghost" disabled={busy} onClick={close}>
          关闭
        </button>
        <button
          className="modal-button ghost"
          disabled={busy || previewLoading || !config}
          onClick={() => void runPreview()}
        >
          {previewLoading ? '生成中…' : '重新预览'}
        </button>
        <button
          className="modal-button"
          disabled={busy || !config || previewLoading}
          onClick={() => void apply()}
        >
          {applying ? '应用中…' : '应用到本书'}
        </button>
      </>
    ) : (
      <>
        <button className="modal-button ghost" disabled={busy} onClick={close}>
          关闭
        </button>
        <button
          className="modal-button"
          disabled={busy || !config}
          onClick={() => void saveRules().then((saved) => saved && notify('清洗规则已保存'))}
        >
          {saving ? '保存中…' : '保存规则'}
        </button>
      </>
    )

  const changedChapters =
    preview?.chapters.filter(
      (chapter) => chapter.adLinesRemoved + chapter.duplicateParagraphsMerged > 0
    ) ?? []
  const listedChapters = onlyChanged ? changedChapters : (preview?.chapters ?? [])

  return (
    <Modal wide title={bookId ? '清洗报告' : '清洗规则'} onClose={close} footer={footer}>
      {bookId && (
        <div className="cleaning-tabs">
          <button
            className={tab === 'report' ? 'active' : ''}
            onClick={() => setTab('report')}
          >
            清洗报告
          </button>
          <button className={tab === 'rules' ? 'active' : ''} onClick={() => setTab('rules')}>
            清洗规则
          </button>
        </div>
      )}

      {tab === 'rules' && (
        <div className="cleaning-rules">
          <label className="cleaning-switch">
            <input
              type="checkbox"
              checked={config?.adCleaning ?? false}
              disabled={!config || busy}
              onChange={(event) =>
                config && changeConfig({ ...config, adCleaning: event.target.checked })
              }
            />
            <span>
              <strong>启用广告清洗</strong>
              <em>关闭后不删除广告行，但仍会清理空白字符并合并重复段落。</em>
            </span>
          </label>

          <h3>内置规则</h3>
          <ul className="rule-list">
            {config?.builtinRules.map((rule) => (
              <li key={rule.id} className={rule.enabled ? '' : 'off'}>
                <label>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busy}
                    onChange={() => toggleRule('builtin', rule.id)}
                  />
                  <span className="rule-name">{rule.name}</span>
                  <span className="rule-badge">{rule.type === 'line' ? '整行' : '句内'}</span>
                </label>
                <code title={rule.pattern}>{rule.pattern}</code>
              </li>
            ))}
          </ul>

          <div className="rules-heading">
            <h3>我的规则</h3>
            <button
              className="modal-button ghost"
              disabled={busy || !config || form !== null}
              onClick={() => {
                setForm(EMPTY_FORM)
                setKeyword('')
              }}
            >
              新增规则
            </button>
          </div>

          {config && config.userRules.length === 0 && !form && (
            <p className="modal-note">还没有自定义规则。可以把常见的广告词加进来。</p>
          )}

          <ul className="rule-list">
            {config?.userRules.map((rule) => (
              <li key={rule.id} className={rule.enabled ? '' : 'off'}>
                <label>
                  <input
                    type="checkbox"
                    checked={rule.enabled}
                    disabled={busy}
                    onChange={() => toggleRule('user', rule.id)}
                  />
                  <span className="rule-name">{rule.name}</span>
                  <span className="rule-badge">{rule.type === 'line' ? '整行' : '句内'}</span>
                </label>
                <code title={rule.pattern}>{rule.pattern}</code>
                <div className="rule-actions">
                  <button className="link-button" disabled={busy} onClick={() => startEdit(rule)}>
                    编辑
                  </button>
                  <button
                    className="link-button danger"
                    disabled={busy}
                    onClick={() => removeRule(rule.id)}
                  >
                    删除
                  </button>
                </div>
              </li>
            ))}
          </ul>

          {form && (
            <div className="rule-form">
              <h4>{form.id ? '编辑规则' : '新增规则'}</h4>
              <label>
                <span>名称</span>
                <input
                  value={form.name}
                  maxLength={40}
                  placeholder="例如：某站点广告"
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                />
              </label>
              <label>
                <span>类型</span>
                <select
                  value={form.type}
                  onChange={(event) =>
                    setForm({ ...form, type: event.target.value as AdRule['type'] })
                  }
                >
                  <option value="line">整行删除</option>
                  <option value="sentence">句内删除（只处理 30 字以内的短段）</option>
                </select>
              </label>
              <label>
                <span>匹配内容</span>
                <input
                  className="rule-pattern-input"
                  value={form.pattern}
                  placeholder="例如：笔趣阁|顶点小说"
                  onChange={(event) => setForm({ ...form, pattern: event.target.value })}
                />
              </label>
              <div className="rule-helper">
                <input
                  value={keyword}
                  placeholder="输入广告关键词，多个用空格分开"
                  onChange={(event) => setKeyword(event.target.value)}
                />
                <button
                  className="modal-button ghost"
                  disabled={!keyword.trim()}
                  onClick={() => setForm({ ...form, pattern: keywordsToPattern(keyword) })}
                >
                  按关键词生成
                </button>
              </div>
              <p className="modal-note">
                关键词会转成精确匹配，不需要自己写正则。加入后点「保存规则」生效。
              </p>
              <div className="rule-form-actions">
                <button className="modal-button ghost" onClick={() => setForm(null)}>
                  取消
                </button>
                <button className="modal-button" onClick={submitForm}>
                  加入清单
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'report' && bookId && (
        <div className="cleaning-report">
          {previewDirty && (
            <div className="cleaning-stale">
              <span>规则有改动，下面的预览还是旧的。</span>
              <button
                className="modal-button ghost"
                disabled={previewLoading || busy}
                onClick={() => void runPreview()}
              >
                重新预览
              </button>
            </div>
          )}

          {previewLoading && !preview && <p className="modal-note">正在生成预览…</p>}

          {preview && (
            <>
              <div className="cleaning-summary">
                <div>
                  <strong>{preview.adLinesRemoved}</strong>
                  <span>删除广告行</span>
                </div>
                <div>
                  <strong>{preview.duplicateParagraphsMerged}</strong>
                  <span>合并重复段</span>
                </div>
                <div>
                  <strong>{preview.paragraphCount}</strong>
                  <span>保留段落</span>
                </div>
                <div>
                  <strong>{preview.chapterCount}</strong>
                  <span>章节</span>
                </div>
              </div>
              <p className="modal-note">
                《{preview.title}》当前书架已移除 {preview.appliedStats.adLinesRemoved} 行、合并{' '}
                {preview.appliedStats.duplicateParagraphsMerged} 处。应用后会按上面的结果重新生成正文并自动备份。
              </p>
              {!preview.adCleaning && (
                <p className="modal-note">广告清洗已关闭，这里只计算空白清理和重复段合并。</p>
              )}

              <h3>规则命中</h3>
              <table className="cleaning-hits">
                <thead>
                  <tr>
                    <th>规则</th>
                    <th>范围</th>
                    <th>命中</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.ruleHits.map((hit) => (
                    <tr key={`${hit.scope}-${hit.id}`} className={hit.hits === 0 ? 'off' : ''}>
                      <td>{hit.name}</td>
                      <td>{hit.scope === 'builtin' ? '内置' : '我的'}</td>
                      <td>{hit.hits}</td>
                    </tr>
                  ))}
                </tbody>
              </table>

              <div className="rules-heading">
                <h3>章节明细</h3>
                <label className="cleaning-check">
                  <input
                    type="checkbox"
                    checked={onlyChanged}
                    onChange={(event) => setOnlyChanged(event.target.checked)}
                  />
                  只看有改动的章节
                </label>
              </div>

              {listedChapters.length === 0 ? (
                <p className="modal-note">这本书没有需要改动的章节。</p>
              ) : (
                <ul className="cleaning-chapters">
                  {listedChapters.map((chapter) => (
                    <li key={chapter.index}>
                      <button
                        className={chapterIndex === chapter.index ? 'active' : ''}
                        onClick={() => void showDiff(chapter.index)}
                      >
                        <span className="chapter-title">{chapter.title}</span>
                        <span className="chapter-count">
                          {chapter.adLinesRemoved + chapter.duplicateParagraphsMerged > 0
                            ? `删除 ${chapter.adLinesRemoved} 行 · 合并 ${chapter.duplicateParagraphsMerged} 段`
                            : '无变化'}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {chapterIndex !== null && (
                <div className="cleaning-diff">
                  <h3>{diff?.title ?? '章节差异'}{diffLoading ? ' · 读取中…' : ''}</h3>
                  {diff && (
                    <>
                      <p className="modal-note">
                        红色为删除的广告内容，橙色为合并的重复段，绿色为保留的正文。
                      </p>
                      <ul>
                        {diff.lines.map((line, index) => (
                          <li key={index} className={lineClass(line)}>
                            {line.segments.map((segment, segmentIndex) =>
                              segment.removed ? (
                                <del key={segmentIndex} title={segment.ruleName}>
                                  {segment.text}
                                </del>
                              ) : (
                                <span key={segmentIndex}>{segment.text}</span>
                              )
                            )}
                            {line.removed === 'duplicate' && (
                              <span className="diff-tag">重复段</span>
                            )}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </Modal>
  )
}
