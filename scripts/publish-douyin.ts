/**
 * 抖音视频真实发布测试脚本。
 *
 * 使用 Widecast 的浏览器档案和发布逻辑，完成：
 * 1. 登录态检查
 * 2. 视频上传
 * 3. 标题/描述填写
 * 4. 点击发布
 * 5. 等待响应和结果验证
 *
 * 用法: npx tsx scripts/publish-douyin.ts [videoPath] [title]
 *
 * 警告: 这会真正发布内容到抖音！请确保使用测试账号或测试内容。
 */
import { chromium, type Page, type Response as PwResponse } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'douyin')
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage'

// ─── 响应收集器 ──────────────────────────────────────────────────────────────

interface CollectedResponse {
  url: string
  status: number
  body: string
}

class ResponseCollector {
  private readonly pending = new Map<PwResponse, Promise<string>>()
  private readonly done: CollectedResponse[] = []

  onResponse(response: PwResponse): void {
    try {
      const url = response.url()
      if (url.includes('/api/') || url.includes('/publish') || url.includes('/upload') || url.includes('/create')) {
        const bodyPromise = response.text().catch(() => '')
        this.pending.set(response, bodyPromise)
        void bodyPromise.then((body) => {
          this.pending.delete(response)
          this.done.push({ url, status: response.status(), body })
        })
      }
    } catch { /* ignore */ }
  }

  async getResponses(): Promise<CollectedResponse[]> {
    await Promise.all([...this.pending.values()])
    return [...this.done]
  }
}

