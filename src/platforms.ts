/**
 * 平台目录：主流媒体平台的定义。
 *
 * 能力分级：
 *   - login: 支持登录检测
 *   - video: 支持视频发布（已验证）
 *   - imageText: 支持图文发布（已验证）
 *   - article: 支持文章发布（已验证）
 *   - verify: 支持发布结果验证
 *
 * 只有通过验收矩阵的能力才会被标记为已实现。
 * UI 和 Agent 工具只能依据能力列表展示功能。
 */

// ─── 平台能力 ────────────────────────────────────────────────────────────────

export type PlatformCapability = 'login' | 'video' | 'imageText' | 'article' | 'verify'

// ─── 平台定义 ────────────────────────────────────────────────────────────────

export interface PlatformDef {
  id: string
  name: string
  /** 已验证的能力列表。 */
  capabilities: PlatformCapability[]
  /** 登录页（扫码/密码）。 */
  loginUrl: string
  /** 创作者后台首页（登录成功后所在）。 */
  homeUrl: string
  /** 发布页（视频/图文入口）。 */
  publishUrl?: string
  /** 图文模式发布页（如有独立入口）。 */
  publishImageUrl?: string
  /** 内容管理/作品列表页（发布后平台侧确认用）。 */
  manageUrl?: string
  /** 判定"已登录"的 URL 特征片段。 */
  loggedInUrlPatterns: string[]
  /** 判定"在登录页"的 URL 特征片段。 */
  loginUrlPatterns: string[]
  /**
   * 登录成功探针：
   * 监听页面自身的接口流量，或检查 localStorage 键；任一命中即视为已登录。
   */
  probe?: LoginProbe
  /** 发布流程配置。 */
  publish?: PublishPlan
  /** 图文模式发布流程配置（独立于视频）。 */
  publishImage?: PublishPlan
}

export interface LoginProbe {
  /** 监听响应 URL 中的特征片段。 */
  urlPattern?: string
  /** 响应 JSON 中任一存在的点分路径。 */
  keyPaths?: string[]
  /** 存在任一即视为已登录的 localStorage 键。 */
  localStorageKeys?: string[]
  /** 存在任一即视为"未登录"（登录表单可见，反证探针）的 CSS 选择器。 */
  blockedBySelectors?: string[]
  /** 页面正文出现任一即视为已登录（登录页不存在）的文本标记。 */
  bodyTextIn?: string[]
  /** 页面正文出现任一即视为未登录（登录页文案）的文本标记。 */
  bodyTextOut?: string[]
}

/**
 * 发布流程配置。
 * 选择器基于平台公开页面的实际 DOM 结构。
 */
export interface PublishPlan {
  /** 视频文件 input 选择器（setInputFiles 目标）。 */
  videoInputSelector?: string
  /** 图片文件 input 选择器（图文模式，支持 multiple）。 */
  imageInputSelector?: string
  /** 标题输入框选择器。 */
  titleInputSelector?: string
  /** 简介/正文编辑区选择器。 */
  descInputSelector?: string
  /** 封面文件 input 选择器。 */
  coverInputSelector?: string
  /** 发布按钮文本候选（按序尝试）。 */
  publishButtonTexts: string[]
  /** 点击发布后可能出现的确认弹窗按钮文本（按序点击）。 */
  confirmButtonTexts?: string[]
  /** 发布成功/进入审核的提示文本候选。 */
  successTexts: string[]
  /** 标题最大长度（超出截断）。 */
  titleMaxLength?: number
  /** 话题最大数量（超出部分转为纯文本，不带 #）。 */
  maxTopics?: number
  /**
   * 验证方式：
   * - 'content-list': 在内容管理页查找作品
   * - 'success-toast': 检查成功提示文本
   * - 'url-redirect': 检查 URL 跳转
   * - 'network-response': 监听发布接口响应
   */
  verifyMethods?: Array<'content-list' | 'success-toast' | 'url-redirect' | 'network-response'>
}

// ─── 平台列表 ────────────────────────────────────────────────────────────────

