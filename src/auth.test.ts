import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { getOrCreateServerToken, readServerToken } from './auth.js'

describe('本地服务 token', () => {
  it('首次生成并可被 DSH 客户端复用', () => {
    const dir = mkdtempSync(join(tmpdir(), 'widecast-auth-'))
    try {
      const first = getOrCreateServerToken(dir)
      const second = getOrCreateServerToken(dir)
      expect(first).toHaveLength(64)
      expect(second).toBe(first)
      expect(readServerToken(dir)).toBe(first)
      expect(readFileSync(join(dir, 'server-token'), 'utf8').trim()).toBe(first)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
