/**
 * 重启后重发编排:延迟重启 Harness → 等宿主上线 → 启动 retry-observe.mjs 重发并观察。
 * 用法:node retry-after-restart.cjs <targetPid>
 */
const { exec, spawn } = require('child_process')

const targetPid = process.argv[2]

setTimeout(() => {
  exec(`taskkill /PID ${targetPid} /T /F`, () => {
    setTimeout(() => {
      const p = spawn('dsh.cmd', ['--profile', 'web'], {
        detached: true, stdio: 'ignore', shell: true, windowsHide: true, env: process.env,
      })
      p.unref()
    }, 2500)
    // 等宿主上线后跑重发观察(宿主就绪探测在 retry-observe 内部通过 RPC 轮询完成,
    // 这里给 20 秒启动窗口后拉起)
    setTimeout(() => {
      const r = spawn(process.execPath, ['scripts/retry-observe.mjs'], {
        cwd: __dirname, detached: true, stdio: 'ignore', windowsHide: true, env: process.env,
      })
      r.unref()
    }, 20000)
  })
}, 30000)
