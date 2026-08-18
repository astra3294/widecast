/**
 * 发布任务存储：任务状态逐步落盘（断点恢复基础），JSON 文件。
 *
 * 支持完整状态机、幂等键、发布凭证和重试记录。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import {
  type TaskStatus,
  type PublishInput,
  type PublishTask,
  type PublishReceipt,
  type ProofLevel,
  type RetryRecord,
  computeContentFingerprint,
  computeIdempotencyKey,
  hasSubmissionEvidence,
  isTerminalStatus,
} from './types.js'

export type { TaskStatus, PublishInput, PublishTask, PublishReceipt, ProofLevel, RetryRecord }

export class TaskStore {
  private readonly file: string
  private tasks: PublishTask[] | null = null

  constructor(baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
    this.file = join(baseDir, 'tasks.json')
  }

  /**
   * 创建发布任务（带幂等检查）。
   * 如果已存在相同幂等键的非终态任务，返回现有任务而不是创建新的。
   */
  create(
    platform: string,
    input: PublishInput,
    options: { accountId?: string; maxRetries?: number; scheduledTimeBucket?: string } = {},
  ): { task: PublishTask; isDuplicate: boolean } {
    const tasks = this.load()

    // 计算内容指纹和幂等键
    const contentFingerprint = computeContentFingerprint(input)
    const accountId = options.accountId ?? platform
    const idempotencyKey = computeIdempotencyKey(
      accountId,
      platform,
      contentFingerprint,
      options.scheduledTimeBucket ?? 'now',
    )

    // 幂等检查：提交前的任务、提交后的不确定任务和已发布任务都阻止新建。
    // 只有明确在提交前终止的失败/取消任务允许创建新的同键任务。
    const existing = tasks.find((t) => t.idempotencyKey === idempotencyKey && isDuplicateCandidate(t))
    if (existing !== undefined) {
      return { task: existing, isDuplicate: true }
    }

    const task: PublishTask = {
      id: randomUUID(),
      platform,
      accountId,
      input: { ...input, contentFingerprint },
      idempotencyKey,
      status: 'queued',
      step: 'created',
      retryCount: 0,
      maxRetries: options.maxRetries ?? 2,
      retryHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    tasks.unshift(task)
    this.save(tasks)
    return { task, isDuplicate: false }
  }

  get(id: string): PublishTask | undefined {
    return this.load().find((task) => task.id === id)
  }

  /** 根据幂等键查找任务。 */
  getByIdempotencyKey(key: string): PublishTask | undefined {
    return this.load().find((task) => task.idempotencyKey === key)
  }

  /**
   * 在文件校验之前查找会阻止重复发布的任务。
   * 这样即使原素材后来被移动/删除，重复请求也会先返回已存在的发布结果。
   */
  findDuplicate(
    platform: string,
    input: PublishInput,
    options: { accountId?: string; scheduledTimeBucket?: string } = {},
  ): PublishTask | undefined {
    const accountId = options.accountId ?? platform
    const fingerprint = computeContentFingerprint(input)
    const key = computeIdempotencyKey(accountId, platform, fingerprint, options.scheduledTimeBucket ?? 'now')
    return this.load().find((task) => task.idempotencyKey === key && isDuplicateCandidate(task))
  }

  list(options: { platform?: string; status?: TaskStatus; limit?: number } = {}): PublishTask[] {
    let tasks = this.load()
    if (options.platform !== undefined) {
      tasks = tasks.filter((t) => t.platform === options.platform)
    }
    if (options.status !== undefined) {
      tasks = tasks.filter((t) => t.status === options.status)
    }
    if (options.limit !== undefined) {
      tasks = tasks.slice(0, options.limit)
    }
    return [...tasks]
  }

  /** 更新任务状态与步骤（自动落盘）。 */
  update(id: string, patch: Partial<Pick<PublishTask,
    'status' | 'step' | 'message' | 'receipt' | 'retryCount' | 'submittedAt' | 'completedAt' | 'accountId'
  >>): PublishTask | undefined {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return undefined

    if (patch.status !== undefined && patch.status !== task.status
      && !isAllowedTransition(task.status, patch.status)) {
      return undefined
    }
    if (patch.status === 'published' && patch.receipt === undefined && task.receipt === undefined) {
      return undefined
    }

    Object.assign(task, patch, { updatedAt: Date.now() })

    // 自动设置时间戳
    if (patch.status === 'verifying' && task.submittedAt === undefined) {
      task.submittedAt = Date.now()
    }
    if (patch.status === 'published' || patch.status === 'terminal_failed' || patch.status === 'cancelled') {
      task.completedAt = Date.now()
    }

    this.save(tasks)
    return task
  }

  /**
   * 标记任务为 needs_attention：已提交但无法确认结果。
   * 不会自动重发，需要人工或 Agent 确认。
   */
  markNeedsAttention(id: string, message: string, receipt?: Partial<PublishReceipt>): PublishTask | undefined {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return undefined

    task.status = 'needs_attention'
    task.step = 'unverified'
    task.message = message
    task.updatedAt = Date.now()
    if (receipt !== undefined) {
      task.receipt = {
        ...receipt,
        proofLevel: receipt.proofLevel ?? 'unknown',
        evidence: receipt.evidence ?? [],
      }
    }

    this.save(tasks)
    return task
  }

  /**
   * 增加重试计数并重置为 queued。
   *
   * 对已提交但无法确认的任务，必须由调用方明确确认“平台内容列表中没有该作品”，
   * 才能重试；这样不会因为网络超时而自动重复发布。
   */
  retry(
    id: string,
    options: { confirmedNoPublication?: boolean; reason?: string } = {},
  ): { ok: boolean; task?: PublishTask; message?: string } {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return { ok: false, message: '任务不存在' }
    if (task.status !== 'retryable_failed' && task.status !== 'needs_attention') {
      return { ok: false, message: `状态 ${task.status} 不允许重试` }
    }
    if ((task.status === 'needs_attention' || task.submittedAt !== undefined)
      && options.confirmedNoPublication !== true) {
      return { ok: false, message: '任务已提交但结果不确定；请先确认平台内容列表中没有该作品，再明确确认重试' }
    }
    if (task.retryCount >= task.maxRetries) {
      return { ok: false, message: `已达到最大重试次数 (${task.maxRetries})` }
    }

    const fromStatus = task.status
    task.retryCount += 1
    task.retryHistory.push({
      attempt: task.retryCount,
      at: Date.now(),
      fromStatus,
      ...(options.reason !== undefined ? { reason: options.reason } : {}),
    })
    task.status = 'queued'
    task.step = 'retry'
    task.message = `第 ${task.retryCount} 次重试`
    task.updatedAt = Date.now()
    delete task.submittedAt
    delete task.completedAt
    // 清除之前的凭证（如有），因为要重新发布
    delete task.receipt

    this.save(tasks)
    return { ok: true, task }
  }

  /** 取消任务（仅非终态和非执行中状态允许）。 */
  cancel(id: string): { ok: boolean; message?: string } {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return { ok: false, message: '任务不存在' }
    if (isTerminalStatus(task.status)) return { ok: false, message: '任务已完成' }
    if (task.status === 'uploading' || task.status === 'submitting' || task.status === 'verifying') {
      return { ok: false, message: '任务正在执行中，无法取消' }
    }

    task.status = 'cancelled'
    task.step = 'cancelled'
    task.message = '用户取消'
    task.updatedAt = Date.now()
    task.completedAt = Date.now()

    this.save(tasks)
    return { ok: true }
  }

  /** 获取任务统计。 */
  stats(): { total: number; byStatus: Record<string, number>; byPlatform: Record<string, number> } {
    const tasks = this.load()
    const byStatus: Record<string, number> = {}
    const byPlatform: Record<string, number> = {}
    for (const task of tasks) {
      byStatus[task.status] = (byStatus[task.status] ?? 0) + 1
      byPlatform[task.platform] = (byPlatform[task.platform] ?? 0) + 1
    }
    return { total: tasks.length, byStatus, byPlatform }
  }

  private load(): PublishTask[] {
    if (this.tasks !== null) return this.tasks
    if (!existsSync(this.file)) {
      this.tasks = []
      return this.tasks
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      if (Array.isArray(parsed)) {
        // 兼容旧格式：为缺少新字段的任务添加默认值
        this.tasks = (parsed as Array<Partial<PublishTask> & { status?: string }>).map((task) => ({
          ...task,
          status: normalizeTaskStatus(task.status),
          accountId: task.accountId ?? task.platform ?? 'unknown',
          retryCount: task.retryCount ?? 0,
          maxRetries: task.maxRetries ?? 2,
          retryHistory: task.retryHistory ?? [],
          input: {
            ...(task.input ?? { title: '' }),
            contentFingerprint: task.input?.contentFingerprint ?? '',
          },
          idempotencyKey: task.idempotencyKey ?? '',
        })) as PublishTask[]
      } else {
        this.tasks = []
      }
    } catch {
      this.tasks = []
    }
    return this.tasks
  }

  private save(tasks: PublishTask[]): void {
    this.tasks = tasks
    const json = JSON.stringify(tasks, null, 2)
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, json, 'utf8')
    try {
      writeFileSync(this.file, json, 'utf8')
    } catch {
      try { rmSync(this.file, { force: true }) } catch { /* ignore */ }
      renameSync(tmp, this.file)
    }
  }
}

