/**
 * widecast 宿主半边:引擎 + 模型工具 + 面板 RPC。
 *
 * 约定(参照本机已验证的 dsh-doctor 模式):
 *  - 零 `@deepseek-ai/*` 导入:linked 包的模块解析回退不到 dsh 内部 node_modules,
 *    所有服务经 ctx 注入并做结构类型约束。
 *  - 面板通信走 `ctx.connection.rpc.handle`(loopback 权限),客户端经
 *    `ctx.connection.rpc.call(RPC_CHANNEL, endpoint, payload)` 调用。
 *  - 模型工具直接以编译后的 JSON Schema 定义注册(等价 defineTool 产物,
 *    无需引入 @deepseek-ai/dsh-tools)。
 *  - 凭证(P1 起)经 ctx.credentials 存取,永不进工具返回体。
 */
import { RPC_CHANNEL, WIDECAST_VERSION } from './constants.js'

export const name = 'widecast'
export const inject = ['connection', 'tools']

interface RpcResult<T> {
  ok: boolean
  value?: T
  error?: { code: string; message: string }
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

function statusValue() {
  return {
    ok: true,
    available: true,
    version: WIDECAST_VERSION,
    phase: 'ready',
    message: 'widecast 宿主运行正常',
  }
}

export function apply(ctx: HostContext): void {
  // ---- 面板 RPC(loopback)----
  ctx.effect(
    () =>
      ctx.connection.rpc.handle(
        RPC_CHANNEL,
        async (endpoint, rawPayload) => {
          try {
            switch (endpoint) {
              case 'ping':
                return { ok: true, value: { pong: true, time: Date.now(), version: WIDECAST_VERSION } }
              case 'status':
                return { ok: true, value: statusValue() }
              case 'hello':
                return {
                  ok: true,
                  value: {
                    greeting: 'widecast 已连接',
                    hint: '账号管理(P1)与发布队列(P2)功能开发中',
                    version: WIDECAST_VERSION,
                  },
                }
              default:
                void payloadRecord(rawPayload)
                return { ok: false, error: { code: 'unknown-endpoint', message: `unknown widecast endpoint: ${endpoint}` } }
            }
          } catch (error) {
            return { ok: false, error: { code: 'widecast-error', message: String(error) } }
          }
        },
        { authority: 'loopback' },
      ),
    'widecast: loopback rpc',
  )

  // ---- 模型工具 ----
  ctx.tools.register({
    name: 'widecast_ping',
    description:
      '检查 widecast 自媒体管理插件的宿主是否在线,返回版本与连通状态。可用于确认插件已正确加载。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
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
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute() {
      return { ok: true, version: WIDECAST_VERSION, message: 'widecast 运行正常' }
    },
  })
}

export default { name, inject, apply }
