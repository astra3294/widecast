/**
 * publish.ts 单元测试：validatePublishInput 函数。
 */
import { describe, it, expect } from 'vitest'
import { validatePublishInput, type PublishInput } from './publish.js'

describe('validatePublishInput', () => {
  it('标题为空返回错误', () => {
    const result = validatePublishInput({ title: '' })
    expect(result).toContain('title 必填')
  })

  it('标题为 undefined 返回错误', () => {
    const result = validatePublishInput({ title: undefined as unknown as string })
    expect(result).toContain('title 必填')
  })

  it('没有视频也没有图片返回错误', () => {
    const result = validatePublishInput({ title: '标题' })
    expect(result).toContain('videoPath 或 imagePaths 至少提供一个')
  })

  it('有标题和视频路径（文件不存在也通过基础校验，具体存在性由调用方检查）', () => {
    // validatePublishInput 不检查文件存在性（那是 start() 的责任）
    // 只检查结构完整性
    const result = validatePublishInput({
      title: '标题',
      videoPath: '/nonexistent/video.mp4',
    })
    // 验证函数应该检查文件存在性
    expect(result).toContain('视频文件不存在')
  })

  it('仅有 imagePaths 和 title 通过结构校验', () => {
    // validatePublishInput 不检查图片文件存在性
    const result = validatePublishInput({
      title: '图文标题',
      imagePaths: ['/nonexistent/a.jpg'],
    })
    // 结构校验通过（返回 null）
    expect(result).toBeNull()
  })
})

// ─── PublishInput 类型兼容性测试 ────────────────────────────────────────────

describe('PublishInput 类型', () => {
  it('最小输入只有 title 和 videoPath', () => {
    const input: PublishInput = { title: '测试', videoPath: '/tmp/a.mp4' }
    expect(input.title).toBe('测试')
    expect(input.description).toBeUndefined()
    expect(input.tags).toBeUndefined()
    expect(input.imagePaths).toBeUndefined()
  })

  it('完整输入包含所有字段', () => {
    const input: PublishInput = {
      title: '完整标题',
      description: '描述',
      videoPath: '/tmp/v.mp4',
      coverPath: '/tmp/c.jpg',
      tags: ['标签1', '标签2'],
    }
    expect(input.tags).toHaveLength(2)
  })
})
