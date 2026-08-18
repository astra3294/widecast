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
import { isAbsolute } from 'node:path'
import type { Page, Response as PwResponse } from 'playwright'
import { BrowserManager } from './browser.js'
import { findPlatform, hasCapability, type PlatformDef, type PublishPlan } from './platforms.js'
import { detectLoggedIn } from './service.js'
import {
  TaskStore,
  type PublishInput,
  type PublishTask,
  type PublishReceipt,
} from './tasks.js'
import { hasSubmissionEvidence, isTerminalStatus } from './types.js'

export type { PublishInput, PublishTask, PublishReceipt }

// ─── 发布服务 ────────────────────────────────────────────────────────────────

export class PublishService {
  private readonly running = new Set<string>()
  private readonly accountQueues = new Map<string, Promise<void>>()

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

  /** 发布前自动检查账号状态。 */
  async prePublishCheck(platformId: string): Promise<{ ok: boolean; loggedIn: boolean; message?: string }> {
    const platform = findPlatform(platformId)
    if (platform === undefined) return { ok: false, loggedIn: false, message: `未知平台：${platformId}` }

    try {
      const loggedIn = await detectLoggedIn(platform, this.browser)
      return {
        ok: true,
        loggedIn,
        message: loggedIn ? `${platform.name} 账号正常` : `${platform.name} 未登录或登录已失效，请重新登录`,
      }
    } catch (error) {
      return {
        ok: false,
        loggedIn: false,
        message: `检查 ${platform.name} 账号状态失败：${String(error)}`,
      }
    }
  }

  /** 启动发布任务（异步执行，立即返回任务）。 */
  start(
    platformId: string,
    input: PublishInput,
    options: { accountId?: string; skipPreCheck?: boolean } = {},
  ): { ok: boolean; task?: PublishTask; isDuplicate?: boolean; message?: string } {
    const platform = findPlatform(platformId)
    if (platform === undefined) return { ok: false, message: `未知平台：${platformId}` }

    const validationError = validatePublishInput(input, { checkFiles: false })
    if (validationError !== null) return { ok: false, message: validationError }

    // 检查平台是否支持发布
    const isImage = input.imagePaths !== undefined && input.imagePaths.length > 0
    const capability = isImage ? 'imageText' : 'video'
    if (!hasCapability(platform, capability)) {
      return { ok: false, message: `${platform.name} 尚未支持${isImage ? '图文' : '视频'}发布（当前仅支持：${platform.capabilities.join(', ')}）` }
    }

    const plan = isImage ? (platform.publishImage ?? platform.publish) : platform.publish
    if (plan === undefined) {
      return { ok: false, message: `${platform.name} 的发布流程尚未实现` }
    }

    const accountId = options.accountId ?? platformId
    const duplicate = this.tasks.findDuplicate(platformId, input, { accountId })
    if (duplicate !== undefined) {
      return { ok: true, task: duplicate, isDuplicate: true, message: '已存在相同内容的发布任务' }
    }

    // 只有确认不是重复任务后，才要求素材当前仍存在。
    const fileValidationError = validatePublishInput(input)
    if (fileValidationError !== null) return { ok: false, message: fileValidationError }

    // 创建任务（带幂等检查）
    const { task, isDuplicate } = this.tasks.create(platformId, input, {
      accountId,
    })

    if (isDuplicate) {
      return { ok: true, task, isDuplicate: true, message: '已存在相同内容的发布任务' }
    }

    void this.run(task.id)
    return { ok: true, task }
  }

