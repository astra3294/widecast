/**
 * widecast 宿主半边:引擎 + 模型工具 + 面板 RPC。
 *
 * 约定(参照本机已验证的 dsh-doctor 模式):
 *  - 零 `@deepseek-ai/*` 导入:linked 包的模块解析回退不到 dsh 内部 node_modules,
 *    所有服务经 ctx 注入并做结构类型约束。
 *  - 面板通信走 `ctx.connection.rpc.handle`(loopback 权限),客户端经
 *    `ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload)` 调用。
 *  - 模型工具以编译后的 JSON Schema 直接注册(等价 defineTool 产物)。
 *  - 账号凭证本体存于各平台浏览器档案(~/.widecast/browser-profiles/<platform>),
 *    本服务只落盘账号元数据;凭证永不进工具返回体。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { RPC_CHANNEL, WIDECAST_VERSION } from './constants.js'
import { PLATFORMS } from './platforms.js'
import { PublishService } from './publish.js'
import { WidecastService } from './service.js'
import { TaskStore } from './tasks.js'

export const name = 'widecast'
export const inject = ['connection', 'tools']

interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string; details?: Record<string, unknown> }
}

interface ConnectionRpc {
  handle(
    channel: string,
    handler: (endpoint: string, payload: unknown, signal: AbortSignal) => Promise<RpcResult<unknown>>,
    options: { authority: 'loopback' | 'trusted-host' },
  ): () => Promise<void>
}

interface ToolRegistry {
  register(definition: ToolDefinition): () => void
}

/** 工具定义最小形态(与 defineTool 产物一致;schema 为 DSH 强制子集)。 */
interface ToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: {
    schema: Record<string, unknown>
    render(args: unknown, value: unknown): Array<{ type: 'text'; text: string }>
  }
  timeoutMs?: number
  execute(args: Record<string, unknown>, exec: { signal: AbortSignal }): Promise<unknown> | unknown
}

interface HostContext {
  connection: { rpc: ConnectionRpc }
  tools: ToolRegistry
  effect(callback: () => unknown, label?: string): unknown
}

function payloadRecord(payload: unknown): Record<string, unknown> {
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('payload must be an object')
  }
  return payload as Record<string, unknown>
}

function baseDir(): string {
  const override = process.env.WIDECAST_HOME
  return override !== undefined && override !== '' ? override : join(homedir(), '.widecast')
}

const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id)

