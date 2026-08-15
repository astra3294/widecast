/**
 * widecast 客户端半边:Harness 侧栏左下角入口 + 自媒体管理面板。
 *
 * 槽位(均已在本机安装源码核实):
 *  - `sidebar.footer.action`(kind list):设置按钮旁的左下角动作区,props { wide }
 *  - `shell.overlay`(kind list):全框架悬浮层,Modal 挂这里
 * 宿主通信:ctx.get('connection').rpc.call('/widecast', endpoint, payload)
 */
import { useSyncExternalStore, type ReactNode, type SVGProps } from 'react'
import { Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import { RPC_CHANNEL, WIDECAST_VERSION } from '../constants.js'
import { installWidecastStyles } from './styles.js'

type Translator = (key: string) => string

/** 广播/分发图标:widecast(广而播之)。 */
function BroadcastIcon({ size = 16, ...props }: SVGProps<SVGSVGElement> & { size?: number }): ReactNode {
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" {...props}>
      <path d="M6.9 12a5.1 5.1 0 0 1 10.2 0" />
      <path d="M9.4 12a2.6 2.6 0 0 1 5.2 0" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  )
}

interface RpcResult<T> {
  readonly ok: boolean
  readonly value?: T
  readonly error?: { code: string; message: string }
}

interface Connection {
  readonly rpc: {
    call(channel: string, endpoint: string, payload: unknown, signal?: AbortSignal): Promise<RpcResult<unknown>>
  }
}

interface WidecastSnapshot {
  readonly open: boolean
  readonly busy: boolean
  readonly available: boolean
  readonly version?: string
  readonly hint?: string
  readonly error?: string
}

const INITIAL: WidecastSnapshot = { open: false, busy: false, available: true }

class WidecastController {
  private snapshot: WidecastSnapshot = INITIAL
  private readonly listeners = new Set<() => void>()
  private initialized = false

  constructor(private readonly connection: Connection) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  getSnapshot = (): WidecastSnapshot => this.snapshot

  async initialize(): Promise<void> {
    if (this.initialized) return
    this.initialized = true
    try {
      const result = await this.connection.rpc.call(RPC_CHANNEL, 'hello', {})
      if (result.ok) {
        const value = result.value as { greeting?: string; hint?: string; version?: string }
        this.patch({ available: true, version: value.version, hint: value.hint })
      } else {
        this.patch({ available: false, error: result.error?.message ?? 'host 不可用' })
      }
    } catch (error) {
      this.patch({ available: false, error: String(error) })
    }
  }

  open = (): void => {
    this.patch({ open: true })
    void this.initialize()
  }

  close = (): void => this.patch({ open: false })

  async ping(): Promise<void> {
    this.patch({ busy: true, error: undefined })
    try {
      const result = await this.connection.rpc.call(RPC_CHANNEL, 'ping', {})
      if (result.ok) {
        this.patch({ busy: false, available: true })
      } else {
        this.patch({ busy: false, available: false, error: result.error?.message ?? 'ping 失败' })
      }
    } catch (error) {
      this.patch({ busy: false, available: false, error: String(error) })
    }
  }

  private patch(next: Partial<WidecastSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }
}

function useWidecast(controller: WidecastController): WidecastSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

function dotState(snapshot: WidecastSnapshot): StateDotState {
  if (!snapshot.available) return 'error'
  if (snapshot.busy) return 'ongoing'
  return 'done'
}

interface SharedProps {
  controller: WidecastController
  t: Translator
}

function WidecastSidebarButton({ controller, t, wide }: SharedProps & { wide: boolean }): ReactNode {
  const snapshot = useWidecast(controller)
  return (
    <button
      className="widecastSidebarButton"
      data-wide={String(wide)}
      data-open={String(snapshot.open)}
      type="button"
      onClick={controller.open}
      aria-label={t('open')}
      title={t('open')}
    >
      <BroadcastIcon size={16} aria-hidden="true" />
      {wide ? <span className="widecastSidebarLabel">{t('name')}</span> : null}
      <StateDot state={dotState(snapshot)} size={8} className="widecastSidebarStatus" />
      <span className="widecastVisuallyHidden">{t('name')}</span>
    </button>
  )
}

function WidecastPanel({ controller, t }: SharedProps): ReactNode {
  const snapshot = useWidecast(controller)
  return (
    <Modal
      open={snapshot.open}
      onClose={controller.close}
      title={t('title')}
      closeLabel={t('close')}
      className="widecastModal"
      contentClassName="widecastModalContent"
    >
      <div className="widecastSummary">
        <span className="widecastSummaryIcon" aria-hidden="true"><BroadcastIcon size={18} /></span>
        <div className="widecastSummaryCopy">
          <h3>{snapshot.available ? t('status.ready') : t('status.unavailable')}</h3>
          <p>{snapshot.available ? t('summary.ready') : t('summary.unavailable')}</p>
        </div>
        <StateDot state={dotState(snapshot)} size={8} />
      </div>
      {snapshot.error !== undefined ? <div className="widecastError" role="alert">{snapshot.error}</div> : null}
      <div className="widecastNotice">
        <h3>{t('roadmap.title')}</h3>
        <p className="widecastEmpty">{snapshot.hint ?? t('roadmap.description')}</p>
      </div>
      <p className="widecastVersion">{t('version.label')} v{WIDECAST_VERSION}</p>
    </Modal>
  )
}

const en: Record<string, string> = {
  name: 'Self-Media', open: 'Open Self-Media manager', close: 'Close', title: 'Self-Media Manager',
  'status.ready': 'Widecast ready', 'status.unavailable': 'Host unavailable',
  'summary.ready': 'Widecast host is connected; agent tools are available.',
  'summary.unavailable': 'The Widecast host service is unreachable. Reload the page or restart the profile.',
  'roadmap.title': 'Roadmap',
  'roadmap.description': 'Account management (P1) and the publish queue (P2) are under development.',
  'version.label': 'Version',
}

const zh: Record<string, string> = {
  name: '自媒体', open: '打开自媒体管理', close: '关闭', title: '自媒体管理',
  'status.ready': 'widecast 已就绪', 'status.unavailable': '宿主不可用',
  'summary.ready': 'widecast 宿主已连接,模型工具可用。',
  'summary.unavailable': '无法连接 widecast 宿主服务,请刷新页面或重启 profile。',
  'roadmap.title': '开发路线',
  'roadmap.description': '账号管理(P1)与发布队列(P2)功能开发中。',
  'version.label': '版本',
}

export const inject = ['slots', 'locale', 'connection']
const NS = 'widecast'

export function apply(ctx: ClientContext): void {
  const connection = ctx.get('connection') as Connection
  const controller = new WidecastController(connection)

  ctx.effect(() => installWidecastStyles(), 'widecast: styles')
  ctx.effect(() => ctx.locale.register(NS, { en, zh }), 'widecast: dictionaries')
  const t = ctx.locale.bind(NS)
  const injected = () => ({ controller, t })

  ctx.slots.inject('sidebar.footer.action', () =>
    ctx.slots.register(
      { name: 'sidebar.footer.action', id: 'widecast', order: 80, locale: NS, inject: injected },
      WidecastSidebarButton,
    ))
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'widecast', order: 80, locale: NS, inject: injected },
      WidecastPanel,
    ))

  void controller.initialize()
}

export default { inject, apply }