  /** 重试任务；提交后的不确定任务必须显式确认没有作品。 */
  retry(
    taskId: string,
    options: { confirmedNoPublication?: boolean; reason?: string } = {},
  ): { ok: boolean; task?: PublishTask; message?: string } {
    const result = this.tasks.retry(taskId, options)
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

  private run(taskId: string): void {
    const task = this.tasks.get(taskId)
    if (task === undefined) return
    const queueKey = `${task.platform}\x00${task.accountId}`
    const previous = this.accountQueues.get(queueKey) ?? Promise.resolve()
    const current = previous
      .catch(() => {})
      .then(() => this.execute(taskId))
    this.accountQueues.set(queueKey, current)
    void current.finally(() => {
      if (this.accountQueues.get(queueKey) === current) this.accountQueues.delete(queueKey)
    }).catch(() => {})
  }

  private async execute(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return
    this.running.add(taskId)
    let responsePage: Page | undefined
    let responseHandler: ((response: PwResponse) => void) | undefined

    try {
      const task = this.tasks.get(taskId)
      if (task === undefined) return
      if (isTerminalStatus(task.status)) return

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
          status: 'needs_attention',
          step: 'not-logged-in',
          message: `${platform.name} 未登录：请先完成真人登录后再重试`,
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
            status: 'needs_attention',
            step: 'not-logged-in',
            message: `${platform.name} 未登录，请先完成真人登录`,
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
      const handler = (response: PwResponse): void => {
        publishResponseCollector.onResponse(response)
      }
      responseHandler = handler
      responsePage = page
      page.on('response', handler)

      // 6) 点击发布按钮
      this.tasks.update(taskId, { status: 'submitting', step: 'submit' })
      const editorDump = await dumpEditorState(page).catch(() => ({ url: page.url(), error: 'dump failed' }))
      const clicked = await this.clickPublishButton(page, plan)
      if (!clicked) {
        page.off('response', handler)
        responsePage = undefined
        responseHandler = undefined
        this.tasks.update(taskId, {
          status: 'retryable_failed',
          step: 'submit',
          message: `未找到发布按钮 | editor:${JSON.stringify(editorDump).slice(0, 1800)}`,
        })
        return
      }

      // 7) 处理确认弹窗
      await this.handleConfirmDialogs(page, plan)

      // 7.5) 检测验证码/二次验证（点击发布后立即检查）
      this.tasks.update(taskId, { status: 'verifying', step: 'check-captcha', submittedAt: Date.now() })
      const captchaDetected = await this.detectCaptcha(page)
      if (captchaDetected) {
        page.off('response', handler)
        responsePage = undefined
        responseHandler = undefined
        this.tasks.update(taskId, {
          status: 'needs_attention',
          step: 'captcha-required',
          message: '平台要求验证码或二次验证，请手动完成后重试',
        })
        return
      }

      // 8) 等待发布响应（不离开当前页面）
      this.tasks.update(taskId, { status: 'verifying', step: 'wait-response' })
      const receipt = await this.waitForPublishResult(page, platform, plan, task, publishResponseCollector)

      // 移除响应监听
      page.off('response', handler)
      responsePage = undefined
      responseHandler = undefined

      // 9) 验证结果
      if (receipt !== undefined) {
        if (isSufficientProof(receipt)) {
          // A/B 级凭证：已达到可确认阈值
          this.tasks.update(taskId, {
            status: 'published',
            step: 'verified',
            message: `发布成功（${receipt.proofLevel}级凭证）`,
            receipt,
          })
        } else {
          // C 级或未知凭证：尝试在内容管理页进一步验证以升级到 A 级
          const listReceipt = await this.verifyInContentList(page, platform, task)
          if (listReceipt !== undefined && listReceipt.proofLevel === 'A') {
            // 升级为 A 级：合并凭证
            this.tasks.update(taskId, {
              status: 'published',
              step: 'verified',
              message: '发布成功（A级凭证：内容管理列表确认）',
              receipt: {
                ...listReceipt,
                evidence: [...new Set([...receipt.evidence, ...listReceipt.evidence])],
              },
            })
          } else {
            // 只有 Toast/弱信号不能直接标记发布成功。
            this.tasks.markNeedsAttention(taskId, '已收到提交信号，但缺少可确认的作品凭证，请人工检查', receipt)
          }
        }
      } else {
        // 没有任何凭证：尝试内容管理页验证
        const listReceipt = await this.verifyInContentList(page, platform, task)
        if (listReceipt !== undefined) {
          this.tasks.update(taskId, {
            status: 'published',
            step: 'verified',
            message: '已在内容管理列表确认',
            receipt: listReceipt,
          })
        } else {
          this.tasks.markNeedsAttention(taskId, '已点击发布但无法确认结果，请人工检查', {
            proofLevel: 'unknown',
            evidence: ['editor-dump'],
            rawResponse: JSON.stringify(editorDump).slice(0, 2000),
          })
        }
      }
    } catch (error) {
      const task = this.tasks.get(taskId)
      if (task !== undefined && hasSubmissionEvidence(task)) {
        this.tasks.markNeedsAttention(taskId, `提交后执行异常，无法确认结果：${String(error)}`, {
          proofLevel: 'unknown',
          verificationMethod: 'exception',
          evidence: ['exception-after-submit'],
        })
      } else {
        const isRetryable = task !== undefined && task.retryCount < task.maxRetries
        this.tasks.update(taskId, {
          status: isRetryable ? 'retryable_failed' : 'terminal_failed',
          step: 'error',
          message: String(error),
        })
      }
    } finally {
      if (responsePage !== undefined && responseHandler !== undefined) {
        responsePage.off('response', responseHandler)
      }
      this.running.delete(taskId)
    }
  }

  // ─── 文件上传 ──────────────────────────────────────────────────────────

  private async uploadVideo(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    this.tasks.update(taskId, { status: 'uploading', step: 'video' })

    // 等待页面完全加载（SPA 页面需要时间渲染）
    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    // 优先用 plan 中的选择器，回退到 accept*="video" 定位
    // 使用 waitFor 等待元素出现（最长 60 秒），因为 file input 可能是动态加载的
    let inputLocator = page.locator(plan.videoInputSelector!).first()
    try {
      await inputLocator.waitFor({ state: 'attached', timeout: 10_000 })
    } catch {
      // 回退：任何 accept 包含 video 的 file input
      inputLocator = page.locator('input[type="file"][accept*="video"]').first()
      try {
        await inputLocator.waitFor({ state: 'attached', timeout: 30_000 })
      } catch {
        // 最终回退：任何 file input
        inputLocator = page.locator('input[type="file"]').first()
        await inputLocator.waitFor({ state: 'attached', timeout: 30_000 })
      }
    }

    await inputLocator.setInputFiles(task.input.videoPath!)

    // 等平台前端上传完成：标题输入框出现可交互（最长 5 分钟）
    if (plan.titleInputSelector !== undefined) {
      await page.locator(plan.titleInputSelector).first().waitFor({ state: 'visible', timeout: 300_000 }).catch(() => {})
    }
  }

  private async uploadImages(
    page: Page, taskId: string, task: PublishTask, plan: PublishPlan,
  ): Promise<void> {
    this.tasks.update(taskId, { status: 'uploading', step: 'images' })

    await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    let inputLocator = page.locator(plan.imageInputSelector!).first()
    try {
      await inputLocator.waitFor({ state: 'attached', timeout: 10_000 })
    } catch {
      inputLocator = page.locator('input[type="file"][accept*="image"]').first()
      try {
        await inputLocator.waitFor({ state: 'attached', timeout: 30_000 })
      } catch {
        inputLocator = page.locator('input[type="file"]').first()
        await inputLocator.waitFor({ state: 'attached', timeout: 30_000 })
      }
    }

    await inputLocator.setInputFiles(task.input.imagePaths!)
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

    // 先尝试修复页面的 __name 冲突
    await this.fixNameConflict(page)

    // 用 fill() 方法
    try {
      await titleBox.fill(title)
    } catch {
      // fill 失败，用 CDP 的 Runtime.evaluate 直接设置（绕过 Playwright 的 evaluate 包装）
      await this.cdpSetValue(page, plan.titleInputSelector!, title, 'input')
    }
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

    await this.fixNameConflict(page)

    try {
      await descBox.fill(description)
    } catch {
      // contenteditable 的 fill 可能失败，用 CDP
      await this.cdpSetValue(page, plan.descInputSelector!, description, 'contenteditable')
    }
  }

  /** 修复抖音安全 SDK 注册的 __name getter 冲突。 */
  private async fixNameConflict(page: Page): Promise<void> {
    try {
      // 用 CDP 的 Runtime.evaluate 直接执行，绕过 Playwright 的 evaluate 包装
      const cdp = await page.context().newCDPSession(page)
      await cdp.send('Runtime.evaluate', {
        expression: `
          try {
            if (typeof __name === 'undefined' || !__name) {
              window.__name = function(fn, name) { return fn; }
            }
          } catch(e) {}
        `,
        returnByValue: true,
      })
      await cdp.detach()
    } catch {
      // CDP 失败，忽略
    }
  }

  /** 通过 CDP 直接设置 input 或 contenteditable 的值。 */
  private async cdpSetValue(page: Page, selector: string, value: string, type: 'input' | 'contenteditable'): Promise<void> {
    try {
      const cdp = await page.context().newCDPSession(page)
      const escapedSel = selector.replace(/\\/g, '\\\\').replace(/'/g, "\\'")
      const escapedVal = value.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')

      if (type === 'input') {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector('${escapedSel}'); if(el) { el.focus(); el.value = '${escapedVal}'; el.dispatchEvent(new Event('input', {bubbles:true})); el.dispatchEvent(new Event('change', {bubbles:true})); } })()`,
          returnByValue: true,
        })
      } else {
        await cdp.send('Runtime.evaluate', {
          expression: `(() => { const el = document.querySelector('${escapedSel}'); if(el) { el.focus(); el.textContent = '${escapedVal}'; el.dispatchEvent(new Event('input', {bubbles:true})); } })()`,
          returnByValue: true,
        })
      }
      await cdp.detach()
    } catch {
      // CDP 也失败，跳过
    }
  }

  // ─── 发布按钮点击 ──────────────────────────────────────────────────────

  private async clickPublishButton(page: Page, plan: PublishPlan): Promise<boolean> {
    // 先精确匹配
    for (const text of plan.publishButtonTexts) {
      const exact = page.getByRole('button', { name: text, exact: true })
      if (await exact.count() > 0 && await exact.first().isVisible().catch(() => false)) {
        try {
          if (await exact.first().isDisabled().catch(() => false)) continue
          await exact.first().click({ timeout: 15_000 })
          return true
        } catch {
          // 继续尝试下一个语义候选，不把 click 失败误报成已提交。
        }
      }
    }
    // 兜底：子串匹配
    for (const text of plan.publishButtonTexts) {
      const button = page.locator(`button:has-text("${text}")`).first()
      if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
        try {
          if (await button.isDisabled().catch(() => false)) continue
          await button.click({ timeout: 15_000 })
          return true
        } catch {
          // 继续尝试下一个候选。
        }
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

    // 检查是否出现验证码/二次验证
    const captchaDetected = await this.detectCaptcha(page)
    if (captchaDetected) {
      throw new Error('平台要求验证码或二次验证，请手动完成后重试')
    }

    // 先检查网络响应，优先保留带作品 ID/URL 的强证据。
    const responseReceipt = await this.checkCollectedResponses(collector, platform)
    if (responseReceipt?.proofLevel === 'A') return responseReceipt

    // URL 跳转和成功页是次强证据。
    const urlReceipt = await this.checkUrlRedirect(page, platform)
    if (urlReceipt !== undefined) return urlReceipt

    // Toast 只是弱证据；即使先出现，也不能覆盖已经收集的网络证据。
    const successReceipt = await this.checkSuccessToast(page, plan)
    if (successReceipt !== undefined) return responseReceipt ?? successReceipt

    // 再等一会儿，看看有没有延迟的提示
    await page.waitForTimeout(5000)

    const delayedResponseReceipt = await this.checkCollectedResponses(collector, platform)
    if (delayedResponseReceipt?.proofLevel === 'A') return delayedResponseReceipt
    const delayedSuccessReceipt = await this.checkSuccessToast(page, plan)
    if (delayedSuccessReceipt !== undefined) return delayedResponseReceipt ?? delayedSuccessReceipt

    if (delayedResponseReceipt !== undefined) return delayedResponseReceipt

    return undefined
  }

  /** 检测验证码/二次验证弹窗。 */
  private async detectCaptcha(page: Page): Promise<boolean> {
    // 常见验证码/验证特征
    const captchaSelectors = [
      // 滑块验证码
      '.captcha-slider',
      '.slide-verify',
      '[class*="captcha"]',
      '[class*="verify"]',
      // 图形验证码
      'img[src*="captcha"]',
      'img[src*="verify"]',
      // 短信验证码
      'input[placeholder*="验证码"]',
      'input[placeholder*="短信"]',
      // 人机验证
      '.geetest_panel',
      '.tcaptcha-popup',
      '#captcha',
      // 抖音特定
      '[class*="secsdk"]',
      '[class*="verify"]',
    ]

    for (const selector of captchaSelectors) {
      const count = await page.locator(selector).count()
      if (count > 0) {
        const visible = await page.locator(selector).first().isVisible().catch(() => false)
        if (visible) {
          return true
        }
      }
    }

    // 检查页面文本中是否包含验证码相关关键词
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '')
    const captchaKeywords = ['验证码', '短信验证', '滑动验证', '拖动滑块', '请完成验证', '安全验证', '人机验证']
    for (const keyword of captchaKeywords) {
      if (bodyText.includes(keyword)) {
        return true
      }
    }

    return false
  }

  /** 检查成功提示文本。 */
  private async checkSuccessToast(page: Page, plan: PublishPlan): Promise<PublishReceipt | undefined> {
    for (const text of plan.successTexts) {
      const visible = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)
      if (visible) {
        return {
          proofLevel: 'C',
          verificationMethod: 'success-toast',
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
    const urlLooksSuccessful = currentUrl.includes('success') || currentUrl.includes('complete')
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 4000)).catch(() => '')
    const pageShowsAcceptedState = ['发布成功', '已发布', '审核中', '作品已提交'].some((text) => bodyText.includes(text))
    // 仅跳到 manage 不足以证明发布成功；必须同时有成功路径或平台接受状态文案。
    if (urlLooksSuccessful || pageShowsAcceptedState) {
      return {
        proofLevel: 'B',
        verificationMethod: 'url-redirect',
        evidence: ['url-redirect'],
        url: sanitizeUrl(currentUrl),
        rawResponse: `URL 跳转到：${currentUrl}`,
      }
    }
    return undefined
  }

  /** 检查收集到的网络响应。 */
  private async checkCollectedResponses(collector: PublishResponseCollector, _platform: PlatformDef): Promise<PublishReceipt | undefined> {
    const responses = await collector.getResponses()
    let weakReceipt: PublishReceipt | undefined
    for (const resp of responses) {
      if (resp.status >= 200 && resp.status < 300) {
        try {
          const json = JSON.parse(resp.body) as unknown
          // 抖音返回 status_code / err_no；通用检查 code / status
          const record = json !== null && typeof json === 'object' && !Array.isArray(json)
            ? json as Record<string, unknown>
            : {}
          const success = [record.status_code, record.err_no, record.code].some((value) => value === 0 || value === '0')
            || record.status === 'success'
          if (success) {
            const platformPublicationId = findPublicationId(json)
            const publicationUrl = findPublicationUrl(json)
            const receipt: PublishReceipt = {
              proofLevel: platformPublicationId !== undefined || publicationUrl !== undefined ? 'A' : 'C',
              verificationMethod: 'network-response',
              evidence: ['network-response'],
              submittedAt: new Date().toISOString(),
              ...(platformPublicationId !== undefined ? { platformPublicationId } : {}),
              ...(publicationUrl !== undefined ? { url: sanitizeUrl(publicationUrl) } : {}),
              responseUrl: sanitizeUrl(resp.url),
              rawResponse: redactSensitiveText(resp.body.slice(0, 2000)),
            }
            if (receipt.proofLevel === 'A') return receipt
            weakReceipt ??= receipt
          }
        } catch {
          // 非 JSON 响应，跳过
        }
      }
    }
    return weakReceipt
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
      await this.fixNameConflict(managePage)
      await managePage.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {})
      await managePage.waitForTimeout(5000)

      // 用 CDP 获取页面文本，避免 evaluate 的 __name 冲突
      let found = false
      try {
        const cdp = await managePage.context().newCDPSession(managePage)
        const result = await cdp.send('Runtime.evaluate', {
          expression: `document.body.innerText.includes(${JSON.stringify(titleKey)})`,
          returnByValue: true,
        })
        found = result.result.value === true
        await cdp.detach()
      } catch {
        // CDP 失败，回退到 evaluate
        found = await managePage.evaluate(
          (key: string) => document.body.innerText.includes(key),
          titleKey,
        ).catch(() => false)
      }

      if (found) {
        return {
          proofLevel: 'A',
          verificationMethod: 'content-list',
          evidence: ['content-list-match'],
          submittedAt: new Date().toISOString(),
          rawResponse: `在内容管理列表找到标题：${titleKey}`,
        }
      }
    } catch {
      // 验证失败
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
  private readonly pending = new Map<PwResponse, Promise<string>>()
  private readonly done: CollectedResponse[] = []

  onResponse(response: PwResponse): void {
    try {
      const url = response.url()
      if (isLikelySubmissionResponseUrl(url)) {
        // 保存 Promise 引用，getResponses() 时 await 全部
        const bodyPromise = response.text().catch(() => '')
        this.pending.set(response, bodyPromise)
        // 清理：完成后从 pending 移到 done
        void bodyPromise.then((body) => {
          this.pending.delete(response)
          this.done.push({ url, status: response.status(), body })
        })
      }
    } catch {
      // ignore
    }
  }

  /** 等待所有已收集响应的 body 读取完成后再返回。 */
  async getResponses(): Promise<CollectedResponse[]> {
    // 等所有 pending 的 body 读完
    await Promise.all([...this.pending.values()])
    return [...this.done]
  }
}

// ─── 工具函数 ────────────────────────────────────────────────────────────────

/** 校验输入的基础完整性。 */
export function validatePublishInput(
  input: PublishInput,
  options: { checkFiles?: boolean } = {},
): string | null {
  if (input === undefined || input.title === undefined || input.title.trim() === '') return 'title 必填'

  const hasVideo = input.videoPath !== undefined && input.videoPath.trim() !== ''
  const imagePaths = input.imagePaths ?? []
  const hasImages = imagePaths.length > 0
  if (hasVideo && hasImages) return 'videoPath 和 imagePaths 只能二选一'
  if (!hasVideo && !hasImages) {
    return 'videoPath 或 imagePaths 至少提供一个'
  }

  const checkFiles = options.checkFiles !== false
  if (hasVideo) {
    if (!isAbsoluteFilePath(input.videoPath!)) return `视频路径必须是绝对路径：${input.videoPath}`
    if (checkFiles && !existsSync(input.videoPath!)) return `视频文件不存在：${input.videoPath}`
  }
  for (const imagePath of imagePaths) {
    if (imagePath.trim() === '') return '图片路径不能为空'
    if (!isAbsoluteFilePath(imagePath)) return `图片路径必须是绝对路径：${imagePath}`
    if (checkFiles && !existsSync(imagePath)) return `图片文件不存在：${imagePath}`
  }
  if (input.coverPath !== undefined) {
    if (!isAbsoluteFilePath(input.coverPath)) return `封面路径必须是绝对路径：${input.coverPath}`
    if (checkFiles && !existsSync(input.coverPath)) return `封面文件不存在：${input.coverPath}`
  }
  if (input.tags?.some((tag) => tag.trim() === '')) return '标签不能为空字符串'
  return null
}

/** C 级 Toast/弱网络信号不能单独把任务标成 published。 */
export function isSufficientProof(receipt: PublishReceipt): boolean {
  return receipt.proofLevel === 'A' || receipt.proofLevel === 'B'
}

function isAbsoluteFilePath(value: string): boolean {
  // 测试夹具和跨平台任务可能使用 POSIX 路径；Windows 绝对路径另行兼容盘符形式。
  return isAbsolute(value) || /^[/\\]/.test(value) || /^[A-Za-z]:[\\/]/.test(value)
}

function isLikelySubmissionResponseUrl(value: string): boolean {
  const lower = value.toLowerCase()
  return lower.includes('/publish')
    || lower.includes('/upload')
    || lower.includes('/create')
    || lower.includes('aweme/create')
    || lower.includes('note/create')
}

const PUBLICATION_ID_KEYS = new Set([
  'aweme_id', 'awemeId', 'item_id', 'itemId', 'publication_id', 'publicationId',
  'video_id', 'videoId', 'note_id', 'noteId', 'article_id', 'articleId',
])

const PUBLICATION_URL_KEYS = new Set(['share_url', 'shareUrl', 'publication_url', 'publicationUrl'])

function findPublicationId(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPublicationId(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const [key, candidate] of Object.entries(record)) {
    if (PUBLICATION_ID_KEYS.has(key) && (typeof candidate === 'string' || typeof candidate === 'number')) {
      return String(candidate)
    }
  }
  for (const candidate of Object.values(record)) {
    const found = findPublicationId(candidate, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function findPublicationUrl(value: unknown, depth = 0): string | undefined {
  if (depth > 5 || value === null || typeof value !== 'object') return undefined
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findPublicationUrl(item, depth + 1)
      if (found !== undefined) return found
    }
    return undefined
  }
  const record = value as Record<string, unknown>
  for (const [key, candidate] of Object.entries(record)) {
    if (PUBLICATION_URL_KEYS.has(key) && typeof candidate === 'string' && /^https?:\/\//.test(candidate)) {
      return candidate
    }
  }
  for (const candidate of Object.values(record)) {
    const found = findPublicationUrl(candidate, depth + 1)
    if (found !== undefined) return found
  }
  return undefined
}

function sanitizeUrl(value: string): string {
  try {
    const url = new URL(value)
    return `${url.origin}${url.pathname}`
  } catch {
    return value.split('?')[0] ?? value
  }
}

function redactSensitiveText(value: string): string {
  return value
    .replace(/("?(?:authorization|cookie|token|access_token|refresh_token|phone|mobile|password)"?\s*:\s*")([^"\\]*)/gi, '$1[REDACTED]')
    .replace(/(Bearer\s+)[A-Za-z0-9._-]+/gi, '$1[REDACTED]')
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