export function apply(ctx: HostContext): void {
  const service = new WidecastService(baseDir())
  const tasks = new TaskStore(baseDir())
  const publishService = new PublishService(service.browser, tasks)

  // ---- 面板 RPC(loopback)----
  ctx.effect(
    () =>
      ctx.connection.rpc.handle(
        RPC_CHANNEL,
        async (endpoint, rawPayload, signal) => {
          try {
            const payload = payloadRecord(rawPayload)
            switch (endpoint) {
              case 'ping':
                return { ok: true, value: { pong: true, time: Date.now(), version: WIDECAST_VERSION } }
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
                return { ok: true, value: { platforms: service.listPlatforms() } }
              case 'accounts.list':
                return { ok: true, value: { accounts: service.listAccounts() } }
              case 'accounts.add': {
                const platform = typeof payload.platform === 'string' ? payload.platform : ''
                const waitMs = typeof payload.waitMs === 'number' ? payload.waitMs : 0
                return { ok: true, value: await service.addAccount(platform, { waitMs, signal }) }
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
              case 'work.delete': {
                const platform = typeof payload.platform === 'string' ? payload.platform : ''
                const titleKey = typeof payload.titleKey === 'string' ? payload.titleKey : ''
                return { ok: true, value: await service.deleteWork(platform, titleKey) }
              }
              case 'publish.list':
                return { ok: true, value: { tasks: publishService.listTasks() } }
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
                return { ok: true, value: publishService.start(platform, normalized) }
              }
              case 'publish.status': {
                const taskId = typeof payload.taskId === 'string' ? payload.taskId : ''
                return { ok: true, value: { task: publishService.getTask(taskId) } }
              }
              case 'debug.page': {
                const platform = typeof payload.platform === 'string' ? payload.platform : ''
                const url = typeof payload.url === 'string' && payload.url !== '' ? payload.url : undefined
                if (platform === '') return { ok: false, error: { code: 'bad-request', message: 'platform 必填', details: { issues: [] } } }
                const context = await service.browser.contextFor(platform)
                const page = url !== undefined
                  ? await service.browser.openPage(platform, url)
                  : context.pages()[context.pages().length - 1]
                if (page === undefined) return { ok: true, value: { page: null, message: '无页面' } }
                await page.waitForLoadState('domcontentloaded', { timeout: 20_000 }).catch(() => {})
                await new Promise((resolve) => setTimeout(resolve, 1500))
                const state = await page.evaluate(() => {
                  const visible = (el: Element): boolean => {
                    const rect = el.getBoundingClientRect()
                    const style = getComputedStyle(el)
                    return rect.width > 0 && rect.height > 0 && style.display !== 'none' && style.visibility !== 'hidden'
                  }
                  const buttons = [...document.querySelectorAll('button, [role="button"]')]
                    .filter(visible)
                    .map((el) => ({
                      tx: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 30),
                      dis: (el as HTMLButtonElement).disabled === true,
                    }))
                    .filter((button) => button.tx !== '')
                  const dialogs = [...document.querySelectorAll('[role="dialog"], .semi-modal, .semi-portal')]
                    .filter(visible)
                    .map((el) => (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 300))
                    .filter(Boolean)
                  const inputs = [...document.querySelectorAll('input, textarea, [contenteditable="true"]')]
                    .filter(visible)
                    .map((el) => ({
                      t: el.tagName,
                      ty: el.getAttribute('type') ?? '',
                      ph: el.getAttribute('placeholder') ?? '',
                      dis: (el as HTMLInputElement).disabled === true,
                      cls: String(el.className ?? '').slice(0, 60),
                    }))
                    .slice(0, 30)
                  const bodyText = document.body.innerText.slice(0, 800)
                  return { url: location.href, title: document.title, buttons: [...new Set(buttons.map((b) => JSON.stringify(b)))].map((s) => JSON.parse(s)).slice(0, 40), dialogs: dialogs.slice(0, 6), inputs, bodyText }
                })
                return { ok: true, value: { page: state } }
              }
              case 'debug.screenshot': {
                const platform = typeof payload.platform === 'string' ? payload.platform : ''
                if (platform === '') return { ok: false, error: { code: 'bad-request', message: 'platform 必填', details: { issues: [] } } }
                const context = await service.browser.contextFor(platform)
                const page = context.pages()[context.pages().length - 1]
                if (page === undefined) return { ok: true, value: { path: null, message: '无页面' } }
                const { mkdirSync } = await import('node:fs')
                const { join } = await import('node:path')
                const debugDir = join(baseDir(), 'debug')
                mkdirSync(debugDir, { recursive: true })
                const file = join(debugDir, `${platform}-${Date.now()}.png`)
                await page.screenshot({ path: file, type: 'png', fullPage: false })
                return { ok: true, value: { path: file } }
              }
              default:
                return {
                  ok: false,
                  error: { code: 'bad-request', message: `unknown widecast endpoint: ${endpoint}`, details: { issues: [] } },
                }
            }
          } catch (error) {
            return { ok: false, error: { code: 'internal', message: String(error), details: {} } }
          }
        },
        { authority: 'loopback' },
      ),
    'widecast: loopback rpc',
  )

  // 插件卸载时关闭所有浏览器档案
  ctx.effect(() => () => { void service.dispose() }, 'widecast: dispose browsers')

  // ---- 模型工具 ----
  const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'widecast_ping',
    description:
      '检查 widecast 自媒体管理插件的宿主是否在线,返回版本与连通状态。可用于确认插件已正确加载。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          version: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok', 'version', 'message'],
      },
      render: renderJson,
    },
    async execute() {
      return { ok: true, version: WIDECAST_VERSION, message: 'widecast 运行正常' }
    },
  })

  ctx.tools.register({
    name: 'widecast_list_platforms',
    description:
      '列出 widecast 支持的自媒体平台(id/名称/发布页)。发布与账号管理操作都使用其中的 platform id。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          platforms: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string' },
                name: { type: 'string' },
                publishUrl: { type: 'string' },
              },
              required: ['id', 'name'],
            },
          },
        },
        required: ['platforms'],
      },
      render: renderJson,
    },
    async execute() {
      return { platforms: service.listPlatforms() }
    },
  })

  ctx.tools.register({
    name: 'widecast_list_accounts',
    description:
      '列出已登录的自媒体平台账号及会话状态(ok=正常、expired=需重新登录、unknown=未检查)。凭证永不返回。',
    parameters: { type: 'object', additionalProperties: false, properties: {} },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          accounts: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                platform: { type: 'string' },
                name: { type: 'string' },
                status: { type: 'string', enum: ['ok', 'expired', 'unknown'] },
                addedAt: { type: 'number' },
                lastError: { type: 'string' },
              },
              required: ['platform', 'name', 'status'],
            },
          },
        },
        required: ['accounts'],
      },
      render: renderJson,
    },
    async execute() {
      return { accounts: service.listAccounts() }
    },
  })

  ctx.tools.register({
    name: 'widecast_add_account',
    description:
      '为某平台添加账号:打开真实浏览器登录页并等待真人完成登录(扫码/验证码),成功后保存会话。等待最长 3 分钟;超时返回 needsHuman=true,可让用户完成后重试。platform 取 widecast_list_platforms 返回的 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: {
          type: 'string',
          description: '平台 id,如 xiaohongshu / bilibili / douyin',
          enum: PLATFORM_IDS,
        },
      },
      required: ['platform'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          platform: { type: 'string' },
          status: { type: 'string', enum: ['ok', 'timeout', 'cancelled'] },
          needsHuman: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'platform', 'status', 'message'],
      },
      render: renderJson,
    },
    timeoutMs: 200_000,
    async execute(args, exec) {
      return service.addAccount(String(args.platform), { waitMs: 180_000, signal: exec.signal })
    },
  })

  ctx.tools.register({
    name: 'widecast_remove_account',
    description: '移除某平台的账号记录(登出并关闭其浏览器档案)。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: { type: 'string', description: '平台 id', enum: PLATFORM_IDS },
      },
      required: ['platform'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
        },
        required: ['ok', 'message'],
      },
      render: renderJson,
    },
    async execute(args) {
      return service.removeAccount(String(args.platform))
    },
  })

  ctx.tools.register({
    name: 'widecast_publish',
    description:
      '发布一篇内容(视频或图文)到指定平台。浏览器模式:在真人登录过的真实浏览器里自动完成上传与发布,提交后返回任务 id,用 widecast_get_task_status 查询进度。videoPath/imagePaths 必须是本机绝对路径。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: { type: 'string', description: '平台 id', enum: PLATFORM_IDS },
        title: { type: 'string', description: '标题' },
        description: { type: 'string', description: '简介/正文(可选)' },
        videoPath: { type: 'string', description: '视频文件绝对路径(可选)' },
        coverPath: { type: 'string', description: '封面图绝对路径(可选)' },
        imagePaths: { type: 'array', items: { type: 'string' }, description: '图片绝对路径列表(图文用)' },
        tags: { type: 'array', items: { type: 'string' }, description: '话题/标签(可选)' },
      },
      required: ['platform', 'title'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean' },
          message: { type: 'string' },
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              platform: { type: 'string' },
              status: { type: 'string', enum: ['queued', 'uploading', 'publishing', 'done', 'failed'] },
              step: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['id', 'platform', 'status'],
          },
        },
        required: ['ok'],
      },
      render: renderJson,
    },
    async execute(args) {
      const input: Record<string, unknown> = { title: String(args.title) }
      if (typeof args.description === 'string' && args.description !== '') input.description = args.description
      if (typeof args.videoPath === 'string' && args.videoPath !== '') input.videoPath = args.videoPath
      if (typeof args.coverPath === 'string' && args.coverPath !== '') input.coverPath = args.coverPath
      if (Array.isArray(args.imagePaths)) input.imagePaths = args.imagePaths.map(String)
      if (Array.isArray(args.tags)) input.tags = args.tags.map(String)
      return publishService.start(String(args.platform), input as never)
    },
  })

  ctx.tools.register({
    name: 'widecast_get_task_status',
    description: '查询发布任务的进度(排队中/上传中/发布中/完成/失败及原因)。taskId 来自 widecast_publish。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        taskId: { type: 'string', description: '任务 id' },
      },
      required: ['taskId'],
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              platform: { type: 'string' },
              status: { type: 'string', enum: ['queued', 'uploading', 'publishing', 'done', 'failed'] },
              step: { type: 'string' },
              message: { type: 'string' },
            },
            required: ['id', 'platform', 'status'],
          },
        },
        required: ['task'],
      },
      render: renderJson,
    },
    async execute(args) {
      return { task: publishService.getTask(String(args.taskId)) }
    },
  })
}

export default { name, inject, apply }
