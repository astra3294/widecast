/**
 * 抖音发布页 DOM 诊断脚本。
 * 用法: npx tsx scripts/diagnose-douyin.ts
 *
 * 诊断内容:
 * 1. 登录态检测（反证探针）
 * 2. 视频上传 input 选择器
 * 3. 标题输入框选择器
 * 4. 描述编辑区选择器
 * 5. 发布按钮定位
 * 6. 页面整体结构快照
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'douyin')
const PUBLISH_URL = 'https://creator.douyin.com/creator-micro/content/upload'
const MANAGE_URL = 'https://creator.douyin.com/creator-micro/content/manage'

async function main(): Promise<void> {
  console.log('=== 抖音发布页 DOM 诊断 ===')
  console.log(`档案目录: ${PROFILE_DIR}`)
  console.log(`发布页: ${PUBLISH_URL}`)
  console.log()

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
  })

  try {
    const page = await context.newPage()

    // 1) 打开发布页
    console.log('[1] 打开发布页...')
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)

    // 2) 登录态检测
    console.log('\n[2] 登录态检测:')
    const url = page.url()
    console.log(`  URL: ${url}`)

    // 反证探针
    const blockedSelectors = ['input[placeholder="请输入手机号"]', '#normal-input']
    for (const sel of blockedSelectors) {
      const found = await page.$(sel).catch(() => null)
      console.log(`  反证 "${sel}": ${found !== null ? '❌ 找到（未登录）' : '✅ 未找到'}`)
    }

    // 文本反证
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 2000)).catch(() => '')
    const outMarkers = ['扫码登录', '我是创作者']
    for (const marker of outMarkers) {
      console.log(`  文本反证 "${marker}": ${bodyText.includes(marker) ? '❌ 找到（未登录）' : '✅ 未找到'}`)
    }

    // 文本正证
    const inMarkers = ['内容管理']
    for (const marker of inMarkers) {
      console.log(`  文本正证 "${marker}": ${bodyText.includes(marker) ? '✅ 找到（已登录）' : '❌ 未找到'}`)
    }

    // 3) 上传区域
    console.log('\n[3] 视频上传 input:')
    const videoSelectors = [
      '#joyride-wrapper input[type="file"]',
      'input[type="file"][accept*="video"]',
      'input[type="file"]',
    ]
    for (const sel of videoSelectors) {
      const count = await page.locator(sel).count()
      console.log(`  "${sel}": ${count} 个`)
      if (count > 0) {
        const el = page.locator(sel).first()
        const accept = await el.getAttribute('accept').catch(() => null)
        const multiple = await el.getAttribute('multiple').catch(() => null)
        console.log(`    accept="${accept}" multiple="${multiple}"`)
      }
    }

    // 4) 标题输入框
    console.log('\n[4] 标题输入框:')
    const titleSelectors = [
      'input[placeholder="填写作品标题，为作品获得更多流量"]',
      'input[placeholder*="标题"]',
      'input[placeholder*="title"]',
    ]
    for (const sel of titleSelectors) {
      const count = await page.locator(sel).count()
      const visible = count > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false
      console.log(`  "${sel}": count=${count} visible=${visible}`)
    }

    // 5) 描述编辑区
    console.log('\n[5] 描述编辑区:')
    const descSelectors = [
      '.zone-container.editor-kit-container.editor',
      '[contenteditable="true"]',
      '.editor',
      'textarea',
    ]
    for (const sel of descSelectors) {
      const count = await page.locator(sel).count()
      const visible = count > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false
      console.log(`  "${sel}": count=${count} visible=${visible}`)
      if (count > 0) {
        const ph = await page.locator(sel).first().getAttribute('placeholder').catch(() => null)
        const cls = await page.locator(sel).first().getAttribute('class').catch(() => null)
        if (ph) console.log(`    placeholder="${ph}"`)
        if (cls) console.log(`    class="${cls.slice(0, 80)}"`)
      }
    }

    // 6) 发布按钮
    console.log('\n[6] 发布按钮:')
    const buttonTexts = ['发布', '发表', '发 布', '立即投稿']
    for (const text of buttonTexts) {
      const btn = page.getByRole('button', { name: text, exact: true })
      const count = await btn.count()
      const visible = count > 0 ? await btn.first().isVisible().catch(() => false) : false
      const disabled = count > 0 ? await btn.first().isDisabled().catch(() => false) : false
      console.log(`  "${text}": count=${count} visible=${visible} disabled=${disabled}`)
    }

    // 7) 所有可见按钮
    console.log('\n[7] 所有可见按钮（前 30 个）:')
    const allButtons = await page.evaluate(() => {
      const vis = (el: Element): boolean => {
        const rect = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
      }
      const result: Array<{ text: string; disabled: boolean; cls: string }> = []
      const btns = document.querySelectorAll('button, [role="button"]')
      for (let i = 0; i < btns.length; i++) {
        const el = btns[i]!
        if (!vis(el)) continue
        const text = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40)
        if (text === '') continue
        result.push({
          text,
          disabled: (el as HTMLButtonElement).disabled === true,
          cls: String(el.className ?? '').slice(0, 60),
        })
        if (result.length >= 30) break
      }
      return result
    })
    for (const btn of allButtons) {
      console.log(`  "${btn.text}" disabled=${btn.disabled} cls="${btn.cls}"`)
    }

    // 8) 页面 bodyText 前 500 字
    console.log('\n[8] 页面文本（前 500 字）:')
    const shortText = bodyText.slice(0, 500)
    console.log(`  ${shortText.replace(/\n/g, '\n  ')}`)

    // 9) 内容管理页诊断
    console.log('\n[9] 内容管理页诊断:')
    await page.goto(MANAGE_URL, { waitUntil: 'domcontentloaded', timeout: 45_000 }).catch(() => {})
    await page.waitForTimeout(5000)
    const manageUrl = page.url()
    console.log(`  URL: ${manageUrl}`)
    const manageText = await page.evaluate(() => document.body.innerText.slice(0, 300)).catch(() => '')
    console.log(`  文本: ${manageText.slice(0, 200).replace(/\n/g, ' ')}`)

    console.log('\n=== 诊断完成 ===')
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('诊断失败:', err)
  process.exit(1)
})
