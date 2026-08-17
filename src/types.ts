/**
 * 任务状态与类型定义：完整状态机 + 发布凭证 + 幂等键。
 *
 * 状态机（参照 WIDECAST_TECHNICAL_MASTER_PLAN §7.1）：
 *   draft → validating → scheduled / queued → preparing → uploading
 *   → submitting → verifying → published
 *              ↘ needs_attention
 *   任一步骤失败 → retryable_failed / terminal_failed / cancelled
 */
import { randomUUID, createHash } from 'node:crypto'

// ─── 任务状态 ────────────────────────────────────────────────────────────────

export type TaskStatus =
  | 'draft'
  | 'queued'
  | 'uploading'
  | 'publishing'    // submitting 阶段
  | 'verifying'
  | 'done'          // published
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
  /** 提交时间 ISO。 */
  submittedAt?: string
  /** 证明等级。 */
  proofLevel: ProofLevel
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
  accountId?: string
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
  createdAt: number
  updatedAt: number
  submittedAt?: number
  completedAt?: number
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 计算内容指纹：SHA-256(title + videoPath/imagePaths + tags)。 */
export function computeContentFingerprint(input: PublishInput): string {
  const parts = [
    input.title,
    input.videoPath ?? '',
    (input.imagePaths ?? []).join(','),
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
  return status === 'done' || status === 'terminal_failed' || status === 'cancelled'
}

/** 判断状态是否可重试。 */
export function isRetryableStatus(status: TaskStatus): boolean {
  return status === 'retryable_failed' || status === 'needs_attention'
}

/** 判断状态是否正在执行中。 */
export function isRunningStatus(status: TaskStatus): boolean {
  return status === 'uploading' || status === 'publishing' || status === 'verifying'
}
