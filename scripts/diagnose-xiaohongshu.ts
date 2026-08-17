/**
 * 小红书发布页 DOM 诊断脚本。
 * 用法: npx tsx scripts/diagnose-xiaohongshu.ts
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PROFILE_DIR = join(homedir(), '.widecast', 'browser-profiles', 'xiaohongshu')
const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish'

async function main(): Promise<void> {
  console.log('=== 小红书发布页 DOM 诊断 ===')
  console.log(`档案目录: ${PROFILE_DIR}`)
  console.log(`发布页: ${PUBLISH_URL}`)
  console.log()

  const context = await chromium.launchPersistentContext(PROFILE_DIR, {
    headless: false,
    viewport: { width: 1280, height: 860 },
    locale: 'zh-CN',
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  })

  try {
    const page = await context.newPage()

    // 1) 打开发布页
    console.log('[1] 打开发布页...')
    await page.goto(PUBLISH_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
    await page.waitForTimeout(3000)
    console.log(`  URL: ${page.url()}`)

    // 2) 登录态检测
    console.log('\n[2] 登录态检测:')
    const bodyText = await page.evaluate(() => document.body.innerText.slice(0, 1000)).catch(() => '')
    const loggedIn = page.url().includes('creator.xiaohongshu.com/new') || page.url().includes('creator.xiaohongshu.com/publish')
    const loginPage = page.url().includes('login')
    console.log(`  URL 指示: ${loggedIn ? '✅ 已登录' : loginPage ? '❌ 登录页' : '⚠️ 未知'}`)
    console.log(`  文本前100字: ${bodyText.slice(0, 100).replace(/\n/g, ' ')}`)

    // 3) 图片/视频上传 input
    console.log('\n[3] 上传 input:')
    const inputSelectors = [
      'input[type="file"][accept*="image"]',
      'input[type="file"][accept*="video"]',
      'input[type="file"]',
    ]
    for (const sel of inputSelectors) {
      const count = await page.locator(sel).count()
      if (count > 0) {
        const accept = await page.locator(sel).first().getAttribute('accept').catch(() => null)
        const multiple = await page.locator(sel).first().getAttribute('multiple').catch(() => null)
        console.log(`  "${sel}": ${count} 个, accept="${accept}", multiple="${multiple}"`)
      }
    }

    // 4) 标题输入框
    console.log('\n[4] 标题输入框:')
    const titleSelectors = [
      'input[placeholder*="标题"]',
      'input[placeholder*="title"]',
      'input[name="title"]',
      '#title',
    ]
    for (const sel of titleSelectors) {
      const count = await page.locator(sel).count()
      const visible = count > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false
      if (count > 0) {
        const ph = await page.locator(sel).first().getAttribute('placeholder').catch(() => null)
        console.log(`  "${sel}": count=${count} visible=${visible} ph="${ph}"`)
      }
    }

    // 5) 描述编辑区
    console.log('\n[5] 描述编辑区:')
    const descSelectors = [
      '[contenteditable="true"]',
      'textarea',
      '.ql-editor',
      '.ProseMirror',
    ]
    for (const sel of descSelectors) {
      const count = await page.locator(sel).count()
      const visible = count > 0 ? await page.locator(sel).first().isVisible().catch(() => false) : false
      if (count > 0) {
        const ph = await page.locator(sel).first().getAttribute('placeholder').catch(() => null)
        const cls = await page.locator(sel).first().getAttribute('class').catch(() => null)
        console.log(`  "${sel}": count=${count} visible=${visible} ph="${ph}" cls="${(cls ?? '').slice(0, 60)}"`)
      }
    }

    // 6) 发布按钮
    console.log('\n[6] 发布按钮:')
    const buttonTexts = ['发布', '发布笔记', '发布视频', '发表']
    for (const text of buttonTexts) {
      const btn = page.getByRole('button', { name: text, exact: true })
      const count = await btn.count()
      if (count > 0) {
        const visible = await btn.first().isVisible().catch(() => false)
        const disabled = await btn.first().isDisabled().catch(() => false)
        console.log(`  "${text}": count=${count} visible=${visible} disabled=${disabled}`)
      }
    }

    // 7) 所有可见按钮
    console.log('\n[7] 所有可见按钮（前20个）:')
    try {
      const cdp = await context.newCDPSession(page)
      const result = await cdp.send('Runtime.evaluate', {
        expression: `(() => {
          const btns = document.querySelectorAll('button, [role="button"]');
          const r = [];
          for (let i = 0; i < btns.length && r.length < 20; i++) {
            const el = btns[i];
            const rect = el.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              const text = (el.textContent || '').trim().replace(/\\s+/g, ' ').slice(0, 40);
              if (text) r.push(text);
            }
          }
          return JSON.stringify(r);
        })()`,
        returnByValue: true,
      })
      const buttons = JSON.parse(result.result.value) as string[]
      for (const btn of buttons) {
        console.log(`  "${btn}"`)
      }
      await cdp.detach()
    } catch (e) {
      console.log(`  CDP 失败: ${String(e).slice(0, 100)}`)
    }

    // 8) 页面文本
    console.log('\n[8] 页面文本（前300字）:')
    console.log(`  ${bodyText.slice(0, 300).replace(/\n/g, '\n  ')}`)

    console.log('\n=== 诊断完成 ===')
    console.log('页面保持打开，等待 10 秒后自动关闭...')
    await page.waitForTimeout(10000)
  } finally {
    await context.close()
  }
}

main().catch((err) => {
  console.error('诊断失败:', err)
  process.exit(1)
})
