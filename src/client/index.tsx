/**
 * widecast 客户端半边:Harness 侧栏左下角入口 + 自媒体管理面板。
 *
 * 槽位(均已在本机安装源码核实):
 *  - `sidebar.footer.action`(kind list):设置按钮旁的左下角动作区,props { wide }
 *  - `shell.overlay`(kind list):全框架悬浮层,Modal 挂这里
 * 宿主通信:ctx.get('connection').rpc.call('/widecast', endpoint, payload)
 */
import { useSyncExternalStore, type ReactNode, type SVGProps } from 'react'
import { Button, Modal, StateDot, type StateDotState } from '@deepseek-ai/dsh-client-ui-primitives'
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

type AccountStatus = 'ok' | 'expired' | 'unknown'

interface AccountView {
  platform: string
  name: string
  status: AccountStatus
  addedAt: number
  lastCheckedAt?: number
  lastError?: string
}

interface PlatformView {
  id: string
  name: string
  publishUrl?: string
}

type PanelTab = 'accounts' | 'queue' | 'drafts' | 'stats' | 'settings'

type TaskStatus = 'queued' | 'uploading' | 'publishing' | 'done' | 'failed'

interface TaskView {
  id: string
  platform: string
  title: string
  status: TaskStatus
  step: string
  message?: string
  createdAt: number
  updatedAt: number
}

interface WidecastSnapshot {
  readonly open: boolean
  readonly busy: boolean
  readonly available: boolean
  readonly version?: string
  readonly tab: PanelTab
  readonly accounts: readonly AccountView[]
  readonly platforms: readonly PlatformView[]
  readonly tasks: readonly TaskView[]
  readonly hint?: string
  readonly qr?: string
  readonly error?: string
}

const INITIAL: WidecastSnapshot = {
  open: false, busy: false, available: true, tab: 'accounts', accounts: [], platforms: [], tasks: [],
}

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
      const result = await this.call<{ version?: string }>('hello', {})
      this.patch({ available: true, version: result.version })
    } catch (error) {
      this.patch({ available: false, error: String(error) })
      return
    }
    await Promise.all([this.loadAccounts(), this.loadPlatforms(), this.loadTasks()])
  }

  open = (): void => {
    this.patch({ open: true })
    void this.initialize()
  }

  close = (): void => this.patch({ open: false })

  setTab = (tab: PanelTab): void => {
    this.patch({ tab })
    if (tab === 'queue') void this.loadTasks()
  }

  async loadTasks(): Promise<void> {
    try {
      const result = await this.call<{ tasks: Array<TaskView & { input?: { title?: string } }> }>('publish.list', {})
      this.patch({ tasks: result.tasks.map((task) => ({ ...task, title: task.input?.title ?? '' })) })
    } catch (error) {
      this.patch({ error: String(error) })
    }
  }

  async loadAccounts(): Promise<void> {
    try {
      const result = await this.call<{ accounts: AccountView[] }>('accounts.list', {})
      this.patch({ accounts: result.accounts })
    } catch (error) {
      this.patch({ error: String(error) })
    }
  }

  async loadPlatforms(): Promise<void> {
    try {
      const result = await this.call<{ platforms: PlatformView[] }>('platforms.list', {})
      this.patch({ platforms: result.platforms })
    } catch (error) {
      this.patch({ error: String(error) })
    }
  }

  /** 面板侧添加账号:立即返回登录引导,随后轮询登录探测直至成功或超时。 */
  async addAccount(platform: string): Promise<void> {
    this.patch({ busy: true, hint: undefined, qr: undefined, error: undefined })
    try {
      const result = await this.call<{ message?: string; status?: string; qrCodeImage?: string }>('accounts.add', { platform, waitMs: 0 })
      if (result.status === 'ok') {
        await this.loadAccounts()
        this.patch({ busy: false, hint: result.message ?? '登录成功,账号已保存' })
        return
      }
      this.patch({ hint: result.message ?? '请扫码登录', qr: result.qrCodeImage })
      for (let attempt = 0; attempt < 60; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 3000))
        const check = await this.call<{ loggedIn: boolean }>('accounts.check', { platform })
        if (check.loggedIn) {
          await this.loadAccounts()
          this.patch({ busy: false, qr: undefined, hint: '登录成功,账号已保存' })
          return
        }
      }
      this.patch({ busy: false, hint: '仍在等待登录;完成后点「全部体检」' })
    } catch (error) {
      this.patch({ busy: false, error: String(error) })
    }
  }

  async removeAccount(platform: string): Promise<void> {
    this.patch({ busy: true, error: undefined })
    try {
      await this.call('accounts.remove', { platform })
      await this.loadAccounts()
      this.patch({ busy: false, hint: undefined })
    } catch (error) {
      this.patch({ busy: false, error: String(error) })
    }
  }

  async checkAll(): Promise<void> {
    this.patch({ busy: true, error: undefined })
    try {
      const result = await this.call<{ accounts: AccountView[] }>('accounts.check', {})
      this.patch({ accounts: result.accounts, busy: false })
    } catch (error) {
      this.patch({ busy: false, error: String(error) })
    }
  }

  private patch(next: Partial<WidecastSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...next }
    for (const listener of this.listeners) listener()
  }

  private async call<T>(endpoint: string, payload: unknown): Promise<T> {
    let result: RpcResult<T>
    try {
      result = await this.connection.rpc.call(RPC_CHANNEL, endpoint, payload) as RpcResult<T>
    } catch (error) {
      const raw = String(error)
      throw new Error(raw.includes('Invalid input')
        ? `与宿主通信失败(宿主版本可能未更新,请重启 Harness):${endpoint}`
        : `${endpoint} 通信失败:${raw.slice(0, 300)}`)
    }
    if (!result.ok) throw new Error(result.error?.message ?? `${endpoint} failed`)
    return result.value as T
  }
}

