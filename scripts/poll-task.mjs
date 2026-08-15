// 轮询任务 a79c628d-e8f4-4a80-bf18-17d332887e32 至终态,同时快照页面
import { writeFileSync, appendFileSync } from 'node:fs'

const HOST = 'http://127.0.0.1:3080'
const taskId = 'a79c628d-e8f4-4a80-bf18-17d332887e32'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function rpc(endpoint, body) {
  const res = await fetch(`${HOST}/widecast/${endpoint}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

let lastState = null
const deadline = Date.now() + 5 * 60 * 1000
while (Date.now() < deadline) {
  await sleep(8000)
  const st = await rpc('publish.status', {
    type: 'client-request', rpcId: 't-st', method: 'publish.status', payload: { taskId },
  })
  const task = st.result?.value?.task
  appendFileSync('E:/自媒体/publish-observe.log', `${new Date().toISOString()} status: ${task ? `${task.status}/${task.step} ${(task.message ?? '').slice(0, 200)}` : 'unknown'}\n`)
  try {
    const dbg = await rpc('debug.page', {
      type: 'client-request', rpcId: 't-dbg', method: 'debug.page', payload: { platform: 'douyin' },
    })
    const page = dbg.result?.value?.page
    if (page) lastState = { url: page.url, dialogs: page.dialogs, buttons: page.buttons }
  } catch { /* ignore */ }
  if (task && (task.status === 'done' || task.status === 'failed')) {
    writeFileSync('E:/自媒体/retry-result.json', JSON.stringify({ task, lastState }, null, 2))
    console.log('终态:', task.status, task.step, (task.message ?? '').slice(0, 300))
    process.exit(0)
  }
}
writeFileSync('E:/自媒体/retry-result.json', JSON.stringify({ timeout: true, lastState }, null, 2))
console.log('超时')
