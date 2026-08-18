/**
 * Widecast 服务客户端：通过 HTTP 调用独立的 Widecast 服务。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import { readServerToken } from './auth.js'

export class WidecastClient {
  private readonly baseUrl: string
  private readonly baseDir: string

  constructor(baseUrl: string = 'http://127.0.0.1:18080') {
    this.baseUrl = baseUrl
    this.baseDir = process.env.WIDECAST_HOME?.trim() || join(homedir(), '.widecast')
  }

  async call<T>(endpoint: string, payload?: Record<string, unknown>): Promise<T> {
    const token = readServerToken(this.baseDir)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token !== undefined) headers['X-Widecast-Token'] = token
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ endpoint, payload }),
    })

    if (!response.ok) {
      const suffix = response.status === 401 ? '（服务 token 不匹配，请重启 Widecast 服务和 DSH）' : ''
      throw new Error(`Widecast 服务调用失败: ${response.status} ${response.statusText}${suffix}`)
    }

    const result = await response.json() as unknown
    // server.ts 的业务 endpoint 使用 { ok, value } 包装；ping 兼容旧的平铺响应。
    if (result !== null && typeof result === 'object' && !Array.isArray(result)) {
      const envelope = result as { ok?: unknown; value?: unknown }
      if (envelope.ok === true && 'value' in envelope) return envelope.value as T
    }
    return result as T
  }

  async ping(): Promise<{ ok: boolean; version: string; message: string }> {
    return this.call('ping')
  }

  async listPlatforms(): Promise<{ platforms: Array<{ id: string; name: string; capabilities: string[] }> }> {
    return this.call('platforms.list')
  }

  async listAccounts(): Promise<{ accounts: Array<{ platform: string; name: string; status: string }> }> {
    return this.call('accounts.list')
  }

  async checkAccount(platform: string): Promise<{ ok: boolean; loggedIn: boolean; message?: string }> {
    return this.call('publish.check', { platform })
  }

  async startPublish(
    platform: string,
    input: Record<string, unknown>,
    accountId?: string,
  ): Promise<{ ok: boolean; task?: { id: string; status: string }; isDuplicate?: boolean; message?: string }> {
    return this.call('publish.start', { platform, input, accountId })
  }

  async getTaskStatus(taskId: string): Promise<{ task?: { id: string; status: string; step: string; message?: string } }> {
    return this.call('publish.status', { taskId })
  }

  async retryTask(
    taskId: string,
    confirmedNoPublication = false,
  ): Promise<{ ok: boolean; task?: { id: string; status: string }; message?: string }> {
    return this.call('publish.retry', { taskId, confirmedNoPublication })
  }

  async cancelTask(taskId: string): Promise<{ ok: boolean; message?: string }> {
    return this.call('publish.cancel', { taskId })
  }
}
