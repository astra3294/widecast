/**
 * 账号服务:把 浏览器档案 + 账号存储 + 登录态探测 串起来。
 */
import { AccountStore, type AccountRecord, type AccountStatus } from './accounts.js'
import { BrowserManager } from './browser.js'
import { detectLoginState, findPlatform, PLATFORMS } from './platforms.js'

export interface AddAccountResult {
  ok: boolean
  needsHuman?: boolean
  platform: string
  status: 'ok' | 'timeout' | 'cancelled'
  message: string
}

export interface AccountView {
  platform: string
  name: string
  status: AccountStatus
  addedAt: number
  lastCheckedAt?: number
  lastError?: string
}

export class WidecastService {
  readonly accounts: AccountStore
  readonly browser: BrowserManager

  constructor(baseDir: string) {
    this.accounts = new AccountStore(baseDir)
    this.browser = new BrowserManager(baseDir)
  }

  listPlatforms() {
    return PLATFORMS.map((platform) => ({ id: platform.id, name: platform.name, publishUrl: platform.publishUrl }))
  }

  listAccounts(): AccountView[] {
    return this.accounts.list().map((record) => ({
      platform: record.platform,
      name: record.name,
      status: record.status,
      addedAt: record.addedAt,
      lastCheckedAt: record.lastCheckedAt,
      lastError: record.lastError,
    }))
  }

  /**
   * 添加账号:打开平台登录页,轮询登录成功。
   * waitMs>0 时阻塞轮询(供模型工具);waitMs=0 时立即返回,由面板自行轮询 listAccounts。
   */
  async addAccount(platformId: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<AddAccountResult> {
    const platform = findPlatform(platformId)
    if (platform === undefined) {
      return { ok: false, platform: platformId, status: 'timeout', message: `未知平台:${platformId}` }
    }
    const context = await this.browser.contextFor(platformId)
    const page = await this.browser.openPage(platformId, platform.loginUrl)

    const checkNow = (): boolean => {
      for (const candidate of context.pages()) {
        try {
          if (detectLoginState(platform, candidate.url()) === 'logged-in') return true
        } catch { /* page closed mid-check */ }
      }
      return false
    }

    if (checkNow()) {
      this.accounts.upsert({
        platform: platformId,
        name: platform.name,
        addedAt: Date.now(),
        lastCheckedAt: Date.now(),
        status: 'ok',
      })
      return { ok: true, platform: platformId, status: 'ok', message: `${platform.name} 已登录并保存` }
    }

    const waitMs = options.waitMs ?? 0
    if (waitMs <= 0) {
      return { ok: true, needsHuman: true, platform: platformId, status: 'timeout', message: `已打开 ${platform.name} 登录页,请在浏览器窗口完成登录(扫码)` }
    }

    const signal = options.signal
    const deadline = Date.now() + waitMs
    while (Date.now() < deadline) {
      if (signal?.aborted === true) {
        return { ok: false, platform: platformId, status: 'cancelled', message: '已取消' }
      }
      if (checkNow()) {
        this.accounts.upsert({
          platform: platformId,
          name: platform.name,
          addedAt: Date.now(),
          lastCheckedAt: Date.now(),
          status: 'ok',
        })
        return { ok: true, platform: platformId, status: 'ok', message: `${platform.name} 登录成功,账号已保存` }
      }
      await sleep(2000, signal)
    }
    return { ok: true, needsHuman: true, platform: platformId, status: 'timeout', message: `等待 ${platform.name} 登录超时;完成登录后再试` }
  }

  /** 健康检查:打开创作者后台,按 URL 判定登录态。 */
  async checkAccount(platformId: string): Promise<AccountView | undefined> {
    const platform = findPlatform(platformId)
    if (platform === undefined) return undefined
    const record = this.accounts.get(platformId)
    if (record === undefined) return undefined
    try {
      const page = await this.browser.openPage(platformId, platform.homeUrl)
      await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
      await sleep(1500)
      const state = detectLoginState(platform, page.url())
      const status: AccountStatus = state === 'logged-in' ? 'ok' : state === 'login-page' ? 'expired' : 'unknown'
      const updated: AccountRecord = { ...record, status, lastCheckedAt: Date.now() }
      if (status !== 'ok') updated.lastError = state === 'login-page' ? '会话已失效,需重新登录' : '登录态无法判定'
      else delete updated.lastError
      this.accounts.upsert(updated)
      return { platform: platformId, name: updated.name, status, addedAt: updated.addedAt, lastCheckedAt: updated.lastCheckedAt, lastError: updated.lastError }
    } catch (error) {
      const updated: AccountRecord = { ...record, status: 'unknown', lastCheckedAt: Date.now(), lastError: String(error) }
      this.accounts.upsert(updated)
      return { platform: platformId, name: updated.name, status: 'unknown', addedAt: updated.addedAt, lastCheckedAt: updated.lastCheckedAt, lastError: updated.lastError }
    }
  }

  async checkAllAccounts(): Promise<AccountView[]> {
    const records = this.accounts.list()
    for (const record of records) await this.checkAccount(record.platform)
    return this.listAccounts()
  }

  removeAccount(platformId: string): { ok: boolean; message: string } {
    const removed = this.accounts.remove(platformId)
    void this.browser.closePlatform(platformId)
    return removed
      ? { ok: true, message: `已移除 ${platformId}` }
      : { ok: false, message: `没有 ${platformId} 的账号记录` }
  }

  dispose(): void {
    void this.browser.closeAll()
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted === true) {
      reject(new Error('aborted'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
