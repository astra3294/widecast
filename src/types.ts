/**
 * 任务状态与类型定义：完整状态机 + 发布凭证 + 幂等键。
 *
 * 状态机（参照 WIDECAST_TECHNICAL_MASTER_PLAN §7.1）：
 *   draft → scheduled / queued → uploading → submitting → verifying → published
 *                                                           ↘ needs_attention
 *   任一步骤失败 → retryable_failed / terminal_failed / cancelled
 */
import { createHash } from 'node:crypto'

// ─── 任务状态 ────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'draft'
  | 'scheduled'
  | 'queued'
  | 'uploading'
  | 'submitting'
  | 'verifying'
  | 'published'
  | 'needs_attention'
  | 'retryable_failed'
  | 'terminal_failed'
  | 'cancelled'

// ─── 发布凭证 ────────────────────────────────────────────────────────────────

/** 证明等级（参照 §7.3）。 */
export type ProofLevel = 'A' | 'B' | 'C' | 'unknown'

/** 发布凭证：每次发布的结果证明。 */
export interface PublishReceipt {
  /** 平台返回的作品 ID（如有）。 */
  platformPublicationId?: string
  /** 作品 URL（如有）。 */
  url?: string
  /** 产生证据的请求 URL（只保留路径，不含查询参数）。 */
  responseUrl?: string
  /** 提交时间 ISO。 */
  submittedAt?: string
  /** 证明等级。 */
  proofLevel: ProofLevel
  /** 证明方式，例如 network-response / content-list / success-toast。 */
  verificationMethod?: string
  /** 证据来源列表。 */
  evidence: string[]
  /** 平台返回的原始信息（截断保存）。 */
  rawResponse?: string
}

// ─── 发布输入 ────────────────────────────────────────────────────────────────

export interface PublishInput {
  title: string
  description?: string
  videoPath?: string
  imagePaths?: string[]
  coverPath?: string
  tags?: string[]
  /** 内容指纹（自动计算）。 */
  contentFingerprint?: string
}

// ─── 发布任务 ────────────────────────────────────────────────────────────────

export interface PublishTask {
  id: string
  platform: string
  /** 当前版本每个平台一个默认账号；后续多账号时使用稳定账号 ID。 */
  accountId: string
  input: PublishInput
  /** 幂等键：SHA-256(account-id + platform + content-fingerprint + scheduled-time-bucket)。 */
  idempotencyKey?: string
  status: TaskStatus
  step: string
  message?: string
  receipt?: PublishReceipt
  /** 重试次数。 */
  retryCount: number
  /** 最大重试次数。 */
  maxRetries: number
  /** 每次人工/系统重试的记录。 */
  retryHistory: RetryRecord[]
  createdAt: number
  updatedAt: number
  submittedAt?: number
  completedAt?: number
}

export interface RetryRecord {
  attempt: number
  at: number
  fromStatus: TaskStatus
  reason?: string
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/**
 * 计算输入指纹：SHA-256(标题 + 正文 + 素材路径 + 封面 + 标签)。
 *
 * 这是任务输入指纹而不是文件内容 hash；发布前仍会校验文件存在性，
 * 后续 Worker/Asset Manager 阶段再升级为素材内容 hash。
 */
export function computeContentFingerprint(input: PublishInput): string {
  const parts = [
    input.title.trim(),
    input.description?.trim() ?? '',
    input.videoPath ?? '',
    (input.imagePaths ?? []).join(','),
    input.coverPath ?? '',
    (input.tags ?? []).join(','),
  ].join('\x00')
  return createHash('sha256').update(parts).digest('hex').slice(0, 16)
}

/** 计算幂等键：SHA-256(account-id + platform + content-fingerprint + time-bucket)。 */
export function computeIdempotencyKey(
  accountId: string,
  platform: string,
  contentFingerprint: string,
  scheduledTimeBucket: string = 'now',
): string {
  const raw = `${accountId}\x00${platform}\x00${contentFingerprint}\x00${scheduledTimeBucket}`
  return createHash('sha256').update(raw).digest('hex').slice(0, 16)
}

/** 判断状态是否为终态。 */
export function isTerminalStatus(status: TaskStatus): boolean {
  return status === 'published' || status === 'terminal_failed' || status === 'cancelled'
}

/** 判断状态是否可重试。 */
export function isRetryableStatus(status: TaskStatus): boolean {
  return status === 'retryable_failed' || status === 'needs_attention'
}

/** 判断状态是否正在执行中。 */
export function isRunningStatus(status: TaskStatus): boolean {
  return status === 'uploading' || status === 'submitting' || status === 'verifying'
}

/** 判断任务是否已经进入提交之后的阶段。 */
export function hasSubmissionEvidence(task: Pick<PublishTask, 'status' | 'submittedAt'>): boolean {
  return task.submittedAt !== undefined
    || task.status === 'submitting'
    || task.status === 'verifying'
    || task.status === 'published'
    || task.status === 'needs_attention'
}
