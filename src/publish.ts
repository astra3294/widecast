/**
 * 发布服务:浏览器模式发布(流程学习自蚁小二 RPA 模板,原创实现)。
 *
 * 流程:
 *  登录检查 → 打开发布页 → 视频 setInputFiles(平台前端自行上传/签名)
 *  → 填标题(真键盘输入,同蚁小二 onSendInput 思路)→ 填简介 → 按文本找发布按钮
 *  → 点击 → 轮询成功/审核提示。
 * 每步更新任务状态并落盘(断点恢复基础)。
 */
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { BrowserManager } from './browser.js'
import { findPlatform } from './platforms.js'
import { TaskStore, type PublishInput, type PublishTask } from './tasks.js'

export class PublishService {
  private readonly running = new Set<string>()

  constructor(
    private readonly browser: BrowserManager,
    private readonly tasks: TaskStore,
  ) {}

  listTasks(): PublishTask[] {
    return this.tasks.list()
  }

  getTask(id: string): PublishTask | undefined {
    return this.tasks.get(id)
  }

  /** 启动发布任务(异步执行,立即返回任务)。 */
  start(platformId: string, input: PublishInput): { ok: boolean; task?: PublishTask; message?: string } {
    const platform = findPlatform(platformId)
    if (platform === undefined) return { ok: false, message: `未知平台:${platformId}` }
    if (platform.publish === undefined) return { ok: false, message: `${platform.name} 的发布流程尚未实现` }
    if (input.videoPath !== undefined && !existsSync(input.videoPath)) {
      return { ok: false, message: `视频文件不存在:${input.videoPath}` }
    }
    const task = this.tasks.create(platformId, input)
    void this.run(task.id)
    return { ok: true, task }
  }

