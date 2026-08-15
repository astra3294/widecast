/*
 * widecast client styles.
 *
 * 所有颜色/边框/背景都经 DeepSeek Harness 的 `--dsw-*` 设计 token
 * (由 dsh-client-ui-theme 定义在 body / body[data-ds-dark-theme]),
 * 与 WebUI 同色板、同圆角、同深浅色切换 —— 不硬编码任何 hex。
 */
const CSS = `
.widecastVisuallyHidden{position:absolute!important;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

.widecastSidebarButton{box-sizing:border-box;position:relative;display:inline-flex;align-items:center;gap:8px;width:calc(100% + 8px);height:34px;margin:4px -4px;padding:6px 2px 6px 10px;border:0;border-radius:12px;background:transparent;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:14px;line-height:20px;cursor:pointer;overflow:hidden}
.widecastSidebarButton:hover{background:var(--dsw-alias-interactive-bg-hover-solid)}
.widecastSidebarButton:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}
.widecastSidebarButton[data-open=true]{background:var(--dsw-alias-interactive-bg-hover-solid)}
.widecastSidebarIcon{display:block;flex:none;width:16px;height:16px;color:inherit}
.widecastSidebarLabel{flex:1 1 auto;text-align:left;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.widecastSidebarStatus{position:absolute;right:8px;top:50%;transform:translateY(-50%)}

.widecastSummary{display:flex;align-items:center;gap:10px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:12px}
.widecastSummaryIcon{display:grid;place-items:center;width:32px;height:32px;border-radius:8px;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover)}
.widecastSummaryCopy{flex:1 1 auto;min-width:0}
.widecastSummaryCopy h3{margin:0 0 2px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.widecastSummaryCopy p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}

.widecastError{margin-top:12px;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover-danger);word-break:break-word}
.widecastNotice{margin-top:16px;padding-top:16px;border-top:1px solid var(--dsw-alias-border-l2)}
.widecastNotice h3{margin:0 0 8px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}
.widecastEmpty{margin:0;font-size:13px;line-height:20px;color:var(--dsw-alias-label-tertiary)}
.widecastVersion{margin:12px 0 0;font-size:12px;line-height:18px;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption)}

.widecastTabs{display:flex;gap:4px;margin:0 0 14px;padding:4px;border:1px solid var(--dsw-alias-border-l2);border-radius:10px;background:var(--dsw-alias-interactive-bg-hover)}
.widecastTab{flex:1 1 0;padding:6px 8px;border:0;border-radius:8px;background:transparent;color:var(--dsw-alias-label-secondary);font-family:var(--dsw-font-family);font-size:13px;line-height:20px;cursor:pointer}
.widecastTab:hover{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-interactive-bg-hover-solid)}
.widecastTab[data-active=true]{color:var(--dsw-alias-label-primary);background:var(--dsw-alias-button-ghost-active-fill);font-weight:500}

.widecastHint{margin:0 0 10px;padding:8px 12px;border-radius:8px;font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-button-ghost-active-fill)}
.widecastActions{display:flex;justify-content:flex-end;margin-bottom:10px}
.widecastGroupTitle{margin:16px 0 8px;font-size:14px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary)}

.widecastAccountList,.widecastPlatformGrid{display:flex;flex-direction:column;margin:0;padding:0;list-style:none}
.widecastAccountRow{display:flex;align-items:center;gap:10px;min-height:44px;padding:8px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.widecastAccountDot{flex:none}
.widecastAccountMeta{flex:1 1 auto;min-width:0}
.widecastAccountMeta strong{display:block;font-size:13px;line-height:20px;font-weight:500;color:var(--dsw-alias-label-secondary)}
.widecastAccountMeta p{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary)}
.widecastPlatformRow{display:flex;align-items:center;justify-content:space-between;gap:12px;min-height:36px;padding:6px 0;border-top:1px solid var(--dsw-alias-border-l1)}
.widecastPlatformName{font-size:13px;line-height:20px;color:var(--dsw-alias-label-secondary)}
`

/** 注入一次样式表,返回清理函数(随插件 fiber 卸载)。 */
export function installWidecastStyles(): () => void {
  const id = 'widecast/styles'
  const existing = document.querySelector(`style[data-plugin-css="${id}"]`)
  if (existing !== null) existing.remove()
  const style = document.createElement('style')
  style.dataset.plugin = 'widecast'
  style.dataset.pluginCss = id
  style.textContent = CSS
  document.head.appendChild(style)
  return () => style.remove()
}
