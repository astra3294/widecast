/**
 * 平台目录:主流媒体平台的定义(登录页/创作者后台/发布页 + 登录探针)。
 * URL 与探针清单源自对蚁小二平台注册表/登录探测表(platformMapsIn)的逆向提取
 * (公开事实:各平台创作者后台自己的接口与 localStorage 键),实现为原创代码。
 */

export interface PlatformDef {
  id: string
  name: string
  /** 登录页(扫码/密码) */
  loginUrl: string
  /** 创作者后台首页(登录成功后所在) */
  homeUrl: string
  /** 发布页(视频/图文入口) */
  publishUrl?: string
  /** 图文模式发布页(如有独立入口) */
  publishImageUrl?: string
  /** 内容管理/作品列表页(发布后平台侧确认用) */
  manageUrl?: string
  /** 判定"已登录"的 URL 特征片段 */
  loggedInUrlPatterns: string[]
  /** 判定"在登录页"的 URL 特征片段 */
  loginUrlPatterns: string[]
  /**
   * 登录成功探针(学习自蚁小二 platformMapsIn 探针表,原创实现):
   * 监听页面自身的接口流量(与 listenFetch 同款思路,但纯观察不注入),
   * 或检查 localStorage 键;任一命中即视为已登录。
   */
  probe?: LoginProbe
  /** 发布流程配置(选择器学习自蚁小二 RPA 模板) */
  publish?: PublishPlan
  /** 图文模式发布流程配置(独立于视频) */
  publishImage?: PublishPlan
}

export interface LoginProbe {
  /** 监听响应 URL 中的特征片段 */
  urlPattern?: string
  /** 响应 JSON 中任一存在的点分路径 */
  keyPaths?: string[]
  /** 存在任一即视为已登录的 localStorage 键 */
  localStorageKeys?: string[]
  /** 存在任一即视为"未登录"(登录表单可见,反证探针)的 CSS 选择器 */
  blockedBySelectors?: string[]
}

/**
 * 发布流程配置(选择器学习自蚁小二 RPA 模板,原创实现)。
 */
export interface PublishPlan {
  /** 视频文件 input 选择器(setInputFiles 目标) */
  videoInputSelector?: string
  /** 图片文件 input 选择器(图文模式,支持 multiple) */
  imageInputSelector?: string
  /** 标题输入框选择器 */
  titleInputSelector?: string
  /** 简介/正文编辑区选择器 */
  descInputSelector?: string
  /** 封面文件 input 选择器 */
  coverInputSelector?: string
  /** 发布按钮文本候选(按序尝试) */
  publishButtonTexts: string[]
  /** 点击发布后可能出现的确认弹窗按钮文本(按序点击) */
  confirmButtonTexts?: string[]
  /** 发布成功/进入审核的提示文本候选 */
  successTexts: string[]
  /** 标题最大长度(超出截断) */
  titleMaxLength?: number
}

