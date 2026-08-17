/**
 * 用 Playwright 录屏生成一个测试视频。
 */
import { chromium } from 'playwright'
import { join } from 'node:path'
import { renameSync, statSync, mkdirSync } from 'node:fs'

async function main(): Promise<void> {
  const videoDir = join(import.meta.dirname ?? process.cwd(), 'test-fixtures')
  mkdirSync(videoDir, { recursive: true })

  const browser = await chromium.launch({ headless: true })
  const context = await browser.newContext({
    recordVideo: { dir: videoDir, size: { width: 640, height: 480 } },
  })
  const page = await context.newPage()
  await page.setContent(`
    <html>
      <body style="background:#1a1a2e;color:#e94560;display:flex;align-items:center;justify-content:center;height:100vh;font-size:48px;font-family:sans-serif">
        <div>Widecast Test Video</div>
      </body>
    </html>
  `)
  await page.waitForTimeout(3000)

  const videoPath = await page.video()?.path()
  await context.close()
  await browser.close()

  if (videoPath === undefined) {
    console.error('录屏失败')
    process.exit(1)
  }

  const targetPath = join(videoDir, 'sample.mp4')
  renameSync(videoPath, targetPath)
  const stat = statSync(targetPath)
  console.log(`已生成: ${targetPath} (${Math.round(stat.size / 1024)}KB)`)
}

main().catch((e) => { console.error(e); process.exit(1) })
