# Changelog

All notable changes to this project will be documented in this file.

## [0.5.0] - 2026-08-18

### Fixed
- **任务状态规范化**：使用 `submitting` / `published` / `scheduled` 等业务状态，并兼容迁移旧任务中的 `publishing` / `done`。
- **幂等防重复**：已发布、已提交但结果不确定、排队中或失败待重试的同键任务都会阻止新建任务；只有明确提交前终止的任务允许重新创建。
- **结果验证**：点击失败不再伪报成功；仅有 Toast 的 C 级证据进入 `needs_attention`，需要内容列表或更强凭证才能标记 `published`。
- **输入校验**：发布入口统一校验标题、绝对素材路径、视频/图文互斥、图片和封面存在性。
- **任务恢复安全**：提交后的异常进入 `needs_attention`，重试必须明确确认平台没有作品，并记录重试历史。

### Added
- DSH 工具 `widecast_retry_task`、`widecast_cancel_task`、`widecast_logout_account`。
- 独立服务本地 token 认证；构建产物增加 `lib/server.js`，可通过 `pnpm serve:prod` 启动。
- 同一账号任务串行队列，避免并发页面争用登录会话。
- 插件工具注册、平台能力、token 和弱证明结果的自动化测试。

### Changed
- 小红书暂降为“仅登录”，在完成真实账号/草稿验收前不再宣称支持图文发布。

## [0.4.1] - 2026-08-20

### Fixed
- **验证码检测**：发布流程中加入验证码/二次验证检测
  - 点击发布按钮后立即检测验证码弹窗
  - 检测到验证码时标记为 `needs_attention` 状态
  - 通知用户"平台要求验证码或二次验证，请手动完成后重试"
  - 不再误报为"发布成功"

### Changed
- 发布流程增加 `check-captcha` 步骤
- 验证码检测包括：滑块验证码、图形验证码、短信验证码、人机验证

## [0.4.0] - 2026-08-20

### 🎉 架构升级：Widecast 独立服务模式 + DSH 工具层验证成功

**重大改进**：Widecast 从 DSH 插件模式升级为独立服务模式。

**优势**：
- 代码修改后只需重启 Widecast 服务，不影响 DSH
- 支持热重载（`pnpm serve:dev`）
- 独立进程，更稳定
- DSH 通过 HTTP RPC 调用 Widecast 服务

### 验证结果

**DSH 工具层调用独立服务成功**：
- `widecast_ping` → ✅ 版本 0.4.0
- `widecast_check_account(douyin)` → ✅ 抖音账号正常
- `widecast_publish` → ✅ 任务创建成功
- `widecast_get_task_status` → ✅ 状态查询正常

**抖音发布成功**（通过 DSH 工具层）：
```
任务 ID: d3daa0a7-7fa4-41c1-b6fa-d29c32492ac7
状态: done (verified)
凭证等级: B (success-toast)
证据: 检测到成功提示
```

### Added
- **Widecast 独立服务**：`src/server.ts` — HTTP/RPC 服务器（端口 18080）
- **Widecast 客户端**：`src/client.ts` — 通过 HTTP 调用独立服务
- **自动账号检查**：`widecast_check_account` 工具 — 发布前检查账号状态
- **服务启动脚本**：`pnpm serve` 和 `pnpm serve:dev`

### Changed
- **DSH 工具层**：从直接调用模块改为调用独立服务
- **架构**：从单进程插件模式改为独立服务 + DSH 客户端模式

### Fixed
- **DSH 热重载问题**：不再依赖 DSH 重启来加载新代码
- **工具层 lossless JSON 兼容**：独立服务统一处理 JSON 序列化

### Added
- **Widecast 独立服务**：`src/server.ts` — HTTP/RPC 服务器（端口 18080）
- **Widecast 客户端**：`src/client.ts` — 通过 HTTP 调用独立服务
- **自动账号检查**：`widecast_check_account` 工具 — 发布前检查账号状态
- **服务启动脚本**：`pnpm serve` 和 `pnpm serve:dev`

### Changed
- **DSH 工具层**：从直接调用模块改为调用独立服务
- **架构**：从单进程插件模式改为独立服务 + DSH 客户端模式

### Fixed
- **DSH 热重载问题**：不再依赖 DSH 重启来加载新代码
- **工具层 lossless JSON 兼容**：独立服务统一处理 JSON 序列化

## [0.3.2] - 2026-08-20

### 🎉 抖音发布再次验证成功

第二次在真实抖音页面完成视频发布闭环：

```
状态: done (verified)
凭证等级: B (success-toast)
证据: 检测到成功提示：已发布
任务统计: 8 个成功任务
```

### Fixed
- **DSH 工具层 lossless JSON 兼容**：新增 `removeUndefined()` 递归移除对象中的 `undefined` 值
- **service.listAccounts()**：不再返回包含 `undefined` 的对象

### Known Issues
- DSH 不支持模块级热重载（只 watch `cordis.patch.yml`），需要重启 DSH 才能让工具修复生效
- 浏览器档案被 DSH 进程占用时，需要先清理 Chrome 进程

