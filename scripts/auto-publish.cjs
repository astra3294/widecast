/**
 * 自动发布编排:延迟重启 Harness → 等宿主上线 → 提交抖音图文发布 → 轮询状态落盘。
 * 用法:node auto-publish.cjs <targetPid>
 */
const { exec, spawn } = require('child_process')
const fs = require('fs')

const targetPid = process.argv[2]
const HOST = 'http://127.0.0.1:3080'
const payload = JSON.parse(fs.readFileSync('E:/自媒体/article-payload.json', 'utf8'))
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const log = (msg) => {
  const line = `${new Date().toISOString()} ${msg}\n`
  fs.appendFileSync('E:/自媒体/publish-log.txt', line)
}

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
      await rpc('ping', { type: 'client-request', rpcId: 'ap-ping', method: 'ping', payload: {} })
      return true
    } catch { await sleep(3000) }
  }
  return false
}

async function main() {
  log('编排启动,30 秒后重启 Harness…')
  await sleep(30000)
  exec(`taskkill /PID ${targetPid} /T /F`, () => {})
  await sleep(4000)
  const p = spawn('dsh.cmd', ['--profile', 'web'], { detached: true, stdio: 'ignore', shell: true, windowsHide: true, env: process.env })
  p.unref()
  log('已触发重启,等待宿主上线…')
  if (!(await waitHost(Date.now() + 120000))) {
    log('宿主 2 分钟内未上线,放弃')
    return
  }
  log('宿主上线,提交发布任务')
  const start = await rpc('publish.start', {
    type: 'client-request', rpcId: 'ap-start', method: 'publish.start',
    payload: { platform: 'douyin', input: payload },
  })
  log(`publish.start: ${JSON.stringify(start)}`)
  const value = start.result && start.result.value
  if (!value || !value.ok || !value.task) {
    fs.writeFileSync('E:/自媒体/publish-result.json', JSON.stringify({ ok: false, raw: start }, null, 2))
    log('提交失败,结束')
    return
  }
  const taskId = value.task.id
  const deadline = Date.now() + 10 * 60 * 1000
  while (Date.now() < deadline) {
    await sleep(8000)
    const st = await rpc('publish.status', {
      type: 'client-request', rpcId: 'ap-st', method: 'publish.status',
      payload: { taskId },
    })
    const task = st.result && st.result.value && st.result.value.task
    log(`status: ${task ? `${task.status}/${task.step} ${task.message ?? ''}` : 'unknown'}`)
    if (task && (task.status === 'done' || task.status === 'failed')) {
      fs.writeFileSync('E:/自媒体/publish-result.json', JSON.stringify({ ok: task.status === 'done', task }, null, 2))
      log('结束')
      return
    }
  }
  fs.writeFileSync('E:/自媒体/publish-result.json', JSON.stringify({ ok: false, timeout: true }, null, 2))
  log('轮询超时,结束')
}

main().catch((error) => log(`编排错误: ${String(error)}`))
