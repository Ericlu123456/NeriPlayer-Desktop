import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import net from 'node:net'

const require = createRequire(import.meta.url)
const tauriCli = require.resolve('@tauri-apps/cli/tauri.js')
const DEFAULT_DEV_PORT = 1420
const args = process.argv.slice(2)
const environment = {
  ...process.env,
  NERI_BUILD_EPOCH: process.env.NERI_BUILD_EPOCH || Math.floor(Date.now() / 1000).toString(),
}

/** 能否在该地址上监听；地址族不可用（没有 IPv6）时返回 null */
function canListen(port, host) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', (error) => {
      resolve(error.code === 'EADDRNOTAVAIL' || error.code === 'EAFNOSUPPORT' ? null : false)
    })
    server.listen({ port, host }, () => server.close(() => resolve(true)))
  })
}

/** Vite 按 localhost 监听，可能落在 IPv4 或 IPv6 上，两边都空闲才算可用 */
async function isPortFree(port) {
  for (const host of ['127.0.0.1', '::1']) {
    if ((await canListen(port, host)) === false) return false
  }
  return true
}

async function findFreePort(start) {
  for (let port = start; port < start + 50; port++) {
    if (await isPortFree(port)) return port
  }
  throw new Error(`No free dev server port between ${start} and ${start + 49}`)
}

// 其它 Tauri 项目的开发服务器默认也占 1420：被占用时顺延到空闲端口，
// 端口经环境变量交给 Vite（beforeDevCommand 继承环境），devUrl 用 --config 覆盖成同一地址
if (args[0] === 'dev') {
  const requested = Number(process.env.NERI_DEV_PORT)
  const port = Number.isInteger(requested) && requested > 0 ? requested : await findFreePort(DEFAULT_DEV_PORT)
  if (port !== DEFAULT_DEV_PORT) {
    console.warn(`[run-tauri] Port ${DEFAULT_DEV_PORT} is in use by another program, using ${port} for the dev server.`)
  }
  environment.NERI_DEV_PORT = String(port)
  args.splice(1, 0, '--config', JSON.stringify({ build: { devUrl: `http://localhost:${port}` } }))
}

const child = spawn(process.execPath, [tauriCli, ...args], {
  env: environment,
  stdio: 'inherit',
})

child.on('error', (error) => {
  console.error(`Failed to start Tauri CLI: ${error.message}`)
  process.exitCode = 1
})

child.on('exit', (code) => {
  process.exitCode = code ?? 1
})
