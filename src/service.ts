/**
 * 账号服务：浏览器档案 + 账号存储 + 登录态探测。
 *
 * 登录探测基于平台公开页面的实际行为，不注入、不伪造。
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
  /** 登录二维码截图(data URL),面板内展示供手机扫码 */
  qrCodeImage?: string
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
export async function detectLoggedIn(platform: PlatformDef, browser: BrowserManager): Promise<boolean> {
  const context = await browser.contextFor(platform.id)
  const probe = platform.probe
  const blockedSelectors = probe?.blockedBySelectors

  const page = await browser.openPage(platform.id, platform.homeUrl)

  // 先让页面完全渲染(SPA 登录表单渲染晚,过早检查会漏掉)
  await page.waitForLoadState('domcontentloaded', { timeout: 30_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {})
  await sleep(2000)

  // 1) 反证:登录表单可见 = 未登录(最强信号)
  if (blockedSelectors !== undefined && blockedSelectors.length > 0) {
    for (const selector of blockedSelectors) {
      const blocked = await page.$(selector).catch(() => null)
      if (blocked !== null) return false
    }
  }

  // 2) 文本反证:登录页文案出现 = 未登录
  if (probe?.bodyTextOut !== undefined) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (probe.bodyTextOut.some((marker) => text.includes(marker))) return false
  }

  // 3) 文本正证:后台文案出现 = 已登录
  if (probe?.bodyTextIn !== undefined) {
    const text = await page.evaluate(() => document.body.innerText).catch(() => '')
    if (probe.bodyTextIn.some((marker) => text.includes(marker))) return true
  }

  // 4) 接口探针(监听页面自然流量)
  if (probe?.urlPattern !== undefined) {
    const matched: PwResponse[] = []
    const onResponse = (response: PwResponse): void => {
      try {
        if (response.url().includes(probe.urlPattern!)) matched.push(response)
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
  }

  // 5) localStorage 键(仅用于已知可靠键;抖音此类键登录页也有,已弃用)
  if (probe?.localStorageKeys !== undefined) {
    const hit = await page
      .evaluate((keys: string[]) => keys.some((key) => localStorage.getItem(key) !== null), probe.localStorageKeys)
      .catch(() => false)
    if (hit === true) return true
  }

  // 6) 兜底:URL 判定
  return detectLoginState(platform, page.url()) === 'logged-in'
}

/** 轻量快检(登录引导轮询用):URL 扫描 + 反证 + localStorage 探针,不做 reload。 */
async function quickCheck(platform: PlatformDef, browser: BrowserManager): Promise<boolean> {
  const context = await browser.contextFor(platform.id)
  const blockedSelectors = platform.probe?.blockedBySelectors
  for (const candidate of context.pages()) {
    try {
      // 文本反证优先(登录页文案 = 未登录)
      const outMarkers = platform.probe?.bodyTextOut
      if (outMarkers !== undefined) {
        const text = await candidate.evaluate(() => document.body.innerText).catch(() => '')
        if (outMarkers.some((marker) => text.includes(marker))) continue
      }
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
  // 文本正证(后台文案 = 已登录)
  const inMarkers = platform.probe?.bodyTextIn
  if (inMarkers !== undefined) {
    for (const page of context.pages()) {
      const text = await page.evaluate(() => document.body.innerText).catch(() => '')
      if (inMarkers.some((marker) => text.includes(marker))) return true
    }
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
    return PLATFORMS.map((platform) => ({
      id: platform.id,
      name: platform.name,
      capabilities: platform.capabilities,
      publishUrl: platform.publishUrl,
    }))
  }

  listAccounts(): AccountView[] {
    return this.accounts.list().map((record) => {
      const view: AccountView = {
        platform: record.platform,
        name: record.name,
        status: record.status,
        addedAt: record.addedAt,
      }
      if (record.lastCheckedAt !== undefined) view.lastCheckedAt = record.lastCheckedAt
      if (record.lastError !== undefined) view.lastError = record.lastError
      return view
    })
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

    const loginPage = await this.browser.openPage(platformId, platform.loginUrl)
    const qrCodeImage = await captureQr(loginPage)

    const waitMs = options.waitMs ?? 0
    if (waitMs <= 0) {
      return { ok: true, needsHuman: true, platform: platformId, status: 'timeout', qrCodeImage, message: `${platform.name} 需要登录:请在下方扫码(手机完成)` }
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
    return { ok: true, needsHuman: true, platform: platformId, status: 'timeout', qrCodeImage, message: `等待 ${platform.name} 登录超时;完成登录后再试` }
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

  /** 彻底登出:关闭档案并删除本地登录数据(换账号用)。 */
  async logoutAccount(platformId: string): Promise<{ ok: boolean; message: string }> {
    await this.browser.closePlatform(platformId)
    this.accounts.remove(platformId)
    try {
      const { rmSync } = await import('node:fs')
      const { join } = await import('node:path')
      rmSync(join(this.browser.profilesDir, platformId), { recursive: true, force: true })
      return { ok: true, message: `${platformId} 已登出,本地登录数据已清除` }
    } catch (error) {
      return { ok: false, message: `清除失败:${String(error)}` }
    }
  }

  /** 删除作品:在内容管理页找到含 titleKey 的作品卡片,点删除并确认。 */
  async deleteWork(platformId: string, titleKey: string): Promise<{ ok: boolean; message: string }> {
    const platform = findPlatform(platformId)
    if (platform === undefined || platform.manageUrl === undefined) {
      return { ok: false, message: `${platformId} 未配置内容管理页,无法自动删除` }
    }
    try {
      const page = await this.browser.openPage(platformId, platform.manageUrl)
      await page.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {})
      // 等列表加载完(「加载中」消失,最多 25 秒)
      for (let i = 0; i < 25; i += 1) {
        const loading = await page.evaluate(() => document.body.innerText.includes('加载中')).catch(() => true)
        if (!loading) break
        await sleep(1000)
      }
      // 先找标题叶子元素,再按"同一卡片行带(y 中心接近)"定位删除按钮(门户/深层结构都能命中)
      const clicked = await page.evaluate((key: string) => {
        const leaves = [...document.querySelectorAll('*')]
          .filter((el) => el.children.length === 0 && (el.textContent ?? '').trim() !== '' && (el.textContent ?? '').includes(key))
        if (leaves.length === 0) return false
        const titleEl = leaves.sort((a, b) => (a.textContent ?? '').length - (b.textContent ?? '').length)[0]!
        const rect = titleEl.getBoundingClientRect()
        const targetY = rect.top + rect.height / 2
        const buttons = [...document.querySelectorAll('button, [role="button"]')]
          .filter((el) => (el.textContent ?? '').trim() === '删除作品')
        const button = buttons
          .map((el) => ({ el, r: el.getBoundingClientRect() }))
          .sort((a, b) => Math.abs(a.r.top + a.r.height / 2 - targetY) - Math.abs(b.r.top + b.r.height / 2 - targetY))[0]
        if (button === undefined || Math.abs(button.r.top + button.r.height / 2 - targetY) > 200) return false
        ;(button.el as HTMLButtonElement).click()
        return true
      }, titleKey)
      if (!clicked) return { ok: false, message: `未找到标题含「${titleKey}」的作品` }
      await sleep(2000)
      // 确认弹窗:点「删除/确定」
      for (const text of ['删除', '确定']) {
        const exact = page.getByRole('button', { name: text, exact: true })
        if (await exact.count() > 0 && await exact.first().isVisible().catch(() => false)) {
          await exact.first().click({ timeout: 10_000 }).catch(() => {})
          break
        }
      }
      await sleep(3000)
      const gone = await page.evaluate((key: string) => !document.body.innerText.includes(key), titleKey)
      return gone
        ? { ok: true, message: '已删除' }
        : { ok: false, message: '已点击删除,但页面仍显示该作品(可能有确认步骤),请人工确认' }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
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

/** 截取登录页二维码(优先 qr 相关元素,兜底全视口),返回 data URL。 */
async function captureQr(page: import('playwright').Page): Promise<string | undefined> {
  try {
    await sleep(2500)
    const handle = await page.evaluateHandle(() => {
      const els = [...document.querySelectorAll('img, canvas')].filter((el) => {
        const rect = el.getBoundingClientRect()
        return rect.width >= 100 && rect.height >= 100 && rect.width <= 640
      })
      if (els.length === 0) return null
      const qr = els.find((el) => (el.getAttribute('src') ?? '').includes('qr'))
        ?? els.sort((a, b) => b.getBoundingClientRect().width * b.getBoundingClientRect().height - a.getBoundingClientRect().width * a.getBoundingClientRect().height)[0]
      return qr ?? null
    })
    const element = handle.asElement()
    if (element !== null) {
      const buffer = await element.screenshot({ type: 'png', timeout: 10_000 }).catch(() => undefined)
      if (buffer !== undefined) return `data:image/png;base64,${buffer.toString('base64')}`
    }
    const viewport = await page.screenshot({ type: 'png', timeout: 10_000 }).catch(() => undefined)
    return viewport !== undefined ? `data:image/png;base64,${viewport.toString('base64')}` : undefined
  } catch {
    return undefined
  }
}
