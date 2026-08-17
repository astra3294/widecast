/**
 * 小红书端到端发布测试脚本（不发布）。
 * 用法: npx tsx scripts/e2e-xiaohongshu.ts [imagePath]
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'xiaohongshu')
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish'

const TEST_TITLE = 'Widecast 测试笔记 - 请忽略'
const TEST_DESC = '这是 Widecast 自动化测试笔记 #测试 #自动化'

async function main(): Promise<void> {
  const imagePath = process.argv[2] ?? join(process.cwd(), 'test-fixtures', 'test-image.jpg')
  const results: Array<{ step: string; ok: boolean; detail: string }> = []

  function report(step: string, ok: boolean, detail: string): void {
    results.push({ step, ok, detail })
    console.log(`${ok ? '✅' : '❌'} [${step}] ${detail}`)
  }

  console.log('=== 小红书端到端测试（不发布） ===')
  console.log(`图片: ${imagePath}`)
  console.log()

  if (!existsSync(imagePath)) {
    console.error(`图片文件不存在: ${imagePath}`)
    process.exit(1)
  }

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  try {
    const page = await context.newPage()

    // Step 1: 打开发布页
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)
    report('open-page', true, `URL: ${page.url()}`)

    // Step 2: 登录态检查
    const url = page.url()
    const loggedIn = url.includes('creator.xiaohongshu.com/new') || url.includes('creator.xiaohongshu.com/publish')
    const loginPage = url.includes('login')
    report('login-check', loggedIn, loggedIn ? '已登录' : loginPage ? '未登录（登录页）' : '未知状态')

    if (!loggedIn) {
      console.log('\n❌ 小红书未登录，请先手动登录后再运行此脚本')
      console.log('登录后重新运行: npx tsx scripts/e2e-xiaohongshu.ts')
      await page.waitForTimeout(10000)
      return
    }

    // Step 3: 定位图片上传 input
    const imageSelectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"]',
    ]
    let usedImageSel = ''
    for (const sel of imageSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0) {
        usedImageSel = sel
        break
      }
    }
    report('image-input', usedImageSel !== '', `选择器: "${usedImageSel}"`)

    // Step 4: 上传图片
    if (usedImageSel) {
      const imageInput = page.locator(usedImageSel).first()
      await imageInput.setInputFiles(imagePath)
      report('upload-image', true, 'setInputFiles 已调用')
    }

    // Step 5: 等待标题框
    const titleSelectors = [
      'input[placeholder*="标题"]',
      'input[placeholder*="title"]',
      'input[name="title"]',
    ]
    let titleBox: any = null
    for (const sel of titleSelectors) {
      try {
        await page.locator(sel).first().waitFor({ state: 'visible', timeout: 30_000 })
        titleBox = page.locator(sel).first()
        report('title-input', true, `选择器: "${sel}"`)
        break
      } catch { continue }
    }
    if (!titleBox) {
      report('title-input', false, '标题框未出现')
    }

    // Step 6: 填写标题
    if (titleBox) {
      try {
        await titleBox.fill(TEST_TITLE)
        report('fill-title', true, `填入值: "${TEST_TITLE}"`)
      } catch (e) {
        report('fill-title', false, `fill 失败: ${String(e).slice(0, 100)}`)
      }
    }

    // Step 7: 填写描述
    const descSelectors = [
      '[contenteditable="true"]',
      '.ql-editor',
      '.ProseMirror',
      'textarea',
    ]
    let descBox: any = null
    for (const sel of descSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0 && await page.locator(sel).first().isVisible().catch(() => false)) {
        descBox = page.locator(sel).first()
        report('desc-input', true, `选择器: "${sel}"`)
        break
      }
    }
    if (descBox) {
      try {
        await descBox.fill(TEST_DESC)
        report('fill-desc', true, `描述长度: ${TEST_DESC.length}`)
      } catch (e) {
        report('fill-desc', false, `fill 失败: ${String(e).slice(0, 100)}`)
      }
    } else {
      report('desc-input', false, '描述框未找到')
    }

    // Step 8: 定位发布按钮
    const publishTexts = ['发布', '发布笔记', '发布视频', '发布图文', '发表']
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

    // 汇总
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
    await page.waitForTimeout(10000)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
