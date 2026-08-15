/**
 * 平台目录:主流媒体平台的定义(登录页/创作者后台/发布页)。
 * URL 清单源自对蚁小二平台注册表的逆向提取(公开事实),适配器为本项目原创实现。
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
  /** 判定"已登录"的 URL 特征片段 */
  loggedInUrlPatterns: string[]
  /** 判定"在登录页"的 URL 特征片段 */
  loginUrlPatterns: string[]
}

export const PLATFORMS: readonly PlatformDef[] = [
  {
    id: 'xiaohongshu', name: '小红书',
    loginUrl: 'https://creator.xiaohongshu.com/login',
    homeUrl: 'https://creator.xiaohongshu.com/new/home',
    publishUrl: 'https://creator.xiaohongshu.com/publish/publish',
    loggedInUrlPatterns: ['creator.xiaohongshu.com/new', 'creator.xiaohongshu.com/publish'],
    loginUrlPatterns: ['creator.xiaohongshu.com/login', 'www.xiaohongshu.com'],
  },
  {
    id: 'bilibili', name: 'B站',
    loginUrl: 'https://passport.bilibili.com/login',
    homeUrl: 'https://member.bilibili.com/platform/home',
    publishUrl: 'https://member.bilibili.com/platform/upload/video/frame',
    loggedInUrlPatterns: ['member.bilibili.com/platform'],
    loginUrlPatterns: ['passport.bilibili.com'],
  },
  {
    id: 'douyin', name: '抖音',
    loginUrl: 'https://creator.douyin.com/',
    homeUrl: 'https://creator.douyin.com/creator-micro/home',
    publishUrl: 'https://creator.douyin.com/creator-micro/content/upload',
    loggedInUrlPatterns: ['creator.douyin.com/creator-micro'],
    loginUrlPatterns: ['creator.douyin.com/root', 'douyin.com/passport'],
  },
  {
    id: 'kuaishou', name: '快手',
    loginUrl: 'https://cp.kuaishou.com/profile',
    homeUrl: 'https://cp.kuaishou.com/profile',
    publishUrl: 'https://cp.kuaishou.com/article/publish/video',
    loggedInUrlPatterns: ['cp.kuaishou.com/profile'],
    loginUrlPatterns: ['passport.kuaishou.com'],
  },
  {
    id: 'shipinhao', name: '视频号',
    loginUrl: 'https://channels.weixin.qq.com/login.html',
    homeUrl: 'https://channels.weixin.qq.com/platform',
    publishUrl: 'https://channels.weixin.qq.com/platform/post/create',
    loggedInUrlPatterns: ['channels.weixin.qq.com/platform'],
    loginUrlPatterns: ['channels.weixin.qq.com/login'],
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
  },
  {
    id: 'baijiahao', name: '百家号',
    loginUrl: 'https://baijiahao.baidu.com/builder/theme/bjh/login',
    homeUrl: 'https://baijiahao.baidu.com/builder/rc/home',
    publishUrl: 'https://baijiahao.baidu.com/builder/rc/edit',
    loggedInUrlPatterns: ['baijiahao.baidu.com/builder/rc'],
    loginUrlPatterns: ['baijiahao.baidu.com/builder/theme/bjh/login'],
  },
  {
    id: 'zhihu', name: '知乎',
    loginUrl: 'https://www.zhihu.com/signin?next=%2Fcreator',
    homeUrl: 'https://www.zhihu.com/creator',
    publishUrl: 'https://zhihu.com/zvideo/upload-video',
    loggedInUrlPatterns: ['zhihu.com/creator'],
    loginUrlPatterns: ['zhihu.com/signin'],
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
