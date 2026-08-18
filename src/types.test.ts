/**
 * types.ts 单元测试：状态机、幂等键、内容指纹、状态判断函数。
 */
import { describe, it, expect } from 'vitest'
import {
  type TaskStatus,
  type PublishInput,
  computeContentFingerprint,
  computeIdempotencyKey,
  isTerminalStatus,
  isRetryableStatus,
  isRunningStatus,
  hasSubmissionEvidence,
} from './types.js'

// ─── computeContentFingerprint ──────────────────────────────────────────────

describe('computeContentFingerprint', () => {
  it('相同输入产生相同指纹', () => {
    const input: PublishInput = { title: '测试标题', videoPath: '/tmp/test.mp4' }
    const a = computeContentFingerprint(input)
    const b = computeContentFingerprint(input)
    expect(a).toBe(b)
  })

  it('不同标题产生不同指纹', () => {
    const a = computeContentFingerprint({ title: '标题A', videoPath: '/tmp/a.mp4' })
    const b = computeContentFingerprint({ title: '标题B', videoPath: '/tmp/a.mp4' })
    expect(a).not.toBe(b)
  })

  it('不同视频路径产生不同指纹', () => {
    const a = computeContentFingerprint({ title: '同标题', videoPath: '/tmp/a.mp4' })
    const b = computeContentFingerprint({ title: '同标题', videoPath: '/tmp/b.mp4' })
    expect(a).not.toBe(b)
  })

  it('图文和视频产生不同指纹', () => {
    const video = computeContentFingerprint({ title: '测试', videoPath: '/tmp/a.mp4' })
    const image = computeContentFingerprint({ title: '测试', imagePaths: ['/tmp/a.jpg'] })
    expect(video).not.toBe(image)
  })

  it('标签顺序影响指纹', () => {
    const a = computeContentFingerprint({ title: '测试', tags: ['A', 'B'] })
    const b = computeContentFingerprint({ title: '测试', tags: ['B', 'A'] })
    expect(a).not.toBe(b)
  })

  it('正文和封面变化会影响指纹', () => {
    const a = computeContentFingerprint({ title: '测试', videoPath: '/tmp/a.mp4', description: 'A', coverPath: '/tmp/a.jpg' })
    const b = computeContentFingerprint({ title: '测试', videoPath: '/tmp/a.mp4', description: 'B', coverPath: '/tmp/b.jpg' })
    expect(a).not.toBe(b)
  })

  it('指纹长度为 16', () => {
    const fp = computeContentFingerprint({ title: '任意', videoPath: '/x.mp4' })
    expect(fp).toHaveLength(16)
  })
})

// ─── computeIdempotencyKey ─────────────────────────────────────────────────

describe('computeIdempotencyKey', () => {
  it('相同参数产生相同键', () => {
    const a = computeIdempotencyKey('acc1', 'douyin', 'fp123')
    const b = computeIdempotencyKey('acc1', 'douyin', 'fp123')
    expect(a).toBe(b)
  })

  it('不同账号产生不同键', () => {
    const a = computeIdempotencyKey('acc1', 'douyin', 'fp123')
    const b = computeIdempotencyKey('acc2', 'douyin', 'fp123')
    expect(a).not.toBe(b)
  })

  it('不同平台产生不同键', () => {
    const a = computeIdempotencyKey('acc1', 'douyin', 'fp123')
    const b = computeIdempotencyKey('acc1', 'bilibili', 'fp123')
    expect(a).not.toBe(b)
  })

  it('不同时间桶产生不同键', () => {
    const a = computeIdempotencyKey('acc1', 'douyin', 'fp123', 'now')
    const b = computeIdempotencyKey('acc1', 'douyin', 'fp123', '2026-08-20T20:00')
    expect(a).not.toBe(b)
  })

  it('键长度为 16', () => {
    const key = computeIdempotencyKey('acc', 'douyin', 'fp')
    expect(key).toHaveLength(16)
  })
})

// ─── isTerminalStatus ──────────────────────────────────────────────────────

describe('isTerminalStatus', () => {
  const terminal: TaskStatus[] = ['published', 'terminal_failed', 'cancelled']
  const nonTerminal: TaskStatus[] = ['draft', 'scheduled', 'queued', 'uploading', 'submitting', 'verifying', 'needs_attention', 'retryable_failed']

  for (const status of terminal) {
    it(`${status} 是终态`, () => {
      expect(isTerminalStatus(status)).toBe(true)
    })
  }

  for (const status of nonTerminal) {
    it(`${status} 不是终态`, () => {
      expect(isTerminalStatus(status)).toBe(false)
    })
  }
})

// ─── isRetryableStatus ─────────────────────────────────────────────────────

describe('isRetryableStatus', () => {
  it('retryable_failed 可重试', () => {
    expect(isRetryableStatus('retryable_failed')).toBe(true)
  })

  it('needs_attention 可重试', () => {
    expect(isRetryableStatus('needs_attention')).toBe(true)
  })

  it('published 不可重试', () => {
    expect(isRetryableStatus('published')).toBe(false)
  })

  it('terminal_failed 不可重试', () => {
    expect(isRetryableStatus('terminal_failed')).toBe(false)
  })

  it('queued 不可重试', () => {
    expect(isRetryableStatus('queued')).toBe(false)
  })
})

// ─── isRunningStatus ───────────────────────────────────────────────────────

describe('isRunningStatus', () => {
  it('uploading 是运行中', () => {
    expect(isRunningStatus('uploading')).toBe(true)
  })

  it('submitting 是运行中', () => {
    expect(isRunningStatus('submitting')).toBe(true)
  })

  it('verifying 是运行中', () => {
    expect(isRunningStatus('verifying')).toBe(true)
  })

  it('queued 不是运行中', () => {
    expect(isRunningStatus('queued')).toBe(false)
  })

  it('published 不是运行中', () => {
    expect(isRunningStatus('published')).toBe(false)
  })
})

describe('hasSubmissionEvidence', () => {
  it('提交中或已有提交时间视为已进入不可自动重发阶段', () => {
    expect(hasSubmissionEvidence({ status: 'submitting', submittedAt: undefined })).toBe(true)
    expect(hasSubmissionEvidence({ status: 'retryable_failed', submittedAt: 1 })).toBe(true)
  })

  it('仅上传失败且没有提交时间不视为已提交', () => {
    expect(hasSubmissionEvidence({ status: 'retryable_failed', submittedAt: undefined })).toBe(false)
  })
})
