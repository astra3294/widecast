/**
 * tasks.ts 单元测试：TaskStore 的 CRUD、幂等防重复、重试、取消和统计。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { TaskStore, type PublishInput } from './tasks.js'

let tmpDir: string
let store: TaskStore

const VIDEO_INPUT: PublishInput = {
  title: '测试视频',
  videoPath: '/tmp/test.mp4',
  tags: ['搞笑', '日常'],
}

const IMAGE_INPUT: PublishInput = {
  title: '测试图文',
  imagePaths: ['/tmp/a.jpg', '/tmp/b.jpg'],
  description: '描述内容',
}

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'widecast-test-'))
  store = new TaskStore(tmpDir)
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── create ─────────────────────────────────────────────────────────────────

describe('TaskStore.create', () => {
  it('创建任务并返回', () => {
    const { task, isDuplicate } = store.create('douyin', VIDEO_INPUT)
    expect(isDuplicate).toBe(false)
    expect(task.id).toBeTruthy()
    expect(task.platform).toBe('douyin')
    expect(task.status).toBe('queued')
    expect(task.input.title).toBe('测试视频')
    expect(task.retryCount).toBe(0)
    expect(task.maxRetries).toBe(2)
    expect(task.input.contentFingerprint).toBeTruthy()
    expect(task.idempotencyKey).toBeTruthy()
  })

  it('相同输入第二次创建返回重复', () => {
    store.create('douyin', VIDEO_INPUT)
    const { isDuplicate } = store.create('douyin', VIDEO_INPUT)
    expect(isDuplicate).toBe(true)
  })

  it('已发布后再次创建相同输入仍返回原任务，防止重复发布', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    store.update(created.id, { status: 'published', receipt: { proofLevel: 'A', evidence: ['test'] } })
    const duplicate = store.create('douyin', VIDEO_INPUT)
    expect(duplicate.isDuplicate).toBe(true)
    expect(duplicate.task.id).toBe(created.id)
  })

  it('重复查询先于素材文件检查，素材移走后仍能找到已发布任务', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    store.update(created.id, { status: 'published', receipt: { proofLevel: 'A', evidence: ['test'] } })
    expect(store.findDuplicate('douyin', VIDEO_INPUT)?.id).toBe(created.id)
  })

  it('不同平台不重复', () => {
    store.create('douyin', VIDEO_INPUT)
    const { isDuplicate } = store.create('bilibili', VIDEO_INPUT)
    expect(isDuplicate).toBe(false)
  })

  it('不同内容不重复', () => {
    store.create('douyin', VIDEO_INPUT)
    const { isDuplicate } = store.create('douyin', { ...VIDEO_INPUT, title: '另一个标题' })
    expect(isDuplicate).toBe(false)
  })
})

// ─── get / list ─────────────────────────────────────────────────────────────

describe('TaskStore.get / list', () => {
  it('get 按 id 查找', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    const found = store.get(created.id)
    expect(found?.id).toBe(created.id)
  })

  it('get 不存在返回 undefined', () => {
    expect(store.get('nonexistent')).toBeUndefined()
  })

  it('list 返回所有任务', () => {
    store.create('douyin', VIDEO_INPUT)
    store.create('bilibili', IMAGE_INPUT)
    expect(store.list()).toHaveLength(2)
  })

  it('list 按平台过滤', () => {
    store.create('douyin', VIDEO_INPUT)
    store.create('bilibili', IMAGE_INPUT)
    const douyinTasks = store.list({ platform: 'douyin' })
    expect(douyinTasks).toHaveLength(1)
    expect(douyinTasks[0]!.platform).toBe('douyin')
  })
})

// ─── update ─────────────────────────────────────────────────────────────────

describe('TaskStore.update', () => {
  it('更新状态', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    const updated = store.update(created.id, { status: 'uploading', step: 'video' })
    expect(updated?.status).toBe('uploading')
    expect(updated?.step).toBe('video')
    expect(updated?.updatedAt).toBeGreaterThanOrEqual(created.updatedAt)
  })

  it('进入验证时自动设置 submittedAt', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    const updated = store.update(created.id, { status: 'submitting' })
    expect(updated?.submittedAt).toBeUndefined()
    const verifying = store.update(created.id, { status: 'verifying' })
    expect(verifying?.submittedAt).toBeTruthy()
  })

  it('更新到终态时自动设置 completedAt', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    const updated = store.update(created.id, {
      status: 'published',
      receipt: { proofLevel: 'A', evidence: ['test'] },
    })
    expect(updated?.status).toBe('published')
    expect(updated?.completedAt).toBeTruthy()
  })

  it('更新不存在的任务返回 undefined', () => {
    expect(store.update('nonexistent', { status: 'published', receipt: { proofLevel: 'A', evidence: [] } })).toBeUndefined()
  })
})

// ─── markNeedsAttention ─────────────────────────────────────────────────────

describe('TaskStore.markNeedsAttention', () => {
  it('标记为 needs_attention 并附带 receipt', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    const result = store.markNeedsAttention(created.id, '无法确认', {
      proofLevel: 'unknown',
      evidence: ['toast'],
    })
    expect(result?.status).toBe('needs_attention')
    expect(result?.message).toBe('无法确认')
    expect(result?.receipt?.proofLevel).toBe('unknown')
    expect(result?.receipt?.evidence).toContain('toast')
  })
})

// ─── retry ──────────────────────────────────────────────────────────────────

describe('TaskStore.retry', () => {
  it('retryable_failed 状态可重试', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'retryable_failed' })
    const result = store.retry(created.id)
    expect(result.ok).toBe(true)
    expect(result.task?.status).toBe('queued')
    expect(result.task?.retryCount).toBe(1)
  })

  it('needs_attention 状态可重试', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.markNeedsAttention(created.id, '不确定')
    const blocked = store.retry(created.id)
    expect(blocked.ok).toBe(false)
    const result = store.retry(created.id, { confirmedNoPublication: true })
    expect(result.ok).toBe(true)
    expect(result.task?.status).toBe('queued')
  })

  it('published 状态不可重试', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    store.update(created.id, { status: 'published', receipt: { proofLevel: 'A', evidence: ['test'] } })
    const result = store.retry(created.id)
    expect(result.ok).toBe(false)
  })

  it('超过最大重试次数不可重试', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'retryable_failed', retryCount: 2 })
    const result = store.retry(created.id)
    expect(result.ok).toBe(false)
    expect(result.message).toContain('最大重试次数')
  })

  it('重试时清除之前的 receipt', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.markNeedsAttention(created.id, '不确定', { proofLevel: 'C', evidence: ['x'] })
    const result = store.retry(created.id, { confirmedNoPublication: true, reason: '已检查内容列表' })
    expect(result.task?.receipt).toBeUndefined()
    expect(result.task?.retryHistory).toHaveLength(1)
    expect(result.task?.retryHistory[0]?.reason).toBe('已检查内容列表')
  })
})

// ─── cancel ─────────────────────────────────────────────────────────────────

describe('TaskStore.cancel', () => {
  it('queued 状态可取消', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    const result = store.cancel(created.id)
    expect(result.ok).toBe(true)
    const task = store.get(created.id)
    expect(task?.status).toBe('cancelled')
    expect(task?.completedAt).toBeTruthy()
  })

  it('published 状态不可取消', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    store.update(created.id, { status: 'submitting' })
    store.update(created.id, { status: 'published', receipt: { proofLevel: 'A', evidence: ['test'] } })
    const result = store.cancel(created.id)
    expect(result.ok).toBe(false)
  })

  it('uploading 状态不可取消（正在执行）', () => {
    const { task: created } = store.create('douyin', VIDEO_INPUT)
    store.update(created.id, { status: 'uploading' })
    const result = store.cancel(created.id)
    expect(result.ok).toBe(false)
  })
})

// ─── stats ──────────────────────────────────────────────────────────────────

describe('TaskStore.stats', () => {
  it('统计正确', () => {
    store.create('douyin', VIDEO_INPUT)
    store.create('douyin', IMAGE_INPUT)
    const { task: created3 } = store.create('bilibili', VIDEO_INPUT)
    store.update(created3.id, { status: 'uploading' })
    store.update(created3.id, { status: 'submitting' })
    store.update(created3.id, { status: 'published', receipt: { proofLevel: 'A', evidence: ['test'] } })

    const stats = store.stats()
    expect(stats.total).toBe(3)
    expect(stats.byPlatform['douyin']).toBe(2)
    expect(stats.byPlatform['bilibili']).toBe(1)
    expect(stats.byStatus['queued']).toBe(2)
    expect(stats.byStatus['published']).toBe(1)
  })
})

// ─── 持久化 ─────────────────────────────────────────────────────────────────

describe('TaskStore 持久化', () => {
  it('新建 store 能读取之前保存的数据', () => {
    store.create('douyin', VIDEO_INPUT)
    const store2 = new TaskStore(tmpDir)
    expect(store2.list()).toHaveLength(1)
    expect(store2.list()[0]!.platform).toBe('douyin')
  })

  it('幂等键跨 store 实例生效', () => {
    store.create('douyin', VIDEO_INPUT)
    const store2 = new TaskStore(tmpDir)
    const { isDuplicate } = store2.create('douyin', VIDEO_INPUT)
    expect(isDuplicate).toBe(true)
  })

  it('读取旧版 publishing/done 任务时迁移到 submitting/published', () => {
    writeFileSync(join(tmpDir, 'tasks.json'), JSON.stringify([{
      id: 'legacy-task',
      platform: 'douyin',
      input: { title: '旧任务', videoPath: '/tmp/legacy.mp4' },
      status: 'done',
      step: 'verified',
      retryCount: 0,
      maxRetries: 2,
      createdAt: 1,
      updatedAt: 1,
    }]))
    const migrated = new TaskStore(tmpDir).get('legacy-task')
    expect(migrated?.status).toBe('published')
    expect(migrated?.accountId).toBe('douyin')
    expect(migrated?.retryHistory).toEqual([])
  })
})
