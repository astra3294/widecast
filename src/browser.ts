/**
 * 浏览器管理器:每平台一个持久化用户目录(真实浏览器档案)。
 *
 * - `launchPersistentContext`:cookie/localStorage/IndexedDB 由浏览器原生保存,
 *   登录一次长期在线;档案目录 = ~/.widecast/browser-profiles/<platform>
 * - 有头(headed)启动:扫码/验证码/人工接管都在用户眼前完成
 * - 懒启动:首次操作才拉起;会话内常驻;closeAll 全关
 */
import { chromium, type BrowserContext, type Page } from 'playwright'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'

export interface ProfileState {
  platform: string
  running: boolean
  pageCount: number
}

export class BrowserManager {
  private readonly contexts = new Map<string, BrowserContext>()
  private readonly profilesDir: string

  constructor(baseDir: string) {
    this.profilesDir = join(baseDir, 'browser-profiles')
    mkdirSync(this.profilesDir, { recursive: true })
  }

  /** 取得(必要时启动)某平台的持久化浏览器上下文。 */
  async contextFor(platform: string): Promise<BrowserContext> {
    const existing = this.contexts.get(platform)
    if (existing !== undefined) return existing
    // 默认无头后台运行(不挡用户屏幕);设 WIDECAST_HEADED=1 可调试时可见
    const headed = process.env.WIDECAST_HEADED === '1'
    const context = await chromium.launchPersistentContext(join(this.profilesDir, platform), {
      headless: !headed,
      viewport: { width: 1280, height: 860 },
      locale: 'zh-CN',
    })
    this.contexts.set(platform, context)
    return context
  }

  /** 在平台档案中打开页面;带防抖:同 URL 已开则复用。 */
  async openPage(platform: string, url: string): Promise<Page> {
    const context = await this.contextFor(platform)
    const existing = context.pages().find((page) => page.url() === url || page.url().startsWith(url.split('?')[0]!))
    if (existing !== undefined) {
      await existing.bringToFront()
      return existing
    }
    const page = await context.newPage()
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.bringToFront()
    return page
  }

  async closePlatform(platform: string): Promise<void> {
    const context = this.contexts.get(platform)
    if (context !== undefined) {
      this.contexts.delete(platform)
      await context.close().catch(() => {})
    }
  }

  async closeAll(): Promise<void> {
    const platforms = [...this.contexts.keys()]
    for (const platform of platforms) await this.closePlatform(platform)
  }

  state(): ProfileState[] {
    return [...this.contexts.entries()].map(([platform, context]) => ({
      platform,
      running: true,
      pageCount: context.pages().length,
    }))
  }
}