// ─── 主流程 ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const videoPath = process.argv[2] ?? join(process.cwd(), 'test-fixtures', 'sample.mp4')
  const title = process.argv[3] ?? 'Widecast 测试视频 - 请忽略此作品'
  const description = '这是 Widecast 自动化测试作品 #测试 #自动化'

  console.log('=== 抖音视频真实发布测试 ===')
  console.log(`视频: ${videoPath}`)
  console.log(`标题: ${title}`)
  console.log()

  if (!existsSync(videoPath)) {
    console.error(`视频文件不存在: ${videoPath}`)
    process.exit(1)
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
    args: [
      '--disable-blink-features=AutomationControlled',
      '--disable-features=IsolateOrigins,site-per-process',
    ],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  try {
    const page = await context.newPage()
    const collector = new ResponseCollector()

    // ── Step 1: 登录态检查 ──
    console.log('[1/7] 登录态检查...')
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    const blocked = await page.$('input[placeholder="请输入手机号"]').catch(() => null)
    if (blocked !== null) {
      console.error('❌ 未登录')
      process.exit(1)
    }
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 500)).catch(() => '')
    if (bodyText.includes('扫码登录') || bodyText.includes('我是创作者')) {
      console.error('❌ 未登录')
      process.exit(1)
    }
    console.log('✅ 已登录')

    // ── Step 2: 上传视频 ──
    console.log('[2/7] 上传视频...')
    const videoInput = page.locator('input[type="file"][accept*="video"]').first()
    await videoInput.setInputFiles(videoPath)
    console.log('✅ setInputFiles 已调用')

    // ── Step 3: 等待标题框出现 ──
    console.log('[3/7] 等待标题框...')
    const titleSelector = 'input[placeholder="填写作品标题，为作品获得更多流量"]'
    await page.locator(titleSelector).first().waitFor({ state: 'visible', timeout: 120_000 })
    console.log('✅ 标题框出现')

    // ── Step 4: 填写标题 ──
    console.log('[4/7] 填写标题...')
    const titleBox = page.locator(titleSelector).first()
    await titleBox.click({ timeout: 10_000 })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(title, { delay: 30 })
    console.log(`✅ 标题: "${title}"`)

    // ── Step 5: 填写描述 ──
    console.log('[5/7] 填写描述...')
    const descBox = page.locator('.zone-container.editor-kit-container.editor').first()
    const descVisible = await descBox.isVisible().catch(() => false)
    if (descVisible) {
      await descBox.click({ timeout: 10_000 })
      await page.keyboard.type(description, { delay: 10 })
      console.log('✅ 描述已填入')
    } else {
      console.log('⚠️ 描述框未找到，跳过')
    }

    // ── Step 6: 注册响应监听 + 点击发布 ──
    console.log('[6/7] 点击发布...')
    page.on('response', (r) => collector.onResponse(r))

    // 先快照编辑器状态
    const preClickUrl = page.url()

    // 点击发布按钮
    const publishBtn = page.getByRole('button', { name: '发布', exact: true })
    const btnCount = await publishBtn.count()
    if (btnCount === 0) {
      console.error('❌ 未找到发布按钮')
      process.exit(1)
    }
    await publishBtn.first().click({ timeout: 15_000 })
    console.log('✅ 已点击发布按钮')

    // ── Step 7: 等待结果 ──
    console.log('[7/7] 等待发布结果...')

    // 处理确认弹窗
    const confirmTexts = ['确认发布', '确定', '知道了', '继续发布', '立即发布']
    const confirmDeadline = Date.now() + 30_000
    while (Date.now() < confirmDeadline) {
      let clickedConfirm = false
      for (const text of confirmTexts) {
        const btn = page.getByRole('button', { name: text, exact: true })
        if (await btn.count() > 0 && await btn.first().isVisible().catch(() => false)) {
          await btn.first().click({ timeout: 5_000 }).catch(() => {})
          console.log(`  点击确认: "${text}"`)
          clickedConfirm = true
          break
        }
      }
      if (!clickedConfirm) break
      await page.waitForTimeout(1500)
    }

    // 等待平台处理
    await page.waitForTimeout(8000)

    // 检查成功提示
    const successTexts = ['发布成功', '已发布', '审核中', '作品已提交']
    let foundSuccess = ''
    for (const text of successTexts) {
      if (await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)) {
        foundSuccess = text
        break
      }
    }

    // 检查 URL 变化
    const postClickUrl = page.url()
    const urlChanged = postClickUrl !== preClickUrl
    const urlIndicatesSuccess = postClickUrl.includes('manage') || postClickUrl.includes('success')

    // 检查网络响应
    const responses = await collector.getResponses()
    let foundApiSuccess = false
    let apiResponse = ''
    for (const resp of responses) {
      if (resp.status >= 200 && resp.status < 300) {
        try {
          const json = JSON.parse(resp.body) as Record<string, unknown>
          if (json.status_code === 0 || json.err_no === 0 || json.code === 0) {
            foundApiSuccess = true
            apiResponse = resp.body.slice(0, 500)
            break
          }
        } catch { /* non-JSON */ }
      }
    }

    // 汇总结果
    console.log('\n=== 发布结果 ===')
    if (foundSuccess) {
      console.log(`✅ 成功提示: "${foundSuccess}"`)
    }
    if (urlChanged) {
      console.log(`✅ URL 变化: ${preClickUrl} → ${postClickUrl}`)
    }
    if (urlIndicatesSuccess) {
      console.log(`✅ URL 指示成功: ${postClickUrl}`)
    }
    if (foundApiSuccess) {
      console.log(`✅ API 响应成功: ${apiResponse}`)
    }

    if (!foundSuccess && !urlIndicatesSuccess && !foundApiSuccess) {
      console.log('⚠️ 无法确认发布结果（needs_attention）')
      console.log(`  URL: ${postClickUrl}`)
      console.log(`  收集到 ${responses.length} 个 API 响应`)
      for (const resp of responses.slice(0, 5)) {
        console.log(`    ${resp.status} ${resp.url.slice(0, 100)}`)
      }

      // 尝试在内容管理页验证
      console.log('\n  尝试在内容管理页验证...')
      const managePage = await context.newPage()
      await managePage.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
      await managePage.waitForTimeout(5000)
      const titleKey = title.slice(0, 10)
      const foundInList = await managePage.evaluate(
        (key: string) => document.body.innerText.includes(key),
        titleKey,
      ).catch(() => false)
      if (foundInList) {
        console.log(`  ✅ 在内容管理列表找到标题: "${titleKey}"`)
      } else {
        console.log(`  ⚠️ 内容管理列表未找到标题: "${titleKey}"`)
      }
      await managePage.close()
    }

    // 等待用户查看
    console.log('\n页面保持打开，等待 15 秒后自动关闭...')
    await page.waitForTimeout(15_000)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('发布测试失败:', err)
  process.exit(1)
})