function useWidecast(controller: WidecastController): WidecastSnapshot {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

function statusDot(status: AccountStatus): StateDotState {
  switch (status) {
    case 'ok': return 'done'
    case 'expired': return 'error'
    default: return 'ongoing'
  }
}

function statusLabel(status: AccountStatus, t: Translator): string {
  switch (status) {
    case 'ok': return t('account.ok')
    case 'expired': return t('account.expired')
    default: return t('account.unknown')
  }
}

interface SharedProps {
  controller: WidecastController
  t: Translator
}

const TABS: readonly PanelTab[] = ['accounts', 'queue', 'drafts', 'stats', 'settings']

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
      <StateDot state={snapshot.available ? 'done' : 'error'} size={8} className="widecastSidebarStatus" />
      <span className="widecastVisuallyHidden">{t('name')}</span>
    </button>
  )
}

function TabBar({ snapshot, controller, t }: SharedProps & { snapshot: WidecastSnapshot }): ReactNode {
  return (
    <div className="widecastTabs" role="tablist">
      {TABS.map((tab) => (
        <button
          key={tab}
          type="button"
          role="tab"
          aria-selected={snapshot.tab === tab}
          data-active={String(snapshot.tab === tab)}
          className="widecastTab"
          onClick={() => controller.setTab(tab)}
        >
          {t(`tab.${tab}`)}
        </button>
      ))}
    </div>
  )
}

function AccountsTab({ snapshot, controller, t }: SharedProps & { snapshot: WidecastSnapshot }): ReactNode {
  const added = new Set(snapshot.accounts.map((item) => item.platform))
  const addable = snapshot.platforms.filter((platform) => !added.has(platform.id))
  return (
    <div className="widecastAccounts">
      {snapshot.hint !== undefined ? <div className="widecastHint" role="status">
        {snapshot.hint}
        {snapshot.qr !== undefined ? <img className="widecastQr" src={snapshot.qr} alt="登录二维码" /> : null}
      </div> : null}
      <div className="widecastActions">
        <Button variant="ghost" size="sm" disabled={snapshot.busy} onClick={() => { void controller.checkAll() }}>
          {t('account.checkAll')}
        </Button>
      </div>
      {snapshot.accounts.length === 0 ? (
        <p className="widecastEmpty">{t('account.empty')}</p>
      ) : (
        <ul className="widecastAccountList">
          {snapshot.accounts.map((account) => (
            <li className="widecastAccountRow" key={account.platform}>
              <StateDot state={statusDot(account.status)} size={8} className="widecastAccountDot" />
              <div className="widecastAccountMeta">
                <strong>{account.name}</strong>
                <p>
                  {statusLabel(account.status, t)}
                  {account.lastError !== undefined ? ` · ${account.lastError}` : ''}
                </p>
              </div>
              <Button variant="ghost" size="sm" disabled={snapshot.busy} onClick={() => { void controller.removeAccount(account.platform) }}>
                {t('account.remove')}
              </Button>
            </li>
          ))}
        </ul>
      )}
      <h3 className="widecastGroupTitle">{t('account.addTitle')}</h3>
      <ul className="widecastPlatformGrid">
        {addable.map((platform) => (
          <li className="widecastPlatformRow" key={platform.id}>
            <span className="widecastPlatformName">{platform.name}</span>
            <Button variant="outline" size="sm" disabled={snapshot.busy} onClick={() => { void controller.addAccount(platform.id) }}>
              {t('account.add')}
            </Button>
          </li>
        ))}
        {addable.length === 0 ? <p className="widecastEmpty">{t('account.allAdded')}</p> : null}
      </ul>
    </div>
  )
}

