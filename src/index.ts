/**
 * widecast 宿主半边：引擎 + 模型工具 + 面板 RPC。
 *
 * 约定：
 *  - 零 `@deepseek-ai/*` 导入：linked 包的模块解析回退不到 dsh 内部 node_modules，
 *    所有服务经 ctx 注入并做结构类型约束。
 *  - 面板通信走 `ctx.connection.rpc.handle`（loopback 权限），客户端经
 *    `ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload)` 调用。
 *  - 模型工具以编译后的 JSON Schema 直接注册（等价 defineTool 产物）。
 *  - 账号凭证本体存于各平台浏览器档案（~/.widecast/browser-profiles/<platform>），
 *    本服务只落盘账号元数据；凭证永不进工具返回体。
 */
import { RPC_CHANNEL, WIDECAST_VERSION } from './constants.js'
import { PLATFORMS } from './platforms.js'
import { WidecastClient } from './client.js'

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

const PLATFORM_IDS = PLATFORMS.map((platform) => platform.id)

export function apply(ctx: HostContext): void {
  // 通过环境变量或默认端口连接 Widecast 服务
  const widecastPort = process.env.WIDECAST_PORT ?? '18080'
  const widecastHost = process.env.WIDECAST_HOST ?? '127.0.0.1'
  const client = new WidecastClient(`http://${widecastHost}:${widecastPort}`)

  // ---- 面板 RPC（loopback）----
  ctx.effect(
    () =>
      ctx.connection.rpc.handle(
        RPC_CHANNEL,
        async (endpoint, rawPayload, signal) => {
          try {
            const payload = payloadRecord(rawPayload)
            const result = await client.call(endpoint, payload)
            return { ok: true, value: result }
          } catch (error) {
            return { ok: false, error: { code: 'internal', message: String(error), details: {} } }
          }
        },
        { authority: 'loopback' },
      ),
    'widecast: loopback rpc',
  )

  // 插件卸载时关闭所有浏览器档案
  ctx.effect(() => () => {
    // 客户端模式下不需要关闭浏览器，服务端会处理
  }, 'widecast: dispose')

  // ---- 模型工具 ----
  const renderJson = (_args: unknown, value: unknown): Array<{ type: 'text'; text: string }> => [{ type: 'text', text: JSON.stringify(value, null, 2) }]

  ctx.tools.register({
    name: 'widecast_ping',
    description:
      '检查 widecast 自媒体管理插件的宿主是否在线，返回版本与连通状态。可用于确认插件已正确加载。',
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
      return client.ping()
    },
  })

  ctx.tools.register({
    name: 'widecast_list_platforms',
    description:
      '列出 widecast 支持的自媒体平台（id/名称/能力/发布页）。只有标记了 video/imageText 能力的平台才支持发布。',
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
                capabilities: { type: 'array', items: { type: 'string' } },
                publishUrl: { type: 'string' },
              },
              required: ['id', 'name', 'capabilities'],
            },
          },
        },
        required: ['platforms'],
      },
      render: renderJson,
    },
    async execute() {
      return client.listPlatforms()
    },
  })

  ctx.tools.register({
    name: 'widecast_list_accounts',
    description:
      '列出已登录的自媒体平台账号及会话状态（ok=正常、expired=需重新登录、unknown=未检查）。凭证永不返回。',
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
                lastCheckedAt: { type: 'number' },
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
      return client.listAccounts()
    },
  })

  ctx.tools.register({
    name: 'widecast_add_account',
    description:
      '为某平台添加账号：打开真实浏览器登录页并等待真人完成登录（扫码/验证码），成功后保存会话。等待最长 3 分钟；超时返回 needsHuman=true，可让用户完成后重试。platform 取 widecast_list_platforms 返回的 id。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: {
          type: 'string',
          description: '平台 id，如 xiaohongshu / bilibili / douyin',
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
    async execute(args) {
      return client.call('accounts.add', { platform: String(args.platform), waitMs: 180_000 })
    },
  })

  ctx.tools.register({
    name: 'widecast_remove_account',
    description: '移除某平台的账号记录（登出并关闭其浏览器档案）。',
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
      return client.call('accounts.remove', { platform: String(args.platform) })
    },
  })

  ctx.tools.register({
    name: 'widecast_check_account',
    description:
      '检查指定平台的账号登录状态。返回是否已登录、是否需要重新登录。在发布前调用此工具可以提前发现账号失效问题。',
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
          loggedIn: { type: 'boolean' },
          platform: { type: 'string' },
          message: { type: 'string' },
        },
        required: ['ok', 'loggedIn', 'platform', 'message'],
      },
      render: renderJson,
    },
    async execute(args) {
      return client.checkAccount(String(args.platform))
    },
  })

  ctx.tools.register({
    name: 'widecast_publish',
    description:
      '发布一篇内容（视频或图文）到指定平台。浏览器模式：在真人登录过的真实浏览器里自动完成上传与发布，提交后返回任务 id，用 widecast_get_task_status 查询进度。videoPath/imagePaths 必须是本机绝对路径。支持幂等防重复：相同内容不会重复发布。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        platform: { type: 'string', description: '平台 id', enum: PLATFORM_IDS },
        title: { type: 'string', description: '标题' },
        description: { type: 'string', description: '简介/正文（可选）' },
        videoPath: { type: 'string', description: '视频文件绝对路径（可选）' },
        coverPath: { type: 'string', description: '封面图绝对路径（可选）' },
        imagePaths: { type: 'array', items: { type: 'string' }, description: '图片绝对路径列表（图文用）' },
        tags: { type: 'array', items: { type: 'string' }, description: '话题/标签（可选）' },
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
          isDuplicate: { type: 'boolean' },
          task: {
            type: 'object',
            additionalProperties: false,
            properties: {
              id: { type: 'string' },
              platform: { type: 'string' },
              status: { type: 'string' },
              step: { type: 'string' },
              message: { type: 'string' },
              receipt: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  platformPublicationId: { type: 'string' },
                  url: { type: 'string' },
                  proofLevel: { type: 'string' },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
              },
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
      const accountId = typeof args.accountId === 'string' ? args.accountId : undefined
      return client.startPublish(String(args.platform), input, accountId)
    },
  })

  ctx.tools.register({
    name: 'widecast_get_task_status',
    description: '查询发布任务的进度（排队中/上传中/发布中/验证中/完成/失败及原因）。taskId 来自 widecast_publish。',
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
              status: { type: 'string' },
              step: { type: 'string' },
              message: { type: 'string' },
              receipt: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  platformPublicationId: { type: 'string' },
                  url: { type: 'string' },
                  proofLevel: { type: 'string' },
                  evidence: { type: 'array', items: { type: 'string' } },
                },
              },
              retryCount: { type: 'number' },
              createdAt: { type: 'number' },
              updatedAt: { type: 'number' },
            },
            required: ['id', 'platform', 'status'],
          },
        },
        required: ['task'],
      },
      render: renderJson,
    },
    async execute(args) {
      return client.getTaskStatus(String(args.taskId))
    },
  })
}

export default { name, inject, apply }
