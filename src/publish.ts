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

export type { PublishInput, PublishTask, PublishReceipt }

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
      const editorDump = await dumpEditorState(page).catch(() => ({ url: page.url(), error: 'dump failed' }))
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

      // 7.5) 检测验证码/二次验证（点击发布后立即检查）
      this.tasks.update(taskId, { status: 'verifying', step: 'check-captcha' })
      const captchaDetected = await this.detectCaptcha(page)
      if (captchaDetected) {
        page.off('response', responseHandler)
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
      page.off('response', responseHandler)

      // 9) 验证结果
      if (receipt !== undefined) {
        if (receipt.proofLevel === 'A') {
          // A 级凭证：直接确认
          this.tasks.update(taskId, {
            status: 'done',
            step: 'verified',
            message: '发布成功（A级凭证）',
            receipt,
          })
        } else if (receipt.proofLevel === 'B') {
          // B 级凭证：尝试在内容管理页进一步验证以升级到 A 级
          const listReceipt = await this.verifyInContentList(page, platform, task)
          if (listReceipt !== undefined && listReceipt.proofLevel === 'A') {
            // 升级为 A 级：合并凭证
            this.tasks.update(taskId, {
              status: 'done',
              step: 'verified',
              message: '发布成功（A级凭证：内容管理列表确认）',
              receipt: {
                ...listReceipt,
                evidence: [...new Set([...receipt.evidence, ...listReceipt.evidence])],
              },
            })
          } else {
            // 保持 B 级
            this.tasks.update(taskId, {
              status: 'done',
              step: 'verified',
              message: '发布成功（B级凭证）',
              receipt,
            })
          }
        } else {
          // C 级或未知：needs_attention
          this.tasks.markNeedsAttention(taskId, '发布结果不确定，请人工确认', receipt)
        }
      } else {
        // 没有任何凭证：尝试内容管理页验证
        const listReceipt = await this.verifyInContentList(page, platform, task)
        if (listReceipt !== undefined) {
          this.tasks.update(taskId, {
            status: 'done',
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

    // 检查是否出现验证码/二次验证
    const captchaDetected = await this.detectCaptcha(page)
    if (captchaDetected) {
      throw new Error('平台要求验证码或二次验证，请手动完成后重试')
    }

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
  private async checkCollectedResponses(collector: PublishResponseCollector, platform: PlatformDef): Promise<PublishReceipt | undefined> {
    const responses = await collector.getResponses()
    for (const resp of responses) {
      if (resp.status >= 200 && resp.status < 300) {
        try {
          const json = JSON.parse(resp.body) as Record<string, unknown>
          // 抖音返回 status_code / err_no；通用检查 code / status
          const success =
            json.status_code === 0 ||
            json.err_no === 0 ||
            json.code === 0 ||
            json.status === 'success'
          if (success) {
            return {
              proofLevel: 'A',
              evidence: ['network-response'],
              submittedAt: new Date().toISOString(),
              url: resp.url,
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
      // 修复 __name 冲突
      await this.fixNameConflict(page)

      // 在新页面打开内容管理页
      const managePage = await this.browser.openPage(task.platform, platform.manageUrl)
      await managePage.waitForLoadState('domcontentloaded', { timeout: 45_000 }).catch(() => {})
      await managePage.waitForTimeout(5000)

      // 用 CDP 获取页面文本，避免 evaluate 的 __name 冲突
      let found = false
      try {
        const cdp = await managePage.context().newCDPSession(managePage)
        const result = await cdp.send('Runtime.evaluate', {
          expression: `document.body.innerText.includes('${titleKey.replace(/'/g, "\\'")}')`,
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
      if (url.includes('/api/') || url.includes('/publish') || url.includes('/upload') || url.includes('/create')) {
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