export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'xiaohongshu', name: '小红书',
    loginUrl: 'https://creator.xiaohongshu.com/login',
    homeUrl: 'https://creator.xiaohongshu.com/new/home',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    loggedInUrlPatterns: ['creator.xiaohongshu.com/new', 'creator.xiaohongshu.com/publish'],
    loginUrlPatterns: ['creator.xiaohongshu.com/login', 'www.xiaohongshu.com'],
    probe: { urlPattern: '/galaxy/creator/home/personal_info', keyPaths: ['data.red_num'] },
  },
  {
    id: 'bilibili', name: 'B站',
    loginUrl: 'https://passport.bilibili.com/login',
    homeUrl: 'https://member.bilibili.com/platform/home',
    publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    loggedInUrlPatterns: ['member.bilibili.com/platform'],
    loginUrlPatterns: ['passport.bilibili.com'],
    probe: { urlPattern: '/x/passport-login/web/cookie/info', keyPaths: ['data.isLogin'] },
  },
  {
    id: 'douyin', name: '抖音',
    loginUrl: 'https://creator.douyin.com/',
    homeUrl: 'https://creator.douyin.com/creator-micro/home',
    publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    manageUrl: 'https://creator.douyin.com/creator-micro/content/manage',
    // 注意:登录页与后台 URL 前缀相同(/creator-micro),URL 判定不可靠,
    // 只用后台首页精确匹配;反证用"手机号输入框存在=登录页"
    loggedInUrlPatterns: ['creator.douyin.com/creator-micro/home'],
    loginUrlPatterns: ['creator.douyin.com/root', 'douyin.com/passport'],
    // 蚁小二 waitForLoginFinish 判据:风控 SDK 密钥落进 localStorage 即已登录;
    // 但登录页也会初始化该 SDK → 用"登录表单可见"反证(手机号输入框存在=未登录)
    probe: {
      localStorageKeys: ['s_sdk_crypt_sdk', 's_sdk_sign_data_key', 'web_protect'],
      blockedBySelectors: ['input[placeholder="请输入手机号"]', '#normal-input'],
    },
    publish: {
      videoInputSelector: '#joyride-wrapper input[type="file"]',
      titleInputSelector: 'input[placeholder="填写作品标题，为作品获得更多流量"]',
      descInputSelector: '.zone-container.editor-kit-container.editor',
      publishButtonTexts: ['发布', '发表', '发 布', '立即投稿'],
      confirmButtonTexts: ['确认发布', '确定', '知道了', '继续发布', '立即发布'],
      successTexts: ['发布成功', '已发布', '审核中', '作品已提交'],
      titleMaxLength: 29,
    },
    // 图文模式(蚁小二 imageTextStart:default-tab=3 + douyinImageRun 选择器)
    publishImageUrl: 'https://creator.douyin.com/creator-micro/content/upload?default-tab=3',
    publishImage: {
      imageInputSelector: '.semi-tabs-pane-motion-overlay input[accept="image/png,image/jpeg,image/jpg,image/bmp,image/webp,image/tif"][multiple]',
      titleInputSelector: '.semi-input-wrapper input[placeholder="添加作品标题"]',
      descInputSelector: '.editor.editor-comp-publish',
      publishButtonTexts: ['发布', '发表', '发 布'],
      confirmButtonTexts: ['确认发布', '确定', '知道了', '继续发布', '立即发布'],
      successTexts: ['发布成功', '已发布', '审核中', '作品已提交'],
      titleMaxLength: 30,
    },
  },
  {
    id: 'kuaishou', name: '快手',
    loginUrl: 'https://cp.kuaishou.com/profile',
    homeUrl: 'https://cp.kuaishou.com/profile',
    publishUrl: 'https://cp.kuaishou.com/article/publish/video',
    loggedInUrlPatterns: ['cp.kuaishou.com/profile'],
    loginUrlPatterns: ['passport.kuaishou.com'],
    probe: { urlPattern: 'creator/pc/home/userInfo', keyPaths: ['data.coreUserInfo'] },
  },
  {
    id: 'shipinhao', name: '视频号',
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    homeUrl: 'https://channels.weixin.qq.com/platform',
    publishUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loggedInUrlPatterns: ['channels.weixin.qq.com/platform'],
    loginUrlPatterns: ['channels.weixin.qq.com/login'],
    probe: { urlPattern: 'mmfinderassistant-bin/auth/auth_data', keyPaths: ['data.finderUser'] },
  },
  {
    id: 'gongzhonghao', name: '公众号',
    loginUrl: 'https://mp.weixin.qq.com/',
    homeUrl: 'https://mp.weixin.qq.com/cgi-bin/home',
    publishUrl: 'https://mp.weixin.qq.com/cgi-bin/appmsg',
    loggedInUrlPatterns: ['mp.weixin.qq.com/cgi-bin/home', 'mp.weixin.qq.com/cgi-bin/appmsg'],
    loginUrlPatterns: ['mp.weixin.qq.com/cgi-bin/loginpage'],
  },
  {
    id: 'weibo', name: '微博',
    loginUrl: 'https://passport.weibo.com/sso/signin',
    homeUrl: 'https://weibo.com/',
    publishUrl: 'https://weibo.com/upload/channel',
    loggedInUrlPatterns: ['weibo.com/upload', 'weibo.com/u/'],
    loginUrlPatterns: ['passport.weibo.com', 'weibo.com/login'],
  },
  {
    id: 'toutiao', name: '头条号',
    loginUrl: 'https://mp.toutiao.com/auth/page/login',
    homeUrl: 'https://mp.toutiao.com/profile_v4',
    publishUrl: 'https://mp.toutiao.com/profile_v4/xigua/upload-video',
    loggedInUrlPatterns: ['mp.toutiao.com/profile_v4'],
    loginUrlPatterns: ['mp.toutiao.com/auth'],
    probe: { urlPattern: 'agw/creator_center/user_info', keyPaths: ['data.user_id_str'] },
  },
  {
    id: 'baijiahao', name: '百家号',
    loginUrl: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
    homeUrl: 'https://baijiahao.baidu.com/builder/rc/home',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    loggedInUrlPatterns: ['baijiahao.baidu.com/builder/rc'],
    loginUrlPatterns: ['baijiahao.baidu.com/builder/theme/bjh/login'],
    probe: { urlPattern: 'builder/app/appinfo', keyPaths: ['data.user'] },
  },
  {
    id: 'zhihu', name: '知乎',
    loginUrl: 'https://www.zhihu.com/signin?next=%2Fcreator',
    homeUrl: 'https://www.zhihu.com/creator',
    publishUrl: 'https://zhihu.com/zvideo/upload-video',
    loggedInUrlPatterns: ['zhihu.com/creator'],
    loginUrlPatterns: ['zhihu.com/signin'],
    probe: { urlPattern: 'api/v4/me', keyPaths: ['uid', 'data.uid'] },
  },
]

export function findPlatform(id: string): PlatformDef | undefined {
  return PLATFORMS.find((platform) => platform.id === id)
}

/** 依据 URL 判定登录态:命中登录页特征 → 未登录;命中后台特征 → 已登录;否则未知。 */
export function detectLoginState(platform: PlatformDef, url: string): 'logged-in' | 'login-page' | 'unknown' {
  if (platform.loggedInUrlPatterns.some((pattern) => url.includes(pattern))) return 'logged-in'
  if (platform.loginUrlPatterns.some((pattern) => url.includes(pattern))) return 'login-page'
  return 'unknown'
}
