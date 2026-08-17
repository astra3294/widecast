/**
 * Widecast 服务客户端：通过 HTTP 调用独立的 Widecast 服务。
 */
export class WidecastClient {
  private readonly baseUrl: string

  constructor(baseUrl: string = 'http://127.0.0.1:18080') {
    this.baseUrl = baseUrl
  }

  async call<T>(endpoint: string, payload?: Record<string, unknown>): Promise<T> {
    const response = await fetch(`${this.baseUrl}/rpc`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint, payload }),
    })

    if (!response.ok) {
      throw new Error(`Widecast 服务调用失败: ${response.status} ${response.statusText}`)
    }

    return response.json() as Promise<T>
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

  async retryTask(taskId: string): Promise<{ ok: boolean; task?: { id: string; status: string }; message?: string }> {
    return this.call('publish.retry', { taskId })
  }

  async cancelTask(taskId: string): Promise<{ ok: boolean; message?: string }> {
    return this.call('publish.cancel', { taskId })
  }
}
