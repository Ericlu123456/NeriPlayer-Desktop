import { invoke } from '@tauri-apps/api/core'
import { detectPlatform } from '@/modules/shortcuts/platform'

let cached: Promise<boolean> | null = null

/**
 * Linux + NVIDIA 私有驱动。
 *
 * 该组合下播放页的动态背景（WebGL 着色器）在切换页面时会间歇性闪烁，因此开启
 * 这个开关前要提示一次。结果来自后端 `get_linux_graphics_compat`，只探测一次并
 * 缓存；非 Linux、浏览器开发模式或旧后端一律当作“非 NVIDIA”，避免误报。
 *
 * Linux + the proprietary NVIDIA driver, where the player's WebGL shader background
 * flickers intermittently on page switches, so enabling it needs a one-time warning.
 * The backend answer is cached after the first call; non-Linux, browser dev mode and
 * older backends all resolve to false so nothing is ever reported by accident.
 */
export function isLinuxNvidia(): Promise<boolean> {
  if (detectPlatform() !== 'linux') return Promise.resolve(false)
  cached ??= invoke<{ nvidia: boolean }>('get_linux_graphics_compat')
    .then(compat => Boolean(compat?.nvidia))
    .catch(() => {
      // 探测失败不要粘住：清掉缓存，下次调用重试，否则一次 IPC 抖动会让本次运行
      // 永远不提示 / Do not cache a failed probe: clear it so a later call retries,
      // otherwise one IPC hiccup silences the warning for the whole page load.
      cached = null
      return false
    })
  return cached
}

/**
 * 认领“首次运行处理”的机会：第一次调用返回 `true`，之后（跨重启）都是 `false`。
 *
 * 由启动流程调用：第一次返回 `true` 时把动态背景默认关掉，之后用户可以在设置里手动
 * 打开，那时才弹提示。标记是应用数据目录里的空文件（`create_new`），所以不碰设置快照
 * 与同步信封。刻意不缓存结果：`create_new` 本身幂等，多一次 IPC 可以忽略，而缓存
 * 第一次的 `true` 会让后续判断失真。失败按“已处理过”处理，下次启动重试。
 *
 * Claim the one-and-only first-run handling: the first call returns `true`, later calls
 * (across restarts) return `false`. The startup path uses it to turn the dynamic
 * background off by default; the user can enable it later in Settings, where the
 * confirmation appears. The marker is an empty file in the app data directory created
 * with `create_new`, so the settings snapshot and its sync envelope stay untouched. The
 * result is deliberately not memoised: `create_new` is idempotent and one extra IPC is
 * negligible, whereas caching the first `true` would distort later answers. A failure
 * counts as "already handled" and is retried on the next start.
 */
export function claimFirstRunShaderNotice(): Promise<boolean> {
  return invoke<boolean>('claim_shader_flicker_notice').catch(() => false)
}
