// 系统级全局快捷键：窗口最小化 / 在托盘里也能控制播放
import { ref } from 'vue'
import { isTauri } from '@tauri-apps/api/core'
import { register, unregisterAll } from '@tauri-apps/plugin-global-shortcut'
import { createLogger } from '@/utils/logger'
import { effectiveShortcuts, toAccelerator, type ShortcutActionId, type ShortcutBindings } from './bindings'
import { runShortcutAction, type ShortcutActions } from './globalShortcuts'

const log = createLogger('shortcuts')

/// 注册失败（多半被其它程序占用）的动作，设置页据此逐项提示
export const systemShortcutFailures = ref<ShortcutActionId[]>([])

let generation = 0

export async function applySystemShortcuts(
  bindings: ShortcutBindings,
  enabled: boolean,
  actions: ShortcutActions,
): Promise<void> {
  if (!isTauri()) return
  const current = ++generation
  try {
    await unregisterAll()
  } catch (error) {
    log.warn('unregister global shortcuts failed:', error)
  }
  if (current !== generation) return
  if (!enabled) {
    systemShortcutFailures.value = []
    return
  }
  const failed: ShortcutActionId[] = []
  const taken = new Set<string>()
  for (const [id, combo] of Object.entries(effectiveShortcuts(bindings, 'global')) as [ShortcutActionId, string][]) {
    if (!combo) continue
    const accelerator = toAccelerator(combo)
    // 同一组合只注册给第一个动作，重复的在设置页已标成冲突
    if (!accelerator || taken.has(accelerator)) {
      if (!accelerator) failed.push(id)
      continue
    }
    taken.add(accelerator)
    try {
      await register(accelerator, (event) => {
        if (event.state === 'Pressed') runShortcutAction(id, actions)
      })
    } catch (error) {
      failed.push(id)
      log.warn(`global shortcut ${accelerator} unavailable:`, error)
    }
    if (current !== generation) return
  }
  systemShortcutFailures.value = failed
}

export async function clearSystemShortcuts(): Promise<void> {
  generation++
  if (!isTauri()) return
  await unregisterAll().catch(() => {})
}
