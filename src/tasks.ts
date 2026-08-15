/**
 * 发布任务存储:任务状态逐步落盘(断点恢复基础),JSON 文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

export type TaskStatus = 'queued' | 'uploading' | 'publishing' | 'done' | 'failed'

export interface PublishInput {
  title: string
  description?: string
  videoPath?: string
  imagePaths?: string[]
  coverPath?: string
  tags?: string[]
}

export interface PublishTask {
  id: string
  platform: string
  input: PublishInput
  status: TaskStatus
  step: string
  message?: string
  createdAt: number
  updatedAt: number
}

export class TaskStore {
  private readonly file: string
  private tasks: PublishTask[] | null = null

  constructor(baseDir: string) {
    mkdirSync(baseDir, { recursive: true })
    this.file = join(baseDir, 'tasks.json')
  }

  create(platform: string, input: PublishInput): PublishTask {
    const task: PublishTask = {
      id: randomUUID(),
      platform,
      input,
      status: 'queued',
      step: 'created',
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    const tasks = this.load()
    tasks.unshift(task)
    this.save(tasks)
    return task
  }

  get(id: string): PublishTask | undefined {
    return this.load().find((task) => task.id === id)
  }

  list(): PublishTask[] {
    return [...this.load()]
  }

  /** 更新任务状态与步骤(自动落盘)。 */
  update(id: string, patch: Partial<Pick<PublishTask, 'status' | 'step' | 'message'>>): PublishTask | undefined {
    const tasks = this.load()
    const task = tasks.find((item) => item.id === id)
    if (task === undefined) return undefined
    Object.assign(task, patch, { updatedAt: Date.now() })
    this.save(tasks)
    return task
  }

  private load(): PublishTask[] {
    if (this.tasks !== null) return this.tasks
    if (!existsSync(this.file)) {
      this.tasks = []
      return this.tasks
    }
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8')) as unknown
      this.tasks = Array.isArray(parsed) ? (parsed as PublishTask[]) : []
    } catch {
      this.tasks = []
    }
    return this.tasks
  }

  private save(tasks: PublishTask[]): void {
    this.tasks = tasks
    const tmp = `${this.file}.tmp`
    writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8')
    try {
      writeFileSync(this.file, JSON.stringify(tasks, null, 2), 'utf8')
    } catch {
      try { rmSync(this.file, { force: true }) } catch { /* ignore */ }
      renameSync(tmp, this.file)
    }
  }
}