export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'douyin',
    name: '抖音',
    capabilities: ['login', 'video', 'imageText', 'verify'],
    loginUrl: 'https://creator.douyin.com/',
    homeUrl: 'https://creator.douyin.com/creator-micro/home',
    publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    publishImageUrl: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3',
    manageUrl: 'https://creator.douyin.com/creator-micro/content/manage',
    loggedInUrlPatterns: ['creator.douyin.com/creator-micro/home'],
    loginUrlPatterns: ['creator.douyin.com/root', 'douyin.com/passport'],
    probe: {
      blockedBySelectors: ['input[placeholder="请输入手机号"]', '#normal-input'],
      bodyTextOut: ['扫码登录', '我是创作者'],
      bodyTextIn: ['内容管理'],
    },
    publish: {
      // 2026-08 实测: #joyride-wrapper 已不存在,改为按 accept 属性定位
      videoInputSelector: 'input[type="file"][accept*="video"]',
      titleInputSelector: 'input[placeholder="填写作品标题，为作品获得更多流量"]',
      descInputSelector: '.zone-container.editor-kit-container.editor',
      publishButtonTexts: ['发布', '发表', '发 布', '立即投稿'],
      confirmButtonTexts: ['确认发布', '确定', '知道了', '继续发布', '立即发布'],
      successTexts: ['发布成功', '已发布', '审核中', '作品已提交'],
      titleMaxLength: 29,
      verifyMethods: ['content-list', 'success-toast'],
    },
    publishImage: {
      imageInputSelector: '.semi-tabs-pane-motion-overlay input[accept="image/png,image/jpeg,image/jpg,image/bmp,image/webp,image/tif"][multiple]',
      titleInputSelector: 'input[placeholder="添加作品标题"]',
      descInputSelector: '.editor.editor-comp-publish',
      publishButtonTexts: ['发布', '发表', '发 布'],
      confirmButtonTexts: ['确认发布', '确定', '知道了', '继续发布', '立即发布'],
      successTexts: ['发布成功', '已发布', '审核中', '作品已提交'],
      titleMaxLength: 30,
      maxTopics: 5,
      verifyMethods: ['content-list', 'success-toast'],
    },
  },
  {
    id: 'xiaohongshu',
    name: '小红书',
    capabilities: ['login', 'imageText'],
    loginUrl: 'https://creator.xiaohongshu.com/login',
    homeUrl: 'https://creator.xiaohongshu.com/new/home',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    manageUrl: 'https://creator.xiaohongshu.com/new/content',
    loggedInUrlPatterns: ['creator.xiaohongshu.com/new', 'creator.xiaohongshu.com/publish'],
    loginUrlPatterns: ['creator.xiaohongshu.com/login', 'www.xiaohongshu.com'],
    probe: { urlPattern: '/galaxy/creator/home/personal_info', keyPaths: ['data.red_num'] },
    // 小红书图文发布（2026-08 实测待验证，选择器基于公开页面结构）
    publish: {
      imageInputSelector: 'input[type="file"][accept*="image"]',
      titleInputSelector: 'input[placeholder*="标题"], input[name="title"]',
      descInputSelector: '[contenteditable="true"], .ql-editor, .ProseMirror',
      publishButtonTexts: ['发布', '发布笔记', '发布视频', '发布图文'],
      confirmButtonTexts: ['确认发布', '确定', '知道了'],
      successTexts: ['发布成功', '已发布', '审核中', '笔记已发布'],
      titleMaxLength: 20,
      maxTopics: 10,
      verifyMethods: ['content-list', 'success-toast'],
    },
  },
  {
    id: 'bilibili',
    name: 'B站',
    capabilities: ['login'],
    loginUrl: 'https://passport.bilibili.com/login',
    homeUrl: 'https://member.bilibili.com/platform/home',
    publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    loggedInUrlPatterns: ['member.bilibili.com/platform'],
    loginUrlPatterns: ['passport.bilibili.com'],
    probe: { urlPattern: '/x/passport-login/web/cookie/info', keyPaths: ['data.isLogin'] },
  },
  {
    id: 'kuaishou',
    name: '快手',
    capabilities: ['login'],
    loginUrl: 'https://cp.kuaishou.com/profile',
    homeUrl: 'https://cp.kuaishou.com/profile',
    publishUrl: 'https://cp.kuaishou.com/article/publish/video',
    loggedInUrlPatterns: ['cp.kuaishou.com/profile'],
    loginUrlPatterns: ['passport.kuaishou.com'],
    probe: { urlPattern: 'creator/pc/home/userInfo', keyPaths: ['data.coreUserInfo'] },
  },
  {
    id: 'shipinhao',
    name: '视频号',
    capabilities: ['login'],
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    homeUrl: 'https://channels.weixin.qq.com/platform',
    publishUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loggedInUrlPatterns: ['channels.weixin.qq.com/platform'],
    loginUrlPatterns: ['channels.weixin.qq.com/login'],
    probe: { urlPattern: 'mmfinderassistant-bin/auth/auth_data', keyPaths: ['data.finderUser'] },
  },
  {
    id: 'gongzhonghao',
    name: '公众号',
    capabilities: ['login'],
    loginUrl: 'https://mp.weixin.qq.com/',
    homeUrl: 'https://mp.weixin.qq.com/cgi-bin/home',
    publishUrl: 'https://mp.weixin.qq.com/cgi-bin/appmsg',
    loggedInUrlPatterns: ['mp.weixin.qq.com/cgi-bin/home', 'mp.weixin.qq.com/cgi-bin/appmsg'],
    loginUrlPatterns: ['mp.weixin.qq.com/cgi-bin/loginpage'],
  },
  {
    id: 'weibo',
    name: '微博',
    capabilities: ['login'],
    loginUrl: 'https://passport.weibo.com/sso/signin',
    homeUrl: 'https://weibo.com/',
    publishUrl: 'https://weibo.com/upload/channel',
    loggedInUrlPatterns: ['weibo.com/upload', 'weibo.com/u/'],
    loginUrlPatterns: ['passport.weibo.com', 'weibo.com/login'],
  },
  {
    id: 'toutiao',
    name: '头条号',
    capabilities: ['login'],
    loginUrl: 'https://mp.toutiao.com/auth/page/login',
    homeUrl: 'https://mp.toutiao.com/profile_v4',
    publishUrl: 'https://mp.toutiao.com/profile_v4/xigua/upload-video',
    loggedInUrlPatterns: ['mp.toutiao.com/profile_v4'],
    loginUrlPatterns: ['mp.toutiao.com/auth'],
    probe: { urlPattern: 'agw/creator_center/user_info', keyPaths: ['data.user_id_str'] },
  },
  {
    id: 'baijiahao',
    name: '百家号',
    capabilities: ['login'],
    loginUrl: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
    homeUrl: 'https://baijiahao.baidu.com/builder/rc/home',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    loggedInUrlPatterns: ['baijiahao.baidu.com/builder/rc'],
    loginUrlPatterns: ['baijiahao.baidu.com/builder/theme/bjh/login'],
    probe: { urlPattern: 'builder/app/appinfo', keyPaths: ['data.user'] },
  },
  {
    id: 'zhihu',
    name: '知乎',
    capabilities: ['login'],
    loginUrl: 'https://www.zhihu.com/signin?next=%2Fcreator',
    homeUrl: 'https://www.zhihu.com/creator',
    publishUrl: 'https://zhihu.com/zvideo/upload-video',
    loggedInUrlPatterns: ['zhihu.com/creator'],
    loginUrlPatterns: ['zhihu.com/signin'],
    probe: { urlPattern: 'api/v4/me', keyPaths: ['uid', 'data.uid'] },
  },
]

// ─── 工具函数 ────────────────────────────────────────────────────────────────

export function findPlatform(id: string): PlatformDef | undefined {
  return PLATFORMS.find((platform) => platform.id === id)
}

/** 检查平台是否支持指定能力。 */
export function hasCapability(platform: PlatformDef, capability: PlatformCapability): boolean {
  return platform.capabilities.includes(capability)
}

/** 获取支持指定能力的平台列表。 */
export function getPlatformsByCapability(capability: PlatformCapability): PlatformDef[] {
  return PLATFORMS.filter((p) => p.capabilities.includes(capability))
}

/** 依据 URL 判定登录态。 */
export function detectLoginState(platform: PlatformDef, url: string): 'logged-in' | 'login-page' | 'unknown' {
  if (platform.loggedInUrlPatterns.some((pattern) => url.includes(pattern))) return 'logged-in'
  if (platform.loginUrlPatterns.some((pattern) => url.includes(pattern))) return 'login-page'
  return 'unknown'
}
