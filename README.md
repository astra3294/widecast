# widecast — 面向 AI agent 的自媒体管理工具

广而播之(wide·cast)。**完全原创、免费(MIT)** 的自媒体多平台管理工具,以
[DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 原生插件形态融入 Harness:

- 侧栏**左下角**新增「自媒体」入口,点击打开管理面板(账号 / 草稿 / 发布队列 / 数据 / 设置);
- 模型获得一等公民工具(`widecast_list_accounts`、`widecast_publish` 等),可用自然语言管理账号与发布内容;
- 平台会话凭证仅存本机(经 DSH 凭证服务加密),永不进入对话上下文;
- 登录与验证码一律由真人完成,默认限速 + 全量审计日志,不与平台风控对抗。

## 安装

```bash
# 把 widecast 安装进 web profile(local link 开发模式)
dsh plugin --profile web add link:E:/自媒体/widecast

# 在 profile 的 package.json `dsh.profile.bundles` 中加入 "widecast"
# (widecast 自带的 cordis.patch.yml 会把插件 insert 进 loader)

# 重启 Harness
dsh --profile web
```

重启后刷新页面,左下角设置按钮旁会出现「自媒体」入口。

## 结构

```
src/index.ts          宿主半边:引擎 + 模型工具 + 面板 RPC(ctx.connection.rpc)
src/client/index.tsx  客户端半边:左下角入口 + 管理面板(slots + primitives + --dsw-* token)
cordis.patch.yml      插件 insert 补丁
tsdown.config.ts      三段构建(library / client);client 经 __ModuleLoader__ 装载
```

- 宿主半边**刻意零 `@deepseek-ai/*` 导入**(linked 包模块解析回退不到 dsh 内部),服务全部经 ctx 注入;
- 面板通信走 loopback RPC;样式全部使用 Harness `--dsw-*` 设计 token,深浅色自适应。

## 开发

```bash
pnpm install
pnpm check          # typecheck + build
pnpm watch          # 客户端 tsdown --watch → HMR 自动重载
```

## 路线图

- **P0(当前)** 插件链路:入口 / 面板 / RPC / `widecast_ping` 工具 / CI
- **P1** 账号管理:平台登录引导(真人扫码)、账号状态、凭证存取
- **P2** 发布闭环:发布管线、队列面板、`widecast_publish` 等工具
- **P3** 草稿 / 数据 / 设置 / 更多平台 / npm 正式发布

## 免责声明

本项目为原创实现,不包含任何第三方商业软件代码;自动化能力面向用户自有账号,
请遵守各平台服务条款,风险自负。
