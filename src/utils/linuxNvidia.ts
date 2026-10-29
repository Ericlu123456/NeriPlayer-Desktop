import { invoke } from '@tauri-apps/api/core'
import { detectPlatform } from '@/modules/shortcuts/platform'

/** 检测结果：`unknown` 表示探测本身失败，与“确认不是 NVIDIA”区分开喵 */
export type NvidiaDriverState = 'yes' | 'no' | 'unknown'

let cached: Promise<NvidiaDriverState> | null = null

/**
 * 是否加载了 NVIDIA 私有驱动。
 *
 * 用的是后端单独探测的 `nvidiaDriver` 字段，而不是 `nvidia`（后者表示兼容层是否生效）：
 * 用户设置 `NERI_DISABLE_NVIDIA_QUIRK=1` 跳过兼容层时，驱动依然是 NVIDIA，闪烁风险与
 * 提示逻辑都应照旧。结果只探测一次并缓存；探测失败返回 `unknown` 并清缓存，下次调用
 * 重试——调用方必须把 `unknown` 与 `no` 分开处理，别让一次 IPC 抖动变成“确认无风险”喵。
 *
 * Whether the proprietary NVIDIA driver is loaded, using the backend's dedicated
 * `nvidiaDriver` field rather than `nvidia` (which reports whether the workaround layer
 * ran): with `NERI_DISABLE_NVIDIA_QUIRK=1` the driver is still NVIDIA, so the flicker
 * risk and the notice logic must stay. Probed once and cached; a failed probe returns
 * `unknown` and clears the cache so the next call retries — callers must keep `unknown`
 * distinct from `no`, so one IPC hiccup cannot look like a confirmed "no risk".
 */
export function detectLinuxNvidia(): Promise<NvidiaDriverState> {
  if (detectPlatform() !== 'linux') return Promise.resolve('no')
  cached ??= invoke<{ nvidia?: boolean; nvidiaDriver?: boolean }>('get_linux_graphics_compat')
    .then(compat => {
      // 旧后端没有 nvidiaDriver 时退回 nvidia，宁可多提示也不要漏喵
      // Fall back to `nvidia` on an older backend: better to warn than to stay silent.
      const driver = compat?.nvidiaDriver ?? compat?.nvidia
      return driver === true ? 'yes' : 'no'
    })
    .catch(() => {
      cached = null
      return 'unknown' as const
    })
  return cached
}

/**
 * 认领“首次运行处理”的机会：第一次调用返回 `true`，之后（跨重启）都是 `false`。
 *
 * 由启动流程调用：第一次返回 `true` 时把动态背景默认关掉，之后用户可以在设置里手动
 * 打开，那时才弹提示。标记是应用数据目录里的空文件（`create_new`），所以不碰设置快照
 * 与同步信封。刻意不缓存结果：`create_new` 本身幂等，多一次 IPC 可以忽略，而缓存
 * 第一次的 `true` 会让后续判断失真。失败按“已处理过”处理，下次启动重试喵。
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
