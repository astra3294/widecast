import { describe, expect, it } from 'vitest'
import { detectLoginState, findPlatform, hasCapability } from './platforms.js'

describe('平台能力目录', () => {
  it('抖音声明的视频、图文和结果验证能力', () => {
    const douyin = findPlatform('douyin')
    expect(douyin).toBeDefined()
    expect(hasCapability(douyin!, 'video')).toBe(true)
    expect(hasCapability(douyin!, 'imageText')).toBe(true)
    expect(hasCapability(douyin!, 'verify')).toBe(true)
    expect(douyin?.publish?.videoInputSelector).toContain('input')
    expect(douyin?.publishImage?.imageInputSelector).toContain('input')
  })

  it('未通过真实验收的平台不宣称支持发布', () => {
    const xiaohongshu = findPlatform('xiaohongshu')
    expect(xiaohongshu?.capabilities).toEqual(['login'])
    expect(hasCapability(xiaohongshu!, 'imageText')).toBe(false)
  })

  it('登录 URL 判定与未知状态区分', () => {
    const douyin = findPlatform('douyin')!
    expect(detectLoginState(douyin, 'https://creator.douyin.com/creator-micro/home')).toBe('logged-in')
    expect(detectLoginState(douyin, 'https://creator.douyin.com/root')).toBe('login-page')
    expect(detectLoginState(douyin, 'https://creator.douyin.com/other')).toBe('unknown')
  })
})
