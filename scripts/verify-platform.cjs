/**
 * 平台侧验证编排:延迟重启 Harness → 等宿主上线 → 用 debug.page 打开抖音内容管理页,
 * 检查作品列表是否出现我们的标题 → 结果落盘 platform-check.json。
 * 用法:node verify-platform.cjs <targetPid>
 */
const { exec, spawn } = require('child_process')
const fs = require('fs')

const targetPid = process.argv[2]
const HOST = 'http://127.0.0.1:3080'
const TITLE_KEY = '自媒体矩阵,我交给 AI 管了'.slice(0, 10)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (msg) => fs.appendFileSync('E:/自媒体/publish-log.txt', `${new Date().toISOString()} ${msg}\n`)

async function rpc(endpoint, body) {
  const res = await fetch(`${HOST}/widecast/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

async function waitHost(deadline) {
  while (Date.now() < deadline) {
    try {
      await rpc('ping', { type: 'client-request', rpcId: 'vp-ping', method: 'ping', payload: {} })
      return true
    } catch { await sleep(3000) }
  }
  return false
}

async function main() {
  log('平台验证编排启动,30 秒后重启…')
  await sleep(30000)
  exec(`taskkill /PID ${targetPid} /T /F`, () => {})
  await sleep(4000)
  const p = spawn('dsh.cmd', ['--profile', 'web'], { detached: true, stdio: 'ignore', shell: true, windowsHide: true, env: process.env })
  p.unref()
  log('重启已触发,等待宿主…')
  if (!(await waitHost(Date.now() + 120000))) { log('宿主未上线'); return }
  log('宿主上线,打开抖音内容管理页')
  const result = await rpc('debug.page', {
    type: 'client-request', rpcId: 'vp-debug', method: 'debug.page',
    payload: { platform: 'douyin', url: 'https://creator.douyin.com/creator-micro/content/manage' },
  })
  const page = result.result?.value?.page
  const bodyText = page?.bodyText ?? ''
  const found = bodyText.includes(TITLE_KEY)
  fs.writeFileSync('E:/自媒体/platform-check.json', JSON.stringify({
    found,
    titleKey: TITLE_KEY,
    url: page?.url ?? null,
    buttons: page?.buttons ?? [],
    dialogs: page?.dialogs ?? [],
    bodyText: bodyText.slice(0, 600),
  }, null, 2))
  log(found ? '平台侧:作品已出现在内容管理列表' : '平台侧:未在内容管理列表找到该作品')
}

main().catch((error) => log(`验证编排错误: ${String(error)}`))
