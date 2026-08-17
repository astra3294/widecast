/**
 * 发布服务：浏览器模式发布。
 *
 * 核心改进（相对旧版）：
 * 1. 点击发布前先注册响应监听和导航监听。
 * 2. 点击后保留原发布页，不立即离开。
 * 3. 先等待发布响应、成功提示或明确跳转。
 * 4. 需要查询内容列表时，新开验证页。
 * 5. 无法确认时进入 needs_attention，不标记普通失败。
 * 6. 实现 PublishReceipt、证据等级和幂等防重复。
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Page, Response as PwResponse } from 'playwright'
import { BrowserManager } from './browser.js'
import { findPlatform, hasCapability, type PlatformDef, type PublishPlan } from './platforms.js'
import { detectLoggedIn } from './service.js'
import { TaskStore, type PublishInput, type PublishTask, type PublishReceipt } from './tasks.js'

// ─── 发布服务 ────────────────────────────────────────────────────────────────

export class PublishService {
  private readonly running = new Set<string>()

  constructor(
    private readonly browser: BrowserManager,
    private readonly tasks: TaskStore,
  ) {}

  listTasks(options?: { platform?: string; limit?: number }): PublishTask[] {
    return this.tasks.list(options)
  }

  getTask(id: string): PublishTask | undefined {
    return this.tasks.get(id)
  }

  /** 启动发布任务（异步执行，立即返回任务）。 */
  start(
    platformId: string,
    input: PublishInput,
    options: { accountId?: string } = {},
  ): { ok: boolean; task?: PublishTask; isDuplicate?: boolean; message?: string } {
    const platform = findPlatform(platformId)
    if (platform === undefined) return { ok: false, message: `未知平台：${platformId}` }

    // 检查平台是否支持发布
    const isImage = input.imagePaths !== undefined && input.imagePaths.length > 0
    const capability = isImage ? 'imageText' : 'video'
    if (!hasCapability(platform, capability)) {
      return { ok: false, message: `${platform.name} 尚未支持${isImage ? '图文' : '视频'}发布（当前仅支持：${platform.capabilities.join(', ')}）` }
    }

    if (platform.publish === undefined) {
      return { ok: false, message: `${platform.name} 的发布流程尚未实现` }
    }

    // 验证文件存在
    if (input.videoPath !== undefined && !existsSync(input.videoPath)) {
      return { ok: false, message: `视频文件不存在：${input.videoPath}` }
    }
    if (input.imagePaths !== undefined) {
      for (const p of input.imagePaths) {
        if (!existsSync(p)) return { ok: false, message: `图片文件不存在：${p}` }
      }
    }

    // 创建任务（带幂等检查）
    const { task, isDuplicate } = this.tasks.create(platformId, input, {
      accountId: options.accountId ?? platformId,
    })

    if (isDuplicate) {
      return { ok: true, task, isDuplicate: true, message: '已存在相同内容的发布任务' }
    }

    void this.run(task.id)
    return { ok: true, task }
  }

  /** 重试任务。 */
  retry(taskId: string): { ok: boolean; task?: PublishTask; message?: string } {
    const result = this.tasks.retry(taskId)
    if (result.ok && result.task !== undefined) {
      void this.run(result.task.id)
    }
    return result
  }

  /** 取消任务。 */
  cancel(taskId: string): { ok: boolean; message?: string } {
    return this.tasks.cancel(taskId)
  }

  // ─── 核心执行逻辑 ──────────────────────────────────────────────────────

  private async run(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return
    this.running.add(taskId)

    try {
      const task = this.tasks.get(taskId)
      if (task === undefined) return

      const platform = findPlatform(task.platform)
      if (platform === undefined) {
        this.tasks.update(taskId, { status: 'terminal_failed', step: 'no-platform', message: '平台不存在' })
        return
      }

      const isImage = task.input.imagePaths !== undefined && task.input.imagePaths.length > 0
      const plan = isImage ? (platform.publishImage ?? platform.publish) : platform.publish
      if (plan === undefined) {
        this.tasks.update(taskId, { status: 'terminal_failed', step: 'no-plan', message: '平台未配置发布流程' })
        return
      }

      const publishUrl = isImage && platform.publishImageUrl !== undefined
        ? platform.publishImageUrl
        : platform.publishUrl!
      if (publishUrl === undefined) {
        this.tasks.update(taskId, { status: 'terminal_failed', step: 'no-url', message: '未配置发布页 URL' })
        return
      }

      // 0) 登录前置检查
      this.tasks.update(taskId, { status: 'uploading', step: 'login-check' })
      if (!(await detectLoggedIn(platform, this.browser))) {
        this.tasks.update(taskId, {
          status: 'terminal_failed',
          step: 'not-logged-in',
          message: `${platform.name} 未登录：请先登录后再重试`,
        })
        return
      }

      // 1) 打开发布页
      this.tasks.update(taskId, { status: 'uploading', step: 'open-page' })
      const page = await this.browser.openPage(task.platform, publishUrl)
      await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {})

      // 登录反证
      if (platform.probe?.blockedBySelectors !== undefined) {
        const blocked = await page.$(platform.probe.blockedBySelectors[0]!).catch(() => null)
        if (blocked !== null) {
          this.tasks.update(taskId, {
            status: 'terminal_failed',
            step: 'not-logged-in',
            message: `${platform.name} 未登录，请先登录`,
          })
          return
        }
      }

      // 2) 上传文件
      if (isImage && plan.imageInputSelector !== undefined) {
        await this.uploadImages(page, taskId, task, plan)
      } else if (task.input.videoPath !== undefined && plan.videoInputSelector !== undefined) {
        await this.uploadVideo(page, taskId, task, plan)
      }

      // 3) 填写标题
      await this.fillTitle(page, taskId, task, plan)

      // 4) 填写描述/标签
      await this.fillDescription(page, taskId, task, plan)

      // 5) 注册响应监听（在点击发布前）
      const publishResponseCollector = new PublishResponseCollector()
      const responseHandler = (response: PwResponse): void => {
        publishResponseCollector.onResponse(response)
      }
      page.on('response', responseHandler)

      // 6) 点击发布按钮
      this.tasks.update(taskId, { status: 'publishing', step: 'submit' })
      const editorDump = await dumpEditorState(page)
      const clicked = await this.clickPublishButton(page, plan)
      if (!clicked) {
        page.off('response', responseHandler)
        this.tasks.update(taskId, {
          status: 'retryable_failed',
          step: 'submit',
          message: `未找到发布按钮 | editor:${JSON.stringify(editorDump).slice(0, 1800)}`,
        })
        return
      }

      // 7) 处理确认弹窗
      await this.handleConfirmDialogs(page, plan)

      // 8) 等待发布响应（不离开当前页面）
      this.tasks.update(taskId, { status: 'verifying', step: 'wait-response' })
      const receipt = await this.waitForPublishResult(page, platform, plan, task, publishResponseCollector)

      // 移除响应监听
      page.off('response', responseHandler)

      // 9) 验证结果
      if (receipt !== undefined) {
        // 发布成功或需要关注
        if (receipt.proofLevel === 'A' || receipt.proofLevel === 'B') {
          this.tasks.update(taskId, {
            status: 'done',
            step: 'verified',
            message: '发布成功',
            receipt,
          })
        } else {
          // needs_attention：有证据但不确定
          this.tasks.markNeedsAttention(taskId, '发布结果不确定，请人工确认', receipt)
        }
      } else {
        // 尝试在新页面验证内容列表
        const listReceipt = await this.verifyInContentList(page, platform, task)
        if (listReceipt !== undefined) {
          this.tasks.update(taskId, {
            status: 'done',
            step: 'verified',
            message: '已在内容管理列表确认',
            receipt: listReceipt,
          })
        } else {
          // 进入 needs_attention，不自动重发
          this.tasks.markNeedsAttention(taskId, '已点击发布但无法确认结果，请人工检查', {
            proofLevel: 'unknown',
            evidence: ['editor-dump'],
            rawResponse: JSON.stringify(editorDump).slice(0, 2000),
          })
        }
      }
    } catch (error) {
      const task = this.tasks.get(taskId)
      const isRetryable = task !== undefined && task.retryCount < task.maxRetries
      this.tasks.update(taskId, {
        status: isRetryable ? 'retryable_failed' : 'terminal_failed',
        step: 'error',
        message: String(error),
      })
    } finally {
      this.running.delete(taskId)
    }
  }

  // ─── 文件上传 ──────────────────────────────────────────────────────────

  private async uploadVideo(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    this.tasks.update(taskId, { status: 'uploading', step: 'video' })
    const input = page.locator(plan.videoInputSelector!).first()
    await input.waitFor({ state: 'attached', timeout: 30_000 })
    await input.setInputFiles(task.input.videoPath!)
    // 等平台前端上传完成：标题输入框出现可交互
    if (plan.titleInputSelector !== undefined) {
      await page.locator(plan.titleInputSelector).first().waitFor({ state: 'visible', timeout: 300_000 }).catch(() => {})
    }
  }

  private async uploadImages(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    this.tasks.update(taskId, { status: 'uploading', step: 'images' })
    const input = page.locator(plan.imageInputSelector!).first()
    await input.waitFor({ state: 'attached', timeout: 30_000 })
    await input.setInputFiles(task.input.imagePaths!)
    if (plan.titleInputSelector !== undefined) {
      await page.locator(plan.titleInputSelector).first().waitFor({ state: 'visible', timeout: 300_000 }).catch(() => {})
    }
  }

  // ─── 表单填写 ──────────────────────────────────────────────────────────

  private async fillTitle(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    if (task.input.title === '' || plan.titleInputSelector === undefined) return
    this.tasks.update(taskId, { status: 'uploading', step: 'title' })
    const title = plan.titleMaxLength !== undefined
      ? task.input.title.slice(0, plan.titleMaxLength)
      : task.input.title
    const titleBox = page.locator(plan.titleInputSelector).first()
    await titleBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    await titleBox.click({ timeout: 15_000 }).catch(() => {})
    await page.keyboard.type(title, { delay: 30 })
  }

  private async fillDescription(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    let description = task.input.description ?? ''
    if (task.input.tags !== undefined && task.input.tags.length > 0) {
      const maxTopics = plan.maxTopics ?? task.input.tags.length
      const tagText = task.input.tags
        .map((tag, index) => (index < maxTopics ? `#${tag}` : tag))
        .join(' ')
      description = description === '' ? tagText : `${description}\n\n${tagText}`
    }
    if (description === '' || plan.descInputSelector === undefined) return
    this.tasks.update(taskId, { status: 'uploading', step: 'description' })
    const descBox = page.locator(plan.descInputSelector).first()
    await descBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
    await descBox.click({ timeout: 15_000 }).catch(() => {})
    await page.keyboard.type(description, { delay: 10 })
  }

  // ─── 发布按钮点击 ──────────────────────────────────────────────────────

  private async clickPublishButton(page: Page, plan: PublishPlan): Promise<boolean> {
    // 先精确匹配
    for (const text of plan.publishButtonTexts) {
      const exact = page.getByRole('button', { name: text, exact: true })
      if (await exact.count() > 0 && await exact.first().isVisible().catch(() => false)) {
        await exact.first().click({ timeout: 15_000 }).catch(() => {})
        return true
      }
    }
    // 兜底：子串匹配
    for (const text of plan.publishButtonTexts) {
      const button = page.locator(`button:has-text("${text}")`).first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
        await button.click({ timeout: 15_000 }).catch(() => {})
        return true
      }
    }
    return false
  }

  // ─── 确认弹窗处理 ──────────────────────────────────────────────────────

  private async handleConfirmDialogs(page: Page, plan: PublishPlan): Promise<void> {
    const confirmTexts = plan.confirmButtonTexts ?? []
    if (confirmTexts.length === 0) return

    const deadline = Date.now() + 30_000
    while (Date.now() < deadline) {
      let clickedConfirm = false
      for (const text of confirmTexts) {
        const exact = page.getByRole('button', { name: text, exact: true })
        if (await exact.count() > 0 && await exact.first().isVisible().catch(() => false)) {
          await exact.first().click({ timeout: 10_000 }).catch(() => {})
          clickedConfirm = true
          break
        }
      }
      if (!clickedConfirm) break
      await page.waitForTimeout(1500)
    }
  }

  // ─── 结果等待与验证 ────────────────────────────────────────────────────

  /**
   * 等待发布结果：监听响应、Toast 和 URL 变化。
   * 返回 PublishReceipt 或 null（需进一步验证）。
   */
  private async waitForPublishResult(
    page: Page,
    platform: PlatformDef,
    plan: PublishPlan,
    task: PublishTask,
    collector: PublishResponseCollector,
  ): Promise<PublishReceipt | undefined> {
    // 等待一段时间让平台处理
    await page.waitForTimeout(5000)

    // 检查是否出现成功提示
    const successReceipt = await this.checkSuccessToast(page, plan, collector)
    if (successReceipt !== undefined) return successReceipt

    // 检查 URL 是否跳转到成功页
    const urlReceipt = await this.checkUrlRedirect(page, platform)
    if (urlReceipt !== undefined) return urlReceipt

    // 检查收集到的响应
    const responseReceipt = this.checkCollectedResponses(collector, platform)
    if (responseReceipt !== undefined) return responseReceipt

    // 再等一会儿，看看有没有延迟的提示
    await page.waitForTimeout(5000)

    const delayedSuccessReceipt = await this.checkSuccessToast(page, plan, collector)
    if (delayedSuccessReceipt !== undefined) return delayedSuccessReceipt

    return undefined
  }

  /** 检查成功提示文本。 */
  private async checkSuccessToast(
    page: Page, plan: PublishPlan, collector: PublishResponseCollector,
  ): Promise<PublishReceipt | undefined> {
    for (const text of plan.successTexts) {
      const visible = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)
      if (visible) {
        return {
          proofLevel: 'B',
          evidence: ['success-toast'],
          rawResponse: `检测到成功提示：${text}`,
        }
      }
    }
    return undefined
  }

  /** 检查 URL 是否跳转到成功页。 */
  private async checkUrlRedirect(page: Page, platform: PlatformDef): Promise<PublishReceipt | undefined> {
    const currentUrl = page.url()
    // 如果 URL 包含成功相关路径特征
    if (currentUrl.includes('manage') || currentUrl.includes('success') || currentUrl.includes('complete')) {
      return {
        proofLevel: 'B',
        evidence: ['url-redirect'],
        url: currentUrl,
        rawResponse: `URL 跳转到：${currentUrl}`,
      }
    }
    return undefined
  }

  /** 检查收集到的网络响应。 */
  private checkCollectedResponses(collector: PublishResponseCollector, platform: PlatformDef): PublishReceipt | undefined {
    const responses = collector.getResponses()
    for (const resp of responses) {
      // 检查是否有发布成功的响应
      if (resp.status >= 200 && resp.status < 300) {
        // 尝试解析 JSON
        try {
          const json = JSON.parse(resp.body) as Record<string, unknown>
          // 检查常见的成功字段
          if (json.status === 'success' || json.code === 0 || json.err_no === 0) {
            return {
              proofLevel: 'A',
              evidence: ['network-response'],
              submittedAt: new Date().toISOString(),
              rawResponse: resp.body.slice(0, 2000),
            }
          }
        } catch {
          // 非 JSON 响应，跳过
        }
      }
    }
    return undefined
  }

  /** 在内容管理页验证作品。 */
  private async verifyInContentList(
    page: Page, platform: PlatformDef, task: PublishTask,
  ): Promise<PublishReceipt | undefined> {
    if (platform.manageUrl === undefined) return undefined
    const titleKey = task.input.title.slice(0, 10)
    if (titleKey === '') return undefined

    try {
      // 在新页面打开内容管理页
      const managePage = await this.browser.openPage(task.platform, platform.manageUrl)
      await managePage.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {})
      // 等列表加载完
      await managePage.waitForTimeout(5000)

      const found = await managePage.evaluate(
        (key: string) => document.body.innerText.includes(key),
        titleKey,
      ).catch(() => false)

      if (found) {
        return {
          proofLevel: 'A',
          evidence: ['content-list-match'],
          submittedAt: new Date().toISOString(),
          rawResponse: `在内容管理列表找到标题：${titleKey}`,
        }
      }
    } catch {
      // 验证失败，返回 undefined
    }
    return undefined
  }
}

