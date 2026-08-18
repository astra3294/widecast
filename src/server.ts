/**
 * Widecast 独立服务：HTTP/RPC 服务器。
 * 
 * 作为独立进程运行，DSH 通过 HTTP 调用。
 * 优势：
 * - 代码修改后只需重启 Widecast 服务，不影响 DSH
 * - 支持热重载
 * - 独立进程，更稳定
 */
import { timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WIDECAST_VERSION, RPC_CHANNEL } from './constants.js'
import { getOrCreateServerToken } from './auth.js'
import { PLATFORMS } from './platforms.js'
import { PublishService } from './publish.js'
import { WidecastService } from './service.js'
import { TaskStore } from './tasks.js'

const PORT = parseInt(process.env.WIDECAST_PORT ?? '18080', 10)
const HOST = process.env.WIDECAST_HOST ?? '127.0.0.1'
const MAX_REQUEST_BYTES = 1_000_000

function baseDir(): string {
  const override = process.env.WIDECAST_HOME
  return override !== undefined && override !== '' ? override : join(homedir(), '.widecast')
}

function removeUndefined(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj
  if (Array.isArray(obj)) return obj.map(removeUndefined)
  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (value !== undefined) {
        result[key] = removeUndefined(value)
      }
    }
    return result
  }
  return obj
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  service: WidecastService,
  publishService: PublishService,
  tasks: TaskStore,
  authToken: string,
): Promise<void> {
  // CORS 头
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(204)
    res.end()
    return
  }

  if (!hasValidToken(req, authToken)) {
    res.writeHead(401, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }))
    return
  }

  if (req.method !== 'POST') {
    res.writeHead(405, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: 'Method not allowed' }))
    return
  }

  let body = ''
  for await (const chunk of req) {
    body += chunk
    if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Request body too large' }))
      return
    }
  }

  try {
    const { endpoint, payload } = JSON.parse(body) as { endpoint: string; payload?: Record<string, unknown> }
    const result = await handleEndpoint(endpoint, payload ?? {}, service, publishService, tasks)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(removeUndefined(result)))
  } catch (error) {
    res.writeHead(400, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: false, error: String(error) }))
  }
}

async function handleEndpoint(
  endpoint: string,
  payload: Record<string, unknown>,
  service: WidecastService,
  publishService: PublishService,
  tasks: TaskStore,
): Promise<unknown> {
  switch (endpoint) {
    case 'ping':
      return { ok: true, version: WIDECAST_VERSION, message: 'widecast 运行正常' }
    case 'hello':
      return {
        ok: true,
        value: {
          greeting: 'widecast 已连接',
          version: WIDECAST_VERSION,
          platforms: PLATFORMS.length,
          accounts: service.listAccounts().length,
        },
      }
    case 'platforms.list':
      return {
        ok: true,
        value: {
          platforms: PLATFORMS.map((p) => ({
            id: p.id,
            name: p.name,
            capabilities: p.capabilities,
            publishUrl: p.publishUrl,
          })),
        },
      }
    case 'accounts.list':
      return { ok: true, value: { accounts: service.listAccounts() } }
    case 'accounts.add': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      const requestedWaitMs = typeof payload.waitMs === 'number' ? payload.waitMs : 0
      const waitMs = Math.min(Math.max(requestedWaitMs, 0), 300_000)
      return { ok: true, value: await service.addAccount(platform, { waitMs }) }
    }
    case 'accounts.check': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      if (platform !== '') return { ok: true, value: await service.checkPlatform(platform) }
      return { ok: true, value: { accounts: await service.checkAllAccounts() } }
    }
    case 'accounts.remove': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      return { ok: true, value: service.removeAccount(platform) }
    }
    case 'accounts.logout': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      return { ok: true, value: await service.logoutAccount(platform) }
    }
    case 'publish.check': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      return { ok: true, value: await publishService.prePublishCheck(platform) }
    }
    case 'publish.list': {
      const platform = typeof payload.platform === 'string' ? payload.platform : undefined
      const limit = typeof payload.limit === 'number' ? payload.limit : undefined
      return { ok: true, value: { tasks: publishService.listTasks({ platform, limit }) } }
    }
    case 'publish.start': {
      const platform = typeof payload.platform === 'string' ? payload.platform : ''
      const input = (typeof payload.input === 'object' && payload.input !== null && !Array.isArray(payload.input))
        ? payload.input as Record<string, unknown>
        : {}
      const normalized = {
        title: typeof input.title === 'string' ? input.title : '',
        ...(typeof input.description === 'string' ? { description: input.description } : {}),
        ...(typeof input.videoPath === 'string' ? { videoPath: input.videoPath } : {}),
        ...(typeof input.coverPath === 'string' ? { coverPath: input.coverPath } : {}),
        ...(Array.isArray(input.imagePaths) ? { imagePaths: input.imagePaths.filter((x): x is string => typeof x === 'string') } : {}),
        ...(Array.isArray(input.tags) ? { tags: input.tags.filter((x): x is string => typeof x === 'string') } : {}),
      }
      const accountId = typeof payload.accountId === 'string' ? payload.accountId : undefined
      return { ok: true, value: publishService.start(platform, normalized, { accountId }) }
    }
    case 'publish.status': {
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
      return { ok: true, value: { task: publishService.getTask(taskId) } }
    }
    case 'publish.retry': {
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
      const confirmedNoPublication = payload.confirmedNoPublication === true
      const reason = typeof payload.reason === 'string' ? payload.reason : undefined
      return { ok: true, value: publishService.retry(taskId, { confirmedNoPublication, reason }) }
    }
    case 'publish.cancel': {
      const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
      return { ok: true, value: publishService.cancel(taskId) }
    }
    case 'publish.stats':
      return { ok: true, value: tasks.stats() }
    default:
      return { ok: false, error: `unknown endpoint: ${endpoint}` }
  }
}

async function main(): Promise<void> {
  const dataDirectory = baseDir()
  const authToken = getOrCreateServerToken(dataDirectory)
  const service = new WidecastService(dataDirectory)
  const tasks = new TaskStore(dataDirectory)
  const publishService = new PublishService(service.browser, tasks)

  const server = createServer((req, res) => {
    void handleRequest(req, res, service, publishService, tasks, authToken)
  })

  server.listen(PORT, HOST, () => {
    console.log(`Widecast 服务已启动: http://${HOST}:${PORT}`)
    console.log(`版本: ${WIDECAST_VERSION}`)
    console.log(`平台数: ${PLATFORMS.length}`)
    console.log(`账号数: ${service.listAccounts().length}`)
  })

  // 优雅关闭
  process.on('SIGINT', () => {
    console.log('\n正在关闭 Widecast 服务...')
    void service.dispose()
    server.close(() => {
      console.log('Widecast 服务已关闭')
      process.exit(0)
    })
  })
}

main().catch((err) => {
  console.error('Widecast 服务启动失败:', err)
  process.exit(1)
})

function hasValidToken(req: IncomingMessage, expected: string): boolean {
  const header = req.headers['x-widecast-token']
  const provided = Array.isArray(header) ? header[0] : header
  if (provided === undefined) return false
  const actualBuffer = Buffer.from(provided)
  const expectedBuffer = Buffer.from(expected)
  return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
}