/** 读取旧版本任务时把历史状态迁移到当前规范名称。 */
function normalizeTaskStatus(status: string | undefined): TaskStatus {
  if (status === 'done') return 'published'
  if (status === 'publishing') return 'submitting'
  const current: TaskStatus[] = [
    'draft', 'scheduled', 'queued', 'uploading', 'submitting', 'verifying',
    'published', 'needs_attention', 'retryable_failed', 'terminal_failed', 'cancelled',
  ]
  return current.includes(status as TaskStatus) ? status as TaskStatus : 'terminal_failed'
}

/** 发布任务允许的状态跃迁；重试由 TaskStore.retry 单独处理。 */
function isAllowedTransition(from: TaskStatus, to: TaskStatus): boolean {
  if (from === to) return true
  const allowed: Record<TaskStatus, TaskStatus[]> = {
    draft: ['scheduled', 'queued', 'cancelled'],
    scheduled: ['queued', 'cancelled'],
    queued: ['uploading', 'retryable_failed', 'terminal_failed', 'needs_attention', 'cancelled'],
    uploading: ['submitting', 'retryable_failed', 'terminal_failed', 'needs_attention'],
    submitting: ['verifying', 'published', 'needs_attention', 'retryable_failed', 'terminal_failed'],
    verifying: ['published', 'needs_attention', 'retryable_failed', 'terminal_failed'],
    published: [],
    needs_attention: [],
    retryable_failed: [],
    terminal_failed: [],
    cancelled: [],
  }
  return allowed[from].includes(to)
}

function isDuplicateCandidate(task: PublishTask): boolean {
  return !isTerminalStatus(task.status) || hasSubmissionEvidence(task)
}
