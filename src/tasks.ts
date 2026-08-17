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
  computeContentFingerprint,
  computeIdempotencyKey,
  isTerminalStatus,
} from './types.js'

export type { TaskStatus, PublishInput, PublishTask, PublishReceipt, ProofLevel }

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
    options: { accountId?: string; maxRetries?: number } = {},
  ): { task: PublishTask; isDuplicate: boolean } {
    const tasks = this.load()

    // 计算内容指纹和幂等键
    const contentFingerprint = computeContentFingerprint(input)
    const accountId = options.accountId ?? platform
    const idempotencyKey = computeIdempotencyKey(accountId, platform, contentFingerprint)

    // 幂等检查：查找相同幂等键的非终态任务
    const existing = tasks.find(
      (t) => t.idempotencyKey === idempotencyKey && !isTerminalStatus(t.status),
    )
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

    Object.assign(task, patch, { updatedAt: Date.now() })

    // 自动设置时间戳
    if (patch.status === 'publishing' && task.submittedAt === undefined) {
      task.submittedAt = Date.now()
    }
    if (patch.status === 'done' || patch.status === 'terminal_failed' || patch.status === 'cancelled') {
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
        proofLevel: receipt.proofLevel ?? 'unknown',
        evidence: receipt.evidence ?? [],
        ...receipt,
      }
    }

    this.save(tasks)
    return task
  }

  /** 增加重试计数并重置为 queued（仅 retryable_failed 状态允许）。 */
  retry(id: string): { ok: boolean; task?: PublishTask; message?: string } {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return { ok: false, message: '任务不存在' }
    if (task.status !== 'retryable_failed' && task.status !== 'needs_attention') {
      return { ok: false, message: `状态 ${task.status} 不允许重试` }
    }
    if (task.retryCount >= task.maxRetries) {
      return { ok: false, message: `已达到最大重试次数 (${task.maxRetries})` }
    }

    task.retryCount += 1
    task.status = 'queued'
    task.step = 'retry'
    task.message = `第 ${task.retryCount} 次重试`
    task.updatedAt = Date.now()
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
    if (task.status === 'uploading' || task.status === 'publishing' || task.status === 'verifying') {
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
        this.tasks = (parsed as PublishTask[]).map((task) => ({
          ...task,
          retryCount: task.retryCount ?? 0,
          maxRetries: task.maxRetries ?? 2,
          input: {
            ...task.input,
            contentFingerprint: task.input.contentFingerprint ?? '',
          },
          idempotencyKey: task.idempotencyKey ?? '',
        }))
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