// ─── 响应收集器 ──────────────────────────────────────────────────────────────

interface CollectedResponse {
  url: string
  status: number
  body: string
}

class PublishResponseCollector {
  private readonly responses: CollectedResponse[] = []

  onResponse(response: PwResponse): void {
    try {
      const url = response.url()
      // 只收集可能相关的响应（排除静态资源）
      if (url.includes('/api/') || url.includes('/publish') || url.includes('/upload') || url.includes('/create')) {
        response.text().then((body) => {
          this.responses.push({ url, status: response.status(), body })
        }).catch(() => {})
      }
    } catch {
      // ignore
    }
  }

  getResponses(): CollectedResponse[] {
    return [...this.responses]
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 校验输入的基础完整性。 */
export function validatePublishInput(input: PublishInput): string | null {
  if (input.title === undefined || input.title.trim() === '') return 'title 必填'
  if (input.videoPath === undefined && (input.imagePaths === undefined || input.imagePaths.length === 0)) {
    return 'videoPath 或 imagePaths 至少提供一个'
  }
  if (input.videoPath !== undefined && !existsSync(input.videoPath)) return `视频文件不存在：${input.videoPath}`
  return null
}

/** 快照当前编辑器页面的可见输入控件与按钮。 */
async function dumpEditorState(page: Page): Promise<unknown> {
  return page.evaluate(() => {
    const visible = (el: Element): boolean => {
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
    }
    const inputs = [...document.querySelectorAll('input, textarea')]
      .filter(visible)
      .map((el) => ({
        t: el.tagName,
        ty: el.getAttribute('type') ?? '',
        ph: el.getAttribute('placeholder') ?? '',
        val: (el as HTMLInputElement).value?.slice(0, 30) ?? '',
        dis: (el as HTMLInputElement).disabled === true,
        cls: String(el.className ?? '').slice(0, 60),
      }))
      .slice(0, 25)
    const editables = [...document.querySelectorAll('[contenteditable="true"]')]
      .filter(visible)
      .map((el) => ({
        ph: el.getAttribute('placeholder') ?? el.getAttribute('data-placeholder') ?? '',
        aria: el.getAttribute('aria-label') ?? '',
        cls: String(el.className ?? '').slice(0, 60),
        text: (el.textContent ?? '').slice(0, 30),
      }))
      .slice(0, 15)
    const buttons = [...document.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((el) => ({
        tx: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 24),
        dis: (el as HTMLButtonElement).disabled === true,
        cls: String(el.className ?? '').slice(0, 60),
      }))
      .filter((button) => button.tx !== '')
      .slice(0, 30)
    return { url: location.href, inputs, editables, buttons }
  })
}