function PlaceholderTab({ tab, t }: { tab: PanelTab; t: Translator }): ReactNode {
  return <p className="widecastEmpty">{t('placeholder')}{t(`tab.${tab}`)}({t('placeholder.dev')})</p>
}

function taskDot(status: TaskStatus): StateDotState {
  switch (status) {
    case 'done': return 'done'
    case 'failed': return 'error'
    default: return 'ongoing'
  }
}

function taskLabel(status: TaskStatus, t: Translator): string {
  switch (status) {
    case 'queued': return t('task.queued')
    case 'uploading': return t('task.uploading')
    case 'publishing': return t('task.publishing')
    case 'done': return t('task.done')
    case 'failed': return t('task.failed')
  }
}

function QueueTab({ snapshot, t }: { snapshot: WidecastSnapshot; t: Translator }): ReactNode {
  if (snapshot.tasks.length === 0) return <p className="widecastEmpty">{t('task.empty')}</p>
  return (
    <ul className="widecastAccountList">
      {snapshot.tasks.map((task) => (
        <li className="widecastAccountRow" key={task.id}>
          <StateDot state={taskDot(task.status)} size={8} className="widecastAccountDot" />
          <div className="widecastAccountMeta">
            <strong>{task.platform}{task.title !== '' ? ` · ${task.title}` : ''}</strong>
            <p>
              {taskLabel(task.status, t)}
              {task.message !== undefined && task.message !== '' ? ` · ${task.message}` : ''}
              {' · '}{new Date(task.createdAt).toLocaleTimeString()}
            </p>
          </div>
        </li>
      ))}
    </ul>
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
      <TabBar snapshot={snapshot} controller={controller} t={t} />
      {snapshot.error !== undefined ? <div className="widecastError" role="alert">{snapshot.error}</div> : null}
      {!snapshot.available ? <div className="widecastError" role="alert">{t('summary.unavailable')}</div> : null}
      {snapshot.tab === 'accounts' ? <AccountsTab snapshot={snapshot} controller={controller} t={t} /> : null}
      {snapshot.tab === 'queue' ? <QueueTab snapshot={snapshot} t={t} /> : null}
      {snapshot.tab !== 'accounts' && snapshot.tab !== 'queue' ? <PlaceholderTab tab={snapshot.tab} t={t} /> : null}
      <p className="widecastVersion">{t('version.label')} v{WIDECAST_VERSION}</p>
    </Modal>
  )
}

const en: Record<string, string> = {
  name: 'Self-Media', open: 'Open Self-Media manager', close: 'Close', title: 'Self-Media Manager',
  'summary.unavailable': 'The Widecast host service is unreachable. Reload the page or restart the profile.',
  'tab.accounts': 'Accounts', 'tab.queue': 'Publish Queue', 'tab.drafts': 'Drafts', 'tab.stats': 'Analytics', 'tab.settings': 'Settings',
  'account.checkAll': 'Check all', 'account.empty': 'No accounts yet — add a platform below.',
  'account.addTitle': 'Add platform', 'account.add': 'Add', 'account.remove': 'Remove', 'account.allAdded': 'All platforms added.',
  'account.ok': 'Online', 'account.expired': 'Expired', 'account.unknown': 'Unknown',
  'placeholder': 'The ', 'placeholder.dev': ' tab is under development.',
  'task.empty': 'No publish tasks yet. Use the widecast_publish tool or ask the agent to publish.',
  'task.queued': 'Queued', 'task.uploading': 'Uploading', 'task.publishing': 'Publishing', 'task.done': 'Done', 'task.failed': 'Failed',
  'version.label': 'Version',
}

const zh: Record<string, string> = {
  name: '自媒体', open: '打开自媒体管理', close: '关闭', title: '自媒体管理',
  'summary.unavailable': '无法连接 widecast 宿主服务,请刷新页面或重启 profile。',
  'tab.accounts': '账号', 'tab.queue': '发布队列', 'tab.drafts': '草稿', 'tab.stats': '数据', 'tab.settings': '设置',
  'account.checkAll': '全部体检', 'account.empty': '还没有账号,在下方添加平台登录。',
  'account.addTitle': '添加平台', 'account.add': '登录', 'account.remove': '移除', 'account.allAdded': '已全部添加。',
  'account.ok': '在线', 'account.expired': '已失效', 'account.unknown': '未知',
  'placeholder': '', 'placeholder.dev': 'tab 开发中。',
  'task.empty': '还没有发布任务。对 agent 说"帮我把这个视频发到抖音"即可。',
  'task.queued': '排队中', 'task.uploading': '上传中', 'task.publishing': '发布中', 'task.done': '完成', 'task.failed': '失败',
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
