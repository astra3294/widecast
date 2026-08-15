// 重发 + 全程观察:提交发布任务,轮询状态,同时快照页面状态留证
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'

const HOST = 'http://127.0.0.1:3080'
const payload = JSON.parse(readFileSync('E:/自媒体/article-payload.json', 'utf8'))
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const log = (m) => appendFileSync('E:/自媒体/publish-observe.log', `${new Date().toISOString()} ${m}\n`)

async function rpc(endpoint, body) {
  const res = await fetch(`${HOST}/widecast/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

const start = await rpc('publish.start', {
  type: 'client-request', rpcId: 'ro-start', method: 'publish.start',
  payload: { platform: 'douyin', input: payload },
})
log(`publish.start: ${JSON.stringify(start.result?.value)}`)
const value = start.result?.value
if (!value?.ok || !value?.task) { console.log('提交失败'); process.exit(1) }
const taskId = value.task.id
const deadline = Date.now() + 4 * 60 * 1000
let lastState = null
while (Date.now() < deadline) {
  await sleep(8000)
  const st = await rpc('publish.status', {
    type: 'client-request', rpcId: 'ro-st', method: 'publish.status', payload: { taskId },
  })
  const task = st.result?.value?.task
  log(`status: ${task ? `${task.status}/${task.step} ${task.message ?? ''}` : 'unknown'}`)
  try {
    const dbg = await rpc('debug.page', {
      type: 'client-request', rpcId: 'ro-dbg', method: 'debug.page', payload: { platform: 'douyin' },
    })
    const page = dbg.result?.value?.page
    if (page) {
      lastState = {
        url: page.url,
        buttons: page.buttons,
        dialogs: page.dialogs,
        bodyText: (page.bodyText ?? '').slice(0, 400),
      }
      log(`page: ${page.url} | dialogs: ${(page.dialogs ?? []).map(d => d.slice(0, 80)).join(' || ')}`)
    }
  } catch { /* ignore */ }
  if (task && (task.status === 'done' || task.status === 'failed')) {
    writeFileSync('E:/自媒体/retry-result.json', JSON.stringify({ task, lastState }, null, 2))
    console.log('结果已落盘:', task.status, task.step, task.message)
    process.exit(0)
  }
}
writeFileSync('E:/自媒体/retry-result.json', JSON.stringify({ timeout: true, lastState }, null, 2))
console.log('轮询超时')
