/**
 * 抖音发布流程端到端诊断（不真正发布）。
 * 用法: npx tsx scripts/test-douyin-flow.ts [videoPath]
 *
 * 流程:
 * 1. 登录态检查
 * 2. 打开发布页
 * 3. 上传视频文件
 * 4. 等待标题输入框出现
 * 5. 填写标题
 * 6. 填写描述
 * 7. 快照编辑器状态
 * 8. 定位发布按钮
 * 9. 停止（不点击发布）
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'douyin')
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload'

const TEST_TITLE = 'Widecast 测试视频 - 请忽略'
const TEST_DESC = '这是 Widecast 自动化测试，请勿当真 #测试'

async function main(): Promise<void> {
  const videoPath = process.argv[2] ?? join(process.cwd(), 'test-fixtures', 'test-video.mp4')

  console.log('=== 抖音发布流程诊断（不发布） ===')
  console.log(`视频: ${videoPath}`)
  console.log(`档案: ${PROFILE_DIR}`)
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
    console.log('[1/8] 打开发布页...')
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    // ── Step 2: 登录态检查 ──
    console.log('[2/8] 登录态检查...')
    const blocked = await page.$('input[placeholder="请输入手机号"]').catch(() => null)
    if (blocked !== null) {
      console.error('❌ 未登录（检测到手机号输入框）')
      process.exit(1)
    }
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '')
    if (bodyText.includes('扫码登录') || bodyText.includes('我是创作者')) {
      console.error('❌ 未登录（检测到登录页文案）')
      process.exit(1)
    }
    console.log('✅ 已登录')

    // ── Step 3: 定位视频上传 input ──
    console.log('[3/8] 定位视频上传 input...')
    const videoSelectors = [
      'input[type="file"][accept*="video"]',
      'input[type="file"]',
    ]
    let videoInput = null
    for (const sel of videoSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0) {
        videoInput = page.locator(sel).first()
        console.log(`  ✅ 使用选择器: "${sel}"`)
        break
      }
    }
    if (videoInput === null) {
      console.error('❌ 未找到视频上传 input')
      process.exit(1)
    }

    // ── Step 4: 上传视频 ──
    console.log('[4/8] 上传视频...')
    await videoInput.setInputFiles(videoPath)
    console.log('  已调用 setInputFiles')

    // 等待上传完成（标题输入框出现）
    console.log('  等待标题输入框出现（最长 5 分钟）...')
    const titleSelector = 'input[placeholder="填写作品标题，为作品获得更多流量"]'
    const titleAltSelectors = [
      'input[placeholder*="标题"]',
      'input[placeholder*="作品"]',
    ]

    let titleBox = null
    try {
      await page.locator(titleSelector).first().waitFor({ state: 'visible', timeout: 60_000 })
      titleBox = page.locator(titleSelector).first()
      console.log(`  ✅ 标题框出现: "${titleSelector}"`)
    } catch {
      // 尝试备选选择器
      for (const alt of titleAltSelectors) {
        const count = await page.locator(alt).count()
        if (count > 0 && await page.locator(alt).first().isVisible().catch(() => false)) {
          titleBox = page.locator(alt).first()
          console.log(`  ✅ 标题框出现（备选）: "${alt}"`)
          break
        }
      }
    }

    if (titleBox === null) {
      // 打印当前页面所有 input 的 placeholder 供诊断
      console.log('  ❌ 标题框未出现。当前页面所有 input:')
      const inputs = await page.evaluate(() => {
        const result: Array<{ tag: string; type: string; ph: string; visible: boolean }> = []
        const els = document.querySelectorAll('input, textarea')
        for (let i = 0; i < els.length; i++) {
          const el = els[i]! as HTMLInputElement
          const rect = el.getBoundingClientRect()
          const style = getComputedStyle(el)
          result.push({
            tag: el.tagName,
            type: el.getAttribute('type') ?? '',
            ph: el.getAttribute('placeholder') ?? '',
            visible: rect.width > 0 && rect.height > 0 && style.display !== 'none',
          })
        }
        return result
      })
      for (const inp of inputs) {
        console.log(`    ${inp.tag} type="${inp.type}" ph="${inp.ph}" visible=${inp.visible}`)
      }
      process.exit(1)
    }

    // ── Step 5: 填写标题 ──
    console.log('[5/8] 填写标题...')
    await titleBox.click({ timeout: 10_000 })
    await page.keyboard.press('Control+A')
    await page.keyboard.press('Backspace')
    await page.keyboard.type(TEST_TITLE, { delay: 30 })
    const titleValue = await titleBox.inputValue().catch(() => '')
    console.log(`  ✅ 标题已填入: "${titleValue}"`)

    // ── Step 6: 填写描述 ──
    console.log('[6/8] 填写描述...')
    const descSelectors = [
      '.zone-container.editor-kit-container.editor',
      '[contenteditable="true"]',
    ]
    let descBox = null
    for (const sel of descSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0 && await page.locator(sel).first().isVisible().catch(() => false)) {
        descBox = page.locator(sel).first()
        console.log(`  ✅ 使用选择器: "${sel}"`)
        break
      }
    }
    if (descBox !== null) {
      await descBox.click({ timeout: 10_000 })
      await page.keyboard.type(TEST_DESC, { delay: 10 })
      console.log('  ✅ 描述已填入')
    } else {
      console.log('  ⚠️ 描述框未找到（可能在其他位置）')
    }

    // ── Step 7: 快照编辑器状态 ──
    console.log('[7/8] 快照编辑器状态...')
    const editorState = await page.evaluate(() => {
      const vis = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const result: { buttons: string[]; inputs: string[]; editables: string[]; bodySnippet: string } = {
        buttons: [],
        inputs: [],
        editables: [],
        bodySnippet: '',
      }
      const btns = document.querySelectorAll('button, [role="button"]')
      for (let i = 0; i < btns.length; i++) {
        const el = btns[i]!
        if (!vis(el)) continue
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30)
        if (text !== '') result.buttons.push(text)
      }
      const inps = document.querySelectorAll('input, textarea')
      for (let i = 0; i < inps.length; i++) {
        const el = inps[i]! as HTMLInputElement
        if (!vis(el)) continue
        const ph = el.getAttribute('placeholder') ?? ''
        const val = el.value?.slice(0, 30) ?? ''
        result.inputs.push(`ph="${ph}" val="${val}"`)
      }
      const edits = document.querySelectorAll('[contenteditable="true"]')
      for (let i = 0; i < edits.length; i++) {
        const el = edits[i]!
        if (!vis(el)) continue
        const text = (el.textContent ?? '').slice(0, 40)
        result.editables.push(text)
      }
      result.bodySnippet = document.body.innerText.slice(0, 300)
      return result
    })
    console.log('  按钮:', editorState.buttons.join(' | '))
    console.log('  输入框:', editorState.inputs.join(' | '))
    console.log('  编辑区:', editorState.editables.join(' | '))

    // ── Step 8: 定位发布按钮 ──
    console.log('[8/8] 定位发布按钮...')
    const publishTexts = ['发布', '发表', '发 布', '立即投稿']
    for (const text of publishTexts) {
      const btn = page.getByRole('button', { name: text, exact: true })
      const count = await btn.count()
      if (count > 0) {
        const visible = await btn.first().isVisible().catch(() => false)
        const disabled = await btn.first().isDisabled().catch(() => false)
        console.log(`  ✅ "${text}": visible=${visible} disabled=${disabled}`)
        if (visible && !disabled) {
          console.log(`  🎯 可用发布按钮: "${text}"`)
        }
      }
    }

    console.log('\n=== 诊断完成（未点击发布） ===')
    console.log('页面保持打开，请手动检查。按 Enter 退出...')
    await new Promise<void>((resolve) => {
      process.stdin.once('data', () => resolve())
    })
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('诊断失败:', err)
  process.exit(1)
})
