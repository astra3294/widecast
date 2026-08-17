# Changelog

All notable changes to this project will be documented in this file.

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
