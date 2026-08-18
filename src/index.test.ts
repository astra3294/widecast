import { describe, expect, it } from 'vitest'
import { apply } from './index.js'

describe('DSH 插件工具层', () => {
  it('注册宿主工具、重试/取消工具和受控发布字段', () => {
    const registered: Array<{ name: string; parameters: Record<string, unknown> }> = []
    const ctx = {
      connection: { rpc: { handle: () => async () => {} } },
      tools: { register: (definition: { name: string; parameters: Record<string, unknown> }) => {
        registered.push(definition)
        return () => {}
      } },
      effect: (callback: () => unknown) => { void callback() },
    }

    apply(ctx)

    const names = registered.map((item) => item.name)
    expect(names).toContain('widecast_ping')
    expect(names).toContain('widecast_publish')
    expect(names).toContain('widecast_get_task_status')
    expect(names).toContain('widecast_retry_task')
    expect(names).toContain('widecast_cancel_task')

    const publish = registered.find((item) => item.name === 'widecast_publish')!
    const properties = publish.parameters.properties as Record<string, unknown>
    expect(properties.accountId).toBeDefined()
  })
})