  private async run(taskId: string): Promise<void> {
    if (this.running.has(taskId)) return
    this.running.add(taskId)
    try {
      const task = this.tasks.get(taskId)
      if (task === undefined) return
      const platform = findPlatform(task.platform)
      const isImage = task.input.imagePaths !== undefined && task.input.imagePaths.length > 0
      const plan = isImage
        ? (platform?.publishImage ?? platform?.publish)
        : platform?.publish
      if (platform === undefined || plan === undefined) {
        this.tasks.update(taskId, { status: 'failed', step: 'no-plan', message: '平台未配置发布流程' })
        return
      }
      const publishUrl = isImage && platform.publishImageUrl !== undefined ? platform.publishImageUrl : platform.publishUrl!

      this.tasks.update(taskId, { status: 'uploading', step: 'open-page' })
      const page = await this.browser.openPage(task.platform, publishUrl)
      await page.waitForLoadState('domcontentloaded', { timeout: 60_000 }).catch(() => {})

      // 登录反证:出现登录表单 → 失败,提示先登录
      if (platform.probe?.blockedBySelectors !== undefined) {
        const blocked = await page.$(platform.probe.blockedBySelectors[0]!).catch(() => null)
        if (blocked !== null) {
          this.tasks.update(taskId, { status: 'failed', step: 'not-logged-in', message: `${platform.name} 未登录,请先在面板登录` })
          return
        }
      }

      // 1) 图片/视频:setInputFiles(平台前端自行上传)
      if (isImage && plan.imageInputSelector !== undefined) {
        this.tasks.update(taskId, { status: 'uploading', step: 'images' })
        const input = page.locator(plan.imageInputSelector).first()
        await input.waitFor({ state: 'attached', timeout: 30_000 })
        await input.setInputFiles(task.input.imagePaths!)
        if (plan.titleInputSelector !== undefined) {
          await page.locator(plan.titleInputSelector).first().waitFor({ state: 'visible', timeout: 300_000 }).catch(() => {})
        }
      } else if (task.input.videoPath !== undefined && plan.videoInputSelector !== undefined) {
        this.tasks.update(taskId, { status: 'uploading', step: 'video' })
        const input = page.locator(plan.videoInputSelector).first()
        await input.waitFor({ state: 'attached', timeout: 30_000 })
        await input.setInputFiles(task.input.videoPath)
        // 等平台前端上传完成:标题输入框出现可交互
        if (plan.titleInputSelector !== undefined) {
          await page.locator(plan.titleInputSelector).first().waitFor({ state: 'visible', timeout: 300_000 }).catch(() => {})
        }
      }

      // 2) 标题(真键盘输入,30ms 间隔,贴近真人)
      if (task.input.title !== '' && plan.titleInputSelector !== undefined) {
        this.tasks.update(taskId, { status: 'uploading', step: 'title' })
        const title = plan.titleMaxLength !== undefined ? task.input.title.slice(0, plan.titleMaxLength) : task.input.title
        const titleBox = page.locator(plan.titleInputSelector).first()
        await titleBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
        await titleBox.click({ timeout: 15_000 }).catch(() => {})
        await page.keyboard.type(title, { delay: 30 })
      }

      // 3) 简介/正文(抖音:话题以 #tag 形式拼接进正文)
      let description = task.input.description ?? ''
      if (task.input.tags !== undefined && task.input.tags.length > 0) {
        const tagText = task.input.tags.map((tag) => `#${tag}`).join(' ')
        description = description === '' ? tagText : `${description}\n\n${tagText}`
      }
      if (description !== '' && plan.descInputSelector !== undefined) {
        this.tasks.update(taskId, { status: 'uploading', step: 'description' })
        const descBox = page.locator(plan.descInputSelector).first()
        await descBox.waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
        await descBox.click({ timeout: 15_000 }).catch(() => {})
        await page.keyboard.type(description, { delay: 10 })
      }

      // 4) 发布:按文本依次尝试
      this.tasks.update(taskId, { status: 'publishing', step: 'submit' })
      let clicked = false
      for (const text of plan.publishButtonTexts) {
        const button = page.locator(`button:has-text("${text}")`).first()
        if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
          await button.click({ timeout: 15_000 }).catch(() => {})
          clicked = true
          break
        }
      }
      if (!clicked) {
        this.tasks.update(taskId, { status: 'failed', step: 'submit', message: '未找到发布按钮' })
        return
      }

      // 5) 处理可能出现的确认弹窗(按文本点击确认按钮,最多 30 秒)
      this.tasks.update(taskId, { status: 'publishing', step: 'confirm-dialog' })
      const confirmTexts = plan.confirmButtonTexts ?? []
      if (confirmTexts.length > 0) {
        const dialogDeadline = Date.now() + 30_000
        while (Date.now() < dialogDeadline) {
          let clickedConfirm = false
          for (const text of confirmTexts) {
            const button = page.locator(`button:has-text("${text}")`).first()
            if (await button.count() > 0 && await button.isVisible().catch(() => false)) {
              await button.click({ timeout: 10_000 }).catch(() => {})
              clickedConfirm = true
              break
            }
          }
          if (!clickedConfirm) break
          await page.waitForTimeout(1500)
        }
      }

      // 6) 平台侧确认:打开内容管理页,作品列表出现标题才算发布成功
      this.tasks.update(taskId, { status: 'publishing', step: 'verify' })
      const manageUrl = platform.manageUrl
      if (manageUrl !== undefined) {
        await page.goto(manageUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
        await page.waitForTimeout(5000)
        const titleKey = task.input.title.slice(0, 10)
        const found = await page.evaluate((key: string) => document.body.innerText.includes(key), titleKey).catch(() => false)
        if (found) {
          this.tasks.update(taskId, { status: 'done', step: 'verified', message: '平台侧确认:作品已出现在内容管理列表' })
          return
        }
        this.tasks.update(taskId, { status: 'failed', step: 'verify', message: '已点击发布但内容管理列表未出现该作品(可能被拦截/需人工确认),请查看浏览器窗口' })
        return
      }

      // 无内容管理页配置的平台:退回提示文本判定
      for (const text of plan.successTexts) {
        if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) {
          this.tasks.update(taskId, { status: 'done', step: 'done', message: text })
          return
        }
      }
      this.tasks.update(taskId, { status: 'failed', step: 'unverified', message: '发布结果无法确认(平台无成功提示),请人工查看' })
    } catch (error) {
      this.tasks.update(taskId, { status: 'failed', step: 'error', message: String(error) })
    } finally {
      this.running.delete(taskId)
    }
  }
}

/** 校验输入的基础完整性。 */
export function validatePublishInput(input: PublishInput): string | null {
  if (input.title === undefined || input.title.trim() === '') return 'title 必填'
  if (input.videoPath === undefined && (input.imagePaths === undefined || input.imagePaths.length === 0)) {
    return 'videoPath 或 imagePaths 至少提供一个'
  }
  if (input.videoPath !== undefined && !existsSync(input.videoPath)) return `视频文件不存在:${input.videoPath}`
  if (input.videoPath !== undefined && existsSync(input.videoPath) && dirname(input.videoPath) === '') return null
  return null
}
