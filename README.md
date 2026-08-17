# widecast — 面向 AI agent 的自媒体管理工具

广而播之（wide·cast）。**完全原创、免费（MIT）** 的自媒体多平台管理工具，以
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原生插件形态融入 Harness：

- 侧栏**左下角**新增「自媒体」入口，点击打开管理面板（账号 / 发布队列 / 草稿 / 数据 / 设置）；
- 模型获得一等公民工具（`widecast_list_accounts`、`widecast_publish` 等），可用自然语言管理账号与发布内容；
- 平台会话凭证仅存本机（经浏览器档案加密），永不进入对话上下文；
- 自动化以**浏览器模式为主**（Playwright 驱动真人会话的真实浏览器，平台签名/指纹天然合法），
  不逆向密码学签名、不伪造设备指纹、不伪装 UA；默认限速 + 全量审计日志，不与平台风控对抗；
- 登录与验证码一律由真人完成。

## ⚠️ 重要：独立服务架构

**Widecast 采用独立服务架构，不需要重启 DSH！**

```
架构：
DSH ←→ Widecast 客户端（src/index.ts）←→ Widecast 独立服务（src/server.ts）

启动顺序：
1. 启动 Widecast 服务：pnpm serve（端口 18080）
2. 启动 DSH：dsh --profile web
3. DSH 通过 HTTP RPC 调用 Widecast 服务

代码修改后：
- 只需重启 Widecast 服务（pnpm serve）
- 不需要重启 DSH
- 支持热重载（pnpm serve:dev）
```

## 安装

```bash
# 把 widecast 安装进 web profile（local link 开发模式）
dsh plugin --profile web add link:E:/自媒体/widecast

# 在 profile 的 package.json `dsh.profile.bundles` 中加入 "widecast"
# （widecast 自带的 cordis.patch.yml 会把插件 insert 进 loader）

# 启动 Widecast 独立服务（必须先启动）
cd E:\自媒体\widecast
pnpm serve

# 启动 DSH（Widecast 服务已启动后）
dsh --profile web
```

启动后刷新页面，左下角设置按钮旁会出现「自媒体」入口。

## 开发模式

```bash
# 启动 Widecast 独立服务（端口 18080）
pnpm serve

# 开发模式（自动重载，代码修改后自动重启服务）
pnpm serve:dev

# 构建
pnpm check

# 测试
pnpm test
```

## 核心能力

### 发布闭环（v0.3.0 — 抖音已实测验证）

- **完整状态机**：draft → queued → uploading → publishing → verifying → done / needs_attention / retryable_failed / terminal_failed
- **幂等防重复**：SHA-256 幂等键（account + platform + content-fingerprint + time-bucket），相同内容不会重复发布
- **发布凭证（Receipt）**：A/B/C 三级证明（网络响应 / 成功提示 / 内容列表确认），每次发布都有可验证的结果
- **安全重试**：retryable_failed 和 needs_attention 状态支持手动重试，不会自动重复发布
- **响应监听**：点击发布前注册响应监听，不立即离开发布页，确保捕获平台返回
- **抖音反检测**：禁用 AutomationControlled + CDP 修复安全 SDK `__name` 冲突

### 平台能力分级

每个平台的能力独立验证，只有通过验收矩阵的能力才会被标记为已实现：

| 平台 | 登录 | 视频发布 | 图文发布 | 结果验证 |
|------|------|----------|----------|----------|
| 抖音 | ✅ | ✅ (实测) | ✅ (实测) | ✅ (B级凭证) |
| 小红书 | ✅ | - | 🔧 (框架就绪) | - |
| B站 | ✅ | - | - | - |
| 快手 | ✅ | - | - | - |
| 视频号 | ✅ | - | - | - |
| 公众号 | ✅ | - | - | - |
| 微博 | ✅ | - | - | - |
| 头条号 | ✅ | - | - | - |
| 百家号 | ✅ | - | - | - |
| 知乎 | ✅ | - | - | - |

### Agent 工具

- `widecast_ping` — 检查插件状态
- `widecast_list_platforms` — 列出平台及能力
- `widecast_list_accounts` — 列出已登录账号
- `widecast_add_account` — 添加账号（真人扫码）
- `widecast_remove_account` — 移除账号
- `widecast_publish` — 发布内容（支持幂等防重复）
- `widecast_get_task_status` — 查询任务状态和 Receipt

## 结构

```
src/index.ts          宿主半边：引擎 + 模型工具 + 面板 RPC
src/types.ts          类型定义：状态机 + Receipt + 幂等键
src/platforms.ts      平台目录：能力分级 + 发布流程配置
src/browser.ts        浏览器管理：每平台独立档案
src/publish.ts        发布服务：响应监听 + 结果验证 + Receipt
src/service.ts        账号服务：登录探测 + 健康检查
src/tasks.ts          任务存储：状态持久化 + 幂等检查
src/accounts.ts       账号存储：JSON 文件
src/client/index.tsx  客户端半边：管理面板 UI
cordis.patch.yml      插件 insert 补丁
tsdown.config.ts      三段构建
```

## 开发

```bash
pnpm install
pnpm check          # typecheck + build
pnpm watch          # 客户端 tsdown --watch → HMR 自动重载

# 启用 debug 接口（仅开发模式）
WIDECAST_DEV=1 dsh --profile web
```

## 路线图

- **P0（已完成）** 插件链路：入口 / 面板 / RPC / 工具 / CI / 发布闭环
- **P1（进行中）** 平台扩展：小红书 / B站 / 视频号 / 快手
- **P2** Worker + SQLite：DSH 重启不影响上传和定时任务
- **P3** 数据面板：阅读 / 互动 / 粉丝回读 / 草稿箱 / 设置
- **P4** 产品化：安装器 / 自动更新 / 数据备份 / 团队协作

## 免责声明

本项目为原创实现，不包含任何第三方商业软件代码；自动化能力面向用户自有账号，
请遵守各平台服务条款，风险自负。
