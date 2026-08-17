/**
 * 直接调用 Widecast 核心模块的抖音发布测试。
 * 绕过 DSH 工具层，直接测试 PublishService。
 *
 * 用法: npx tsx scripts/publish-douyin-direct.ts [videoPath]
 *
 * 警告: 这会真正发布内容到抖音！
 */
import { WidecastService } from '../src/service.js'
import { TaskStore } from '../src/tasks.js'
import { PublishService } from '../src/publish.js'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const BASE_DIR = join(homedir(), '.widecast')

async function main(): Promise<void> {
  const videoPath = process.argv[2] ?? join(process.cwd(), 'test-fixtures', 'sample.mp4')

  console.log('=== Widecast 直接发布测试 ===')
  console.log(`视频: ${videoPath}`)
  console.log(`基础目录: ${BASE_DIR}`)
  console.log()

  if (!existsSync(videoPath)) {
    console.error(`视频文件不存在: ${videoPath}`)
    process.exit(1)
  }

  // 初始化 Widecast 核心模块
  const service = new WidecastService(BASE_DIR)
  const tasks = new TaskStore(BASE_DIR)
  const publishService = new PublishService(service.browser, tasks)

  // 检查登录态
  console.log('[1] 检查抖音登录态...')
  const loginResult = await service.checkPlatform('douyin')
  console.log(`  loggedIn: ${loginResult.loggedIn}`)
  if (loginResult.account) {
    console.log(`  account: ${loginResult.account.name} (${loginResult.account.status})`)
  }
  if (!loginResult.loggedIn) {
    console.error('❌ 抖音未登录，请先登录')
    await service.dispose()
    process.exit(1)
  }
  console.log('✅ 已登录')

  // 启动发布任务
  console.log('\n[2] 启动发布任务...')
  const result = publishService.start('douyin', {
    title: 'Widecast 测试视频 - 请忽略此作品',
    description: '这是 Widecast 自动化测试作品 #测试 #自动化',
    videoPath,
  })

  if (!result.ok) {
    console.error(`❌ 启动失败: ${result.message}`)
    await service.dispose()
    process.exit(1)
  }

  const task = result.task!
  console.log(`✅ 任务已创建: ${task.id}`)
  console.log(`  平台: ${task.platform}`)
  console.log(`  状态: ${task.status}`)
  console.log(`  幂等键: ${task.idempotencyKey}`)
  console.log(`  内容指纹: ${task.input.contentFingerprint}`)

  // 轮询任务状态
  console.log('\n[3] 等待任务完成...')
  let lastStep = ''
  for (let i = 0; i < 120; i++) {
    await new Promise((resolve) => setTimeout(resolve, 2000))
    const current = publishService.getTask(task.id)
    if (current === undefined) {
      console.log('  任务消失？')
      break
    }
    if (current.step !== lastStep) {
      console.log(`  [${current.status}] ${current.step}: ${current.message ?? ''}`)
      lastStep = current.step
    }
    if (current.status === 'done' || current.status === 'failed' ||
        current.status === 'needs_attention' || current.status === 'retryable_failed' ||
        current.status === 'terminal_failed' || current.status === 'cancelled') {
      console.log(`\n=== 任务结束 ===`)
      console.log(`  状态: ${current.status}`)
      console.log(`  步骤: ${current.step}`)
      console.log(`  消息: ${current.message ?? '(无)'}`)
      if (current.receipt) {
        console.log(`  凭证:`)
        console.log(`    证明等级: ${current.receipt.proofLevel}`)
        console.log(`    证据: ${current.receipt.evidence.join(', ')}`)
        console.log(`    作品ID: ${current.receipt.platformPublicationId ?? '(无)'}`)
        console.log(`    URL: ${current.receipt.url ?? '(无)'}`)
        console.log(`    原始响应: ${(current.receipt.rawResponse ?? '').slice(0, 300)}`)
      }
      break
    }
  }

  // 打印任务统计
  console.log('\n[4] 任务统计:')
  const stats = tasks.stats()
  console.log(`  总任务: ${stats.total}`)
  console.log(`  按状态: ${JSON.stringify(stats.byStatus)}`)
  console.log(`  按平台: ${JSON.stringify(stats.byPlatform)}`)

  // 清理
  await service.dispose()
  console.log('\n完成。')
}

main().catch((err) => {
  console.error('测试失败:', err)
  process.exit(1)
})
