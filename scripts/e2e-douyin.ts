/**
 * 抖音视频发布端到端测试（到填写表单为止，不点击发布）。
 *
 * 验证:
 * - 登录态检测
 * - 视频上传 input 定位和 setInputFiles
 * - 标题输入框出现和填写（含清除旧内容）
 * - 描述编辑区出现和填写
 * - 发布按钮定位
 * - 页面快照（按钮列表、输入框状态）
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'douyin')
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload'

const TEST_TITLE = 'Widecast 测试视频 - 请忽略此作品'
const TEST_DESC = '这是 Widecast 自动化测试作品，非真实发布 #测试 #自动化'

async function main(): Promise<void> {
  const videoPath = process.argv[2] ?? join(process.cwd(), 'test-fixtures', 'sample.mp4')
  const results: Array<{ step: string; ok: boolean; detail: string }> = []

  function report(step: string, ok: boolean, detail: string): void {
    results.push({ step, ok, detail })
    console.log(`${ok ? '✅' : '❌'} [${step}] ${detail}`)
  }

  console.log('=== 抖音视频发布端到端测试（不发布） ===')
  console.log(`视频: ${videoPath}`)
  console.log()

  if (!existsSync(videoPath)) {
    console.error(`视频文件不存在: ${videoPath}`)
    process.exit(1)
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
  })

  try {
    const page = await context.newPage()

    // ── Step 1: 打开发布页 ──
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)
    report('open-page', true, `URL: ${page.url()}`)

    // ── Step 2: 登录态检测 ──
    const blocked = await page.$('input[placeholder="请输入手机号"]').catch(() => null)
    if (blocked !== null) {
      report('login-check', false, '未登录（检测到手机号输入框）')
      process.exit(1)
    }
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '')
    if (bodyText.includes('扫码登录') || bodyText.includes('我是创作者')) {
      report('login-check', false, '未登录（检测到登录页文案）')
      process.exit(1)
    }
    report('login-check', true, '已登录')

    // ── Step 3: 定位视频上传 input ──
    const videoSelectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"]',
    ]
    let usedVideoSel = ''
    for (const sel of videoSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0) {
        usedVideoSel = sel
        break
      }
    }
    report('video-input', usedVideoSel !== '', `选择器: "${usedVideoSel}"`)

    // ── Step 4: 上传视频 ──
    const videoInput = page.locator(usedVideoSel).first()
    await videoInput.setInputFiles(videoPath)
    report('upload-video', true, 'setInputFiles 已调用')

    // ── Step 5: 等待标题输入框 ──
    const titleSelector = 'input[placeholder="填写作品标题，为作品获得更多流量"]'
    let titleBox: any = null
    try {
      await page.locator(titleSelector).first().waitFor({ state: 'visible', timeout: 120_000 })
      titleBox = page.locator(titleSelector).first()
      report('title-input', true, `选择器: "${titleSelector}"`)
    } catch {
      // 尝试备选
      for (const alt of ['input[placeholder*="标题"]', 'input[placeholder*="作品"]']) {
        const count = await page.locator(alt).count()
        if (count > 0 && await page.locator(alt).first().isVisible().catch(() => false)) {
          titleBox = page.locator(alt).first()
          report('title-input', true, `备选选择器: "${alt}"`)
          break
        }
      }
      if (titleBox === null) {
        report('title-input', false, '标题框未出现')
        // 打印所有可见 input 供诊断
        const inputs = await page.evaluate(() => {
          const result: string[] = []
          const els = document.querySelectorAll('input')
          for (let i = 0; i < els.length; i++) {
            const el = els[i]! as HTMLInputElement
            const rect = el.getBoundingClientRect()
            if (rect.width > 0 && rect.height > 0) {
              result.push(`type=${el.type} ph="${el.placeholder}" val="${el.value?.slice(0, 20)}"`)
            }
          }
          return result
        })
        console.log('  可见 input:', inputs)
        process.exit(1)
      }
    }

    // ── Step 6: 填写标题 ──
    await (titleBox as any).click({ timeout: 10_000 })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(TEST_TITLE, { delay: 30 })
    const titleValue = await (titleBox as any).inputValue().catch(() => '')
    const titleOk = titleValue.includes('Widecast')
    report('fill-title', titleOk, `填入值: "${titleValue}"`)

    // ── Step 7: 填写描述 ──
    const descSelectors = [
      '.zone-container.editor-kit-container.editor',
      '[contenteditable="true"]',
    ]
    let descBox: any = null
    for (const sel of descSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0 && await page.locator(sel).first().isVisible().catch(() => false)) {
        descBox = page.locator(sel).first()
        break
      }
    }
    if (descBox !== null) {
      await descBox.click({ timeout: 10_000 })
      await page.keyboard.type(TEST_DESC, { delay: 10 })
      const descText = await descBox.innerText().catch(() => '')
      const descOk = descText.includes('Widecast')
      report('fill-description', descOk, `描述长度: ${descText.length}`)
    } else {
      report('fill-description', false, '描述框未找到')
    }

    // ── Step 8: 定位发布按钮 ──
    const publishTexts = ['发布', '发表', '发 布', '立即投稿']
    let publishBtnText = ''
    for (const text of publishTexts) {
      const btn = page.getByRole('button', { name: text, exact: true })
      const count = await btn.count()
      if (count > 0 && await btn.first().isVisible().catch(() => false)) {
        publishBtnText = text
        break
      }
    }
    report('publish-button', publishBtnText !== '', `按钮文本: "${publishBtnText}"`)

    // ── Step 9: 页面快照（用 evaluate 安全版，避免 __name 冲突） ──
    try {
      const snapshot = await page.evaluate(() => {
        const r: { url: string; buttons: string[]; inputCount: number; editableCount: number } = {
          url: location.href,
          buttons: [],
          inputCount: 0,
          editableCount: 0,
        }
        // 收集按钮
        const btns = document.querySelectorAll('button')
        for (let i = 0; i < btns.length && r.buttons.length < 20; i++) {
          const el = btns[i]!
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) {
            const text = el.textContent?.trim().replace(/\s+/g, ' ').slice(0, 30) ?? ''
            if (text !== '') r.buttons.push(text)
          }
        }
        // 统计 input 和 contenteditable
        const inps = document.querySelectorAll('input, textarea')
        for (let i = 0; i < inps.length; i++) {
          const el = inps[i]! as HTMLElement
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) r.inputCount++
        }
        const edits = document.querySelectorAll('[contenteditable="true"]')
        for (let i = 0; i < edits.length; i++) {
          const el = edits[i]!
          const rect = el.getBoundingClientRect()
          if (rect.width > 0 && rect.height > 0) r.editableCount++
        }
        return r
      })
      report('page-snapshot', true, `按钮: [${snapshot.buttons.join(', ')}], inputs: ${snapshot.inputCount}, editables: ${snapshot.editableCount}`)
    } catch (e) {
      report('page-snapshot', false, `evaluate 失败: ${String(e).slice(0, 100)}`)
    }

    // ── 汇总 ──
    console.log('\n=== 测试结果汇总 ===')
    const passed = results.filter((r) => r.ok).length
    const failed = results.filter((r) => !r.ok).length
    console.log(`通过: ${passed} / ${results.length}, 失败: ${failed}`)
    if (failed > 0) {
      console.log('\n失败项:')
      for (const r of results.filter((r) => !r.ok)) {
        console.log(`  ❌ ${r.step}: ${r.detail}`)
      }
    }

    console.log('\n页面保持打开，等待 10 秒后自动关闭...')
    await page.waitForTimeout(10_000)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
