import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { RuleRepository } from '../src/main/storage/rules'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'reader-rules-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('RuleRepository', () => {
  it('assigns ids and persists user rules', async () => {
    const repo = new RuleRepository(root)
    const saved = await repo.save([
      { name: '我的广告', type: 'line', pattern: '广告', enabled: true },
      { id: 'user-2', name: '短句', type: 'sentence', pattern: '记住', enabled: false }
    ])

    expect(saved[0].id).toMatch(/^user-/)
    expect(saved[1]).toEqual({
      id: 'user-2',
      name: '短句',
      type: 'sentence',
      pattern: '记住',
      enabled: false
    })
    expect(await repo.read()).toEqual(saved)

    const raw = JSON.parse(await readFile(join(root, 'rules', 'user-ads.json'), 'utf8'))
    expect(raw.version).toBe(1)
    expect(raw.rules).toHaveLength(2)
  })

  it('rejects invalid rules without writing them', async () => {
    const repo = new RuleRepository(root)

    await expect(
      repo.save([{ name: '坏规则', type: 'line', pattern: '(', enabled: true }])
    ).rejects.toThrow('正则无效')
    await expect(
      repo.save([{ name: '  ', type: 'line', pattern: '正文', enabled: true }])
    ).rejects.toThrow('规则名称不能为空')
    await expect(
      repo.save([{ id: 'url', name: '撞车', type: 'line', pattern: '正文', enabled: true }])
    ).rejects.toThrow('自定义规则编号与内置规则冲突')

    expect(await repo.read()).toEqual([])
  })

  it('skips broken entries instead of losing the whole file', async () => {
    await mkdir(join(root, 'rules'), { recursive: true })
    await writeFile(
      join(root, 'rules', 'user-ads.json'),
      JSON.stringify({
        version: 1,
        rules: [
          { id: 'user-1', name: '好规则', type: 'line', pattern: '广告', enabled: true },
          { id: 'user-2', name: '坏规则', type: 'line', pattern: '(', enabled: true }
        ]
      })
    )

    const rules = await new RuleRepository(root).read()
    expect(rules.map((rule) => rule.name)).toEqual(['好规则'])
  })
})
