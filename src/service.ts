/**
 * 账号服务:把 浏览器档案 + 账号存储 + 登录态探测 串起来。
 * 登录探测学习自蚁小二 platformMapsIn 探针表(报告 02 §2),原创实现:
 * 观察真实浏览器页面自身的接口流量与 localStorage,不注入、不伪造。
 */
import type { BrowserContext, Response as PwResponse } from 'playwright'
import { AccountStore, type AccountRecord, type AccountStatus } from './accounts.js'
import { BrowserManager } from './browser.js'
import { detectLoginState, findPlatform, PLATFORMS, type PlatformDef } from './platforms.js'

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

/** 点分路径取值(a.b.c)。 */
function getPath(value: unknown, path: string): unknown {
  let current: unknown = value
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

/**
 * 完整登录探测:
 * 1) 快路径:扫描该平台档案所有页面的 URL(登录成功后的重定向);
 * 2) 探针:监听后台首页自然流量,匹配探针接口并检查响应 JSON 路径;另查 localStorage 键;
 * 3) 兜底:首页 URL 判定。
 */
async function detectLoggedIn(platform: PlatformDef, browser: BrowserManager): Promise<boolean> {
  const context = await browser.contextFor(platform.id)

  for (const candidate of context.pages()) {
    try {
      if (detectLoginState(platform, candidate.url()) === 'logged-in') return true
    } catch { /* page closed mid-check */ }
  }

  const page = await browser.openPage(platform.id, platform.homeUrl)
  const probe = platform.probe

  if (probe !== undefined) {
    // 反证探针:登录表单可见 = 未登录(如抖音手机号输入框)
    if (probe.blockedBySelectors !== undefined) {
      for (const selector of probe.blockedBySelectors) {
        const blocked = await page.$(selector).catch(() => null)
        if (blocked !== null) return false
      }
    }
    const matched: PwResponse[] = []
    const onResponse = (response: PwResponse): void => {
      try {
        if (probe.urlPattern !== undefined && response.url().includes(probe.urlPattern)) matched.push(response)
      } catch { /* ignore */ }
    }
    page.on('response', onResponse)
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 }).catch(() => {})
    await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
    await sleep(2000)
    page.off('response', onResponse)

    for (const response of matched) {
      try {
        const json = (await response.json()) as unknown
        if (probe.keyPaths?.some((path) => getPath(json, path) !== undefined)) return true
      } catch { /* 非 JSON 或读取失败 */ }
    }
    if (probe.localStorageKeys !== undefined) {
      const hit = await page
        .evaluate((keys: string[]) => keys.some((key) => localStorage.getItem(key) !== null), probe.localStorageKeys)
        .catch(() => false)
      if (hit === true) return true
    }
  }

  return detectLoginState(platform, page.url()) === 'logged-in'
}

/** 轻量快检(登录引导轮询用):URL 扫描 + 反证 + localStorage 探针,不做 reload。 */
async function quickCheck(platform: PlatformDef, browser: BrowserManager): Promise<boolean> {
  const context = await browser.contextFor(platform.id)
  const blockedSelectors = platform.probe?.blockedBySelectors
  for (const candidate of context.pages()) {
    try {
      if (detectLoginState(platform, candidate.url()) === 'logged-in') {
        // 反证:登录表单可见则视为未登录
        if (blockedSelectors !== undefined && blockedSelectors.length > 0) {
          const blocked = await candidate.$(blockedSelectors[0]!).catch(() => null)
          if (blocked !== null) continue
        }
        return true
      }
    } catch { /* page closed mid-check */ }
  }
  const keys = platform.probe?.localStorageKeys
  if (keys !== undefined && keys.length > 0) {
    for (const page of context.pages()) {
      if (blockedSelectors !== undefined && blockedSelectors.length > 0) {
        const blocked = await page.$(blockedSelectors[0]!).catch(() => null)
        if (blocked !== null) continue
      }
      const hit = await page
        .evaluate((probeKeys: string[]) => probeKeys.some((key) => localStorage.getItem(key) !== null), keys)
        .catch(() => false)
      if (hit === true) return true
    }
  }
  return false
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
   * 添加账号:先探测是否已登录(已登录则直接建档),否则打开登录页等待真人登录。
   * waitMs>0 时阻塞轮询(供模型工具);waitMs=0 时立即返回,由面板轮询 accounts.check。
   */
  async addAccount(platformId: string, options: { waitMs?: number; signal?: AbortSignal } = {}): Promise<AddAccountResult> {
    const platform = findPlatform(platformId)
    if (platform === undefined) {
      return { ok: false, platform: platformId, status: 'timeout', message: `未知平台:${platformId}` }
    }

    const save = (message: string): AddAccountResult => {
      const existing = this.accounts.get(platformId)
      this.accounts.upsert({
        platform: platformId,
        name: existing?.name ?? platform.name,
        addedAt: existing?.addedAt ?? Date.now(),
        lastCheckedAt: Date.now(),
        status: 'ok',
      })
      return { ok: true, platform: platformId, status: 'ok', message }
    }

    if (await detectLoggedIn(platform, this.browser)) {
      return save(`${platform.name} 已登录并保存`)
    }

    await this.browser.openPage(platformId, platform.loginUrl)

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
      if (await quickCheck(platform, this.browser)) {
        return save(`${platform.name} 登录成功,账号已保存`)
      }
      await sleep(2000, signal)
    }
    return { ok: true, needsHuman: true, platform: platformId, status: 'timeout', message: `等待 ${platform.name} 登录超时;完成登录后再试` }
  }

  /** 健康检查:完整探测登录态并更新记录。 */
  async checkAccount(platformId: string): Promise<AccountView | undefined> {
    const platform = findPlatform(platformId)
    if (platform === undefined) return undefined
    const record = this.accounts.get(platformId)
    if (record === undefined) return undefined
    try {
      const loggedIn = await detectLoggedIn(platform, this.browser)
      const status: AccountStatus = loggedIn ? 'ok' : 'expired'
      const updated: AccountRecord = { ...record, status, lastCheckedAt: Date.now() }
      if (loggedIn) delete updated.lastError
      else updated.lastError = '会话已失效,需重新登录'
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

  /**
   * 单平台登录探测(登录引导流程用):无论有无记录都检测;
   * 已登录则创建/更新账号记录并返回 loggedIn=true。
   */
  async checkPlatform(platformId: string): Promise<{ loggedIn: boolean; account?: AccountView; message?: string }> {
    const platform = findPlatform(platformId)
    if (platform === undefined) return { loggedIn: false, message: `未知平台:${platformId}` }
    try {
      if (await detectLoggedIn(platform, this.browser)) {
        const existing = this.accounts.get(platformId)
        const record: AccountRecord = {
          platform: platformId,
          name: existing?.name ?? platform.name,
          addedAt: existing?.addedAt ?? Date.now(),
          lastCheckedAt: Date.now(),
          status: 'ok',
        }
        this.accounts.upsert(record)
        return {
          loggedIn: true,
          account: { platform: platformId, name: record.name, status: 'ok', addedAt: record.addedAt, lastCheckedAt: record.lastCheckedAt },
        }
      }
      return { loggedIn: false, message: '尚未登录' }
    } catch (error) {
      return { loggedIn: false, message: String(error) }
    }
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
