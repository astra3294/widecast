/**
 * 延迟执行:等待指定毫秒后在当前目录启动指定脚本。
 * 用法:node run-after.cjs <delayMs> <scriptName.mjs>
 */
const { spawn } = require('child_process')
const path = require('path')

const delayMs = Number(process.argv[2] ?? 30000)
const script = process.argv[3]

setTimeout(() => {
  const child = spawn(process.execPath, [path.join(__dirname, script)], {
    cwd: path.join(__dirname, '..'),
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    env: process.env,
  })
  child.unref()
}, delayMs)