## [0.3.1] - 2026-08-20

### Added
- **小红书适配器框架**：imageText 能力就绪，发布流程配置（选择器待登录后实测验证）
- **小红书诊断脚本**：`scripts/diagnose-xiaohongshu.ts` 和 `scripts/e2e-xiaohongshu.ts`
- **小红书发布页 URL**：`creator.xiaohongshu.com/publish/publish`
- **小红书内容管理页**：`creator.xiaohongshu.com/new/content`

### Changed
- README 平台能力表：小红书标注"图文发布框架就绪"
- 小红书 capabilities 从 `['login']` 升级为 `['login', 'imageText']`

## [0.3.0] - 2026-08-20

### 🎉 抖音端到端发布成功

首次在真实抖音页面完成完整的视频发布闭环：

```
状态: done (verified)
凭证等级: B (success-toast)
证据: 检测到成功提示：发布成功
```

### Added
- **浏览器反检测**：`--disable-blink-features=AutomationControlled` + `ignoreDefaultArgs: ['--enable-automation']`
- **抖音 `__name` 冲突修复**：`fixNameConflict()` 通过 CDP 在页面加载后覆盖安全 SDK 的 `__name` getter
- **CDP 降级路径**：`cdpSetValue()` 在 Playwright evaluate 失败时通过 CDP 直接操作 DOM
- **B→A 级凭证升级**：发布成功后自动在内容管理页进一步验证，尝试升级凭证等级
- **诊断脚本**：`scripts/e2e-douyin.ts`（端到端测试）、`scripts/publish-douyin.ts`（独立发布）、`scripts/publish-douyin-direct.ts`（核心模块直调）

### Fixed
- **视频上传等待**：先 `waitForLoadState('networkidle')` + 3s 延迟，再三级回退定位
- **表单填写**：优先 `locator.fill()`，`__name` 冲突时 CDP 降级
- **dumpEditorState**：加 catch 兜底，不阻断发布流程

## [0.2.1] - 2026-08-20

### Fixed
- **标题输入**：点击标题框后先全选清除旧内容再输入（`Ctrl+A` + `Backspace`），防止平台默认标题被追加而非替换
- **响应收集器竞态**：`PublishResponseCollector.getResponses()` 改为 async，等待所有 response body 读取完成后再返回
- **抖音响应判断**：新增 `status_code === 0` 和 `err_no === 0` 检查，匹配抖音实际 API 返回格式

### Added
- **单元测试**：62 个测试覆盖 types.ts（状态机/幂等键/指纹）、tasks.ts（CRUD/幂等/重试/取消/持久化）、publish.ts（输入校验）
- **vitest** 测试框架集成
- **CHANGELOG.md**

## [0.2.0] - 2026-08-20

### Added
- **完整状态机**：draft/queued/uploading/publishing/verifying/done/needs_attention/retryable_failed/terminal_failed/cancelled
- **发布凭证系统**（PublishReceipt）：A/B/C 三级证明等级
- **幂等防重复**：SHA-256 幂等键（account + platform + content-fingerprint + time-bucket）
- **平台能力分级**：login/video/imageText/article/verify，只有验证通过的能力才展示
- **响应监听**：点击发布前注册网络响应监听，不立即离开发布页
- **安全重试**：retryable_failed 和 needs_attention 状态支持手动重试
- **Debug 接口隔离**：仅 WIDECAST_DEV=1 环境变量启用时可用
- **技术规划文档**（WIDECAST_TECHNICAL_MASTER_PLAN.md）

### Changed
- 清理所有"学习自蚁小二"来源注释，代码完全基于平台公开页面独立实现
- 平台列表增加 capabilities 字段，UI 和 Agent 工具只展示已验证能力
- 客户端 UI 支持新状态类型、Receipt 显示、重试/取消按钮
- 版本号升至 0.2.0

## [0.1.5] - 2026-08-19

### Fixed
- 登录判定重写：页面渲染完成后再判，文本级反证与正证
- 面板登录按钮对失效/未知账号也显示（可重登）

## [0.1.4] - 2026-08-18

### Fixed
- 登录判定反证优先（登录表单存在即未登录）
- 修复抖音 SPA 假阳性

## [0.1.3] - 2026-08-18

### Fixed
- 抖音登录判定精确化
- 发布前登录前置检查

## [0.1.2] - 2026-08-17

### Added
- AddAccountResult.qrCodeImage 接口
- 无头浏览器/面板扫码/编辑器 DOM 快照

## [0.1.1] - 2026-08-17

### Added
- 重启后自动重发编排
- 宿主就绪探测

## [0.1.0] - 2026-08-16

### Added
- 初始版本：DSH 原生插件框架
- 侧栏入口 + 管理面板
- 宽样式基于 Harness `--dsw-*` 设计 token，深浅色自适应；中英文双语
- GitHub Actions CI + 发布工作流（Trusted Publishing）
