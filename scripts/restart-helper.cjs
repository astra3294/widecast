/**
 * 重启助手:taskkill 指定 PID 树 → 重新拉起 dsh --profile web。
 * 用法:node restart-helper.cjs <targetPid> <delayMs>
 */
const { exec, spawn } = require('child_process')

const targetPid = process.argv[2]
const delayMs = Number(process.argv[3] ?? 25000)

if (!targetPid) {
  console.error('usage: node restart-helper.cjs <targetPid> [delayMs]')
  process.exit(1)
}

setTimeout(() => {
  exec(`taskkill /PID ${targetPid} /T /F`, () => {
    setTimeout(() => {
      const p = spawn('dsh.cmd', ['--profile', 'web'], {
        detached: true,
        stdio: 'ignore',
        shell: true,
        windowsHide: true,
        env: process.env,
      })
      p.unref()
    }, 2500)
  })
}, delayMs)
