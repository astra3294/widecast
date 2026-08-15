/**
 * 账号存储:平台账号与会话状态落盘(JSON 文件,~/.widecast/accounts.json)。
 * 凭证本体在浏览器档案目录里(由 Chromium 加密/保管),这里只存元数据与状态。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export type AccountStatus = 'ok' | 'expired' | 'unknown'

export interface AccountRecord {
  platform: string
  /** 显示名;默认 = 平台名 */
  name: string
  addedAt: number
  lastCheckedAt?: number
  status: AccountStatus
  lastError?: string
}

export class AccountStore {
  private readonly file: string
  private records: AccountRecord[] | null = null

  constructor(baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
    this.file = join(baseDir, 'accounts.json')
  }

  list(): AccountRecord[] {
    return [...this.load()]
  }

  get(platform: string): AccountRecord | undefined {
    return this.load().find((record) => record.platform === platform)
  }

  upsert(record: AccountRecord): void {
    const records = this.load()
    const index = records.findIndex((item) => item.platform === record.platform)
    if (index >= 0) records[index] = { ...records[index], ...record }
    else records.push(record)
    this.save(records)
  }

  remove(platform: string): boolean {
    const records = this.load()
    const next = records.filter((item) => item.platform !== platform)
    if (next.length === records.length) return false
    this.save(next)
    return true
  }

  private load(): AccountRecord[] {
    if (this.records !== null) return this.records
    if (!existsSync(this.file)) {
      this.records = []
      return this.records
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.records = Array.isArray(parsed) ? (parsed as AccountRecord[]) : []
    } catch {
      this.records = []
    }
    return this.records
  }

  private save(records: AccountRecord[]): void {
    this.records = records
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(records, null, 2), 'utf8')
    // 原子替换:Windows 上 rename 目标存在时可能失败,先尝试直写
    try {
      writeFileSync(this.file, JSON.stringify(records, null, 2), 'utf8')
      return
    } catch {
      /* fallthrough to rename */
    }
    try { rmSync(this.file, { force: true }) } catch { /* ignore */ }
    renameSync(tmp, this.file)
  }
}
