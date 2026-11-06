// Answers "is the Reader app actually running?" without being fooled by
// zombie process entries.
//
// Windows keeps a terminated process listed in tasklist while any other
// process still holds a handle to it. Such entries have 0 threads and 0
// handles, no executable path and no parent, but `tasklist` still prints
// them, which used to make automation believe the app was open. Only
// processes with live threads are real instances.
//
// Usage:
//   node scripts/app-status.cjs          # human readable, exit 0 = running, 1 = not
//   node scripts/app-status.cjs --json   # machine readable

const { execFileSync } = require('node:child_process')

const asJson = process.argv.includes('--json')

function listProcesses() {
  const script = [
    "$procs = Get-CimInstance Win32_Process -Filter \"Name='Reader.exe' OR Name='electron.exe'\" |",
    '  Select-Object ProcessId,Name,ThreadCount,HandleCount,ExecutablePath,CreationDate,CommandLine;',
    'if ($procs) { $procs | ConvertTo-Json -Compress } else { "[]" }'
  ].join('\n')
  const out = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
    { encoding: 'utf8', windowsHide: true }
  ).trim()
  if (!out) return []
  const parsed = JSON.parse(out)
  return Array.isArray(parsed) ? parsed : [parsed]
}

/** electron.exe only counts when it belongs to this repo's dev toolchain. */
function isThisRepoElectron(proc) {
  if (proc.Name !== 'electron.exe') return true
  const path = (proc.ExecutablePath || '').toLowerCase()
  return path.includes('\\node_modules\\electron\\dist\\electron.exe')
}

/** A zombie entry has no live threads and no executable path. */
function isLive(proc) {
  return Number(proc.ThreadCount) > 0 && Boolean(proc.ExecutablePath)
}

async function cdpResponds() {
  try {
    const response = await fetch('http://127.0.0.1:9222/json/list', {
      signal: AbortSignal.timeout(1000)
    })
    return response.ok
  } catch {
    return false
  }
}

async function main() {
  let all
  try {
    all = listProcesses().filter(isThisRepoElectron)
  } catch (error) {
    console.error(`无法读取进程列表：${error.message}`)
    process.exit(2)
  }

  const live = all.filter(isLive)
  const zombies = all.filter((proc) => !isLive(proc))
  const devPort = await cdpResponds()

  if (asJson) {
    console.log(
      JSON.stringify(
        {
          running: live.length > 0 || devPort,
          live: live.map((proc) => ({
            pid: proc.ProcessId,
            name: proc.Name,
            path: proc.ExecutablePath,
            threads: proc.ThreadCount,
            startedAt: proc.CreationDate
          })),
          devPort,
          ignoredZombies: zombies.map((proc) => proc.ProcessId)
        },
        null,
        2
      )
    )
  } else if (live.length > 0) {
    const mains = live.filter((proc) => !proc.CommandLine || !proc.CommandLine.includes('--type='))
    const children = live.length - mains.length
    const list = (mains.length > 0 ? mains : live)
      .map((proc) => `PID ${proc.ProcessId}（${proc.ExecutablePath}）`)
      .join('\n  ')
    console.log(
      `正在运行：\n  ${list}${children > 0 ? `\n  另有 ${children} 个 Electron 子进程` : ''}`
    )
  } else if (devPort) {
    console.log('正在运行：9222 调试端口有响应（开发实例），但未找到对应进程条目')
  } else {
    const ignored =
      zombies.length > 0
        ? `；已忽略 ${zombies.length} 个已退出的僵尸进程条目（PID ${zombies
            .map((proc) => proc.ProcessId)
            .join('、')}，0 线程 0 句柄）`
        : ''
    console.log(`未运行：没有存活的 Reader 进程${ignored}`)
  }

  process.exit(live.length > 0 || devPort ? 0 : 1)
}

main()
